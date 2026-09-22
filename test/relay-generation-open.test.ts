import { expect, test } from "bun:test";
import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import { createRelayChannel, type RelayChannelOps } from "@pocketjs/framework/relay/channel";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { RELAY_CODEC, RELAY_ERROR, RELAY_KIND, RELAY_OP } from "@pocketjs/framework/relay/spec";
import type { ResourceResult } from "@pocketjs/framework/resource-cache";
import type { RelayObject } from "../app/relay.ts";
import { mapTransport } from "../app/transport.ts";
import { providerCapabilities } from "../host/relay-host.ts";

const ref = { kind: RELAY_KIND.EVENT, ns: "map/305f2b6a251eefcd", key: "pending-open", rendition: "test-v1" };
const args = { accept: [RELAY_CODEC.JSON], maxObjectBytes: 1024 };
const microtasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const opOf = (bytes: Uint8Array) => { const decoded = decodeFrame(bytes); return decoded.ok ? decoded.frame.metadata.op : undefined; };

// The real entry/channel attachment path, with the peer's replies held
// until the next frame. A positive generation edge replaces the provider
// and drops the old L0 queue just as task 1212's counterexample does.
function pendingLane(refusal?: string) {
  let generation = 1, provider!: RelayEndpoint;
  const inbound: Uint8Array[] = [];
  const sent: Uint8Array[] = [];
  const received: number[] = [];
  const makePeer = () => new RelayEndpoint({
    role: "provider", local: providerCapabilities(), pingIntervalMs: 1e9, stallMs: 1e9,
    transport: { peer: { id: "test-device", grants: ["pocket-map"] }, trySend(bytes) { inbound.push(bytes.slice()); return "accepted"; } },
    hooks: {
      authorizeOpen: () => refusal ?? null,
      onGet(request) {
        received.push(generation);
        provider.replyObject(request, { ref: { ...ref, revision: "1234567890abcdef" }, codec: RELAY_CODEC.JSON, data: new TextEncoder().encode('{"ok":true}') });
      },
    },
  });
  provider = makePeer();
  const ops: RelayChannelOps = {
    session: () => generation,
    send(bytes) {
      const copy = bytes.slice(), destination = provider;
      sent.push(copy);
      queueMicrotask(() => destination.handleRecord(copy));
      return true;
    },
    take(into) { const next = inbound.shift(); if (!next) return 0; into.set(next); return next.length; },
  };
  const channel = createRelayChannel(ops, { id: "test-companion", grants: ["pocket-map"] });
  const relay = mapTransport(channel).relay!;
  const pump = async (frames: number) => { for (let i = 0; i < frames; i++) { channel.step(); await microtasks(); } };
  return {
    relay, channel, inbound, received, pump,
    state: () => ({ guest: relay.phase, provider: provider.phase, sessions: relay.stats().sessions, hellos: sent.filter(bytes => opOf(bytes) === RELAY_OP.HELLO).length }),
    replace() { provider.close(); inbound.length = 0; generation++; provider = makePeer(); },
    close() { relay.disconnect("test done"); channel.close(); provider.close(); },
  };
}

for (const boundary of ["OPEN pending", "OPEN resolved before callback", "SUBSCRIBE pending"] as const) {
  test(`old generation callbacks cannot refuse or bind a namespace after replacement: ${boundary}`, async () => {
    const lane = pendingLane();
    const { relay } = lane;
    try {
      await lane.pump(10);
      expect(lane.state()).toEqual({ guest: "ready", provider: "ready", sessions: 1, hellos: 1 });
      expect(relay.get(ref, args, () => { throw new Error("GET was never admitted"); })).toBe(false);
      await microtasks();
      expect(lane.inbound.filter(bytes => opOf(bytes) === RELAY_OP.OPEN).length).toBe(1);
      if (boundary !== "OPEN pending") {
        // Consume the old OPEN response, but do not give its Promise
        // callback a turn unless this scenario parks at SUBSCRIBE.
        lane.channel.step();
        if (boundary === "SUBSCRIBE pending") {
          await microtasks();
          expect(lane.inbound.filter(bytes => opOf(bytes) === RELAY_OP.RESOURCE_SUBSCRIBE).length).toBe(1);
        }
      }
      lane.replace();
      // Synchronously observe the edge before old callbacks get a turn.
      lane.channel.step();
      await lane.pump(10);
      expect(lane.state()).toEqual({ guest: "ready", provider: "ready", sessions: 2, hellos: 2 });
      let done: ResourceResult<RelayObject> | undefined;
      let active = false;
      for (let i = 0; i < 30 && !done; i++) {
        if (!active) active = relay.get(ref, args, result => { done = result; }) !== false;
        await lane.pump(1);
      }
      expect(done?.ok).toBe(true);
      if (done?.ok && "value" in done) expect(new TextDecoder().decode(done.value.data)).toBe('{"ok":true}');
      expect(lane.received).toEqual([2]);
      expect(relay.stats().opens).toBe(2);
      expect(relay.stats().pending).toBe(0);
      expect(relay.stats().streams).toBe(1);
      expect(relay.stats().bindRefusals).toEqual({});
      expect(relay.stats().protocolErrors).toBe(0);
      console.log(`RECEIPT generation-open ${JSON.stringify({ boundary, state: lane.state(), stats: relay.stats(), received: lane.received })}`);
    } finally { lane.close(); }
  });
}

test("a current generation OPEN refusal stays terminal and does not retry every frame", async () => {
  const lane = pendingLane(RELAY_ERROR.UNAUTHORIZED);
  try {
    await lane.pump(10);
    expect(lane.relay.get(ref, args, () => {})).toBe(false);
    await lane.pump(10);
    for (let i = 0; i < 10; i++) {
      expect(() => lane.relay.get(ref, args, () => {})).toThrow("Relay namespace refused: UNAUTHORIZED");
      await lane.pump(1);
    }
    expect(lane.relay.stats().opens).toBe(1);
    expect(lane.relay.stats().bindRefusals).toEqual({ [RELAY_ERROR.UNAUTHORIZED]: 1 });
    expect(lane.received).toEqual([]);
  } finally { lane.close(); }
});

for (const settle of [false, true]) {
  test(`a delayed old OPEN ${settle ? "success" : "rejection"} cannot erase the replacement generation's pending bind`, async () => {
    const lane = pendingLane();
    const { relay } = lane;
    // Hold only the first completion after it passed the real endpoint.
    // Deliver it once the new READY has begun an OPEN for the same ns.
    const open = relay.endpoint.open.bind(relay.endpoint);
    let held = false, release: (() => void) | undefined;
    relay.endpoint.open = request => {
      const pending = open(request);
      if (held) return pending;
      held = true;
      return new Promise((resolve, reject) => {
        pending.then(result => { release = () => resolve(result); }, error => { release = () => reject(error); });
      });
    };
    try {
      await lane.pump(10);
      expect(relay.get(ref, args, () => {})).toBe(false);
      await microtasks();
      if (settle) await lane.pump(10);
      lane.replace(); lane.channel.step();
      await lane.pump(10);
      expect(lane.state()).toEqual({ guest: "ready", provider: "ready", sessions: 2, hellos: 2 });
      expect(release).toBeDefined();
      expect(relay.get(ref, args, () => {})).toBe(false);
      await microtasks();
      expect(lane.inbound.filter(bytes => opOf(bytes) === RELAY_OP.OPEN).length).toBe(1);
      release!();
      await microtasks();
      // The new OPEN is still in flight. An old callback that deletes the
      // marker would make this call send a duplicate OPEN (or throw).
      expect(relay.get(ref, args, () => {})).toBe(false);
      expect(relay.stats().opens).toBe(2);
      await lane.pump(10);
      let done: ResourceResult<RelayObject> | undefined;
      expect(relay.get(ref, args, result => { done = result; })).not.toBe(false);
      await lane.pump(10);
      expect(done?.ok).toBe(true);
      expect(lane.received).toEqual([2]);
      expect(relay.stats().streams).toBe(1);
      expect(relay.stats().pending).toBe(0);
      expect(relay.stats().bindRefusals).toEqual({});
    } finally { lane.close(); }
  });
}
