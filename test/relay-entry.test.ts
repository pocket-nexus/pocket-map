/** The shipped 3DS and PSP entries must be able to select relay: task 1151
 * B1 found that neither constructed a client, so the relay path was
 * unreachable from a device build. These tests drive the same factory both
 * entries call, over the same bounded host lane a device host provides. */
import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { readFileSync } from "node:fs";
import { RELAY_CHANNEL, createRelayChannel, relayChannelRxLimits, type RelayChannelOps } from "@pocketjs/framework/relay/channel";
import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import { RELAY_OP, RELAY_TYPE } from "@pocketjs/framework/relay/spec";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { resetFrameHooks } from "../runtime/framework/src/frame.ts";
import { MAP_RELAY, relayRxLimits, streamWindow, CATALOG_NS, namespaceFor } from "../shared/relay.ts";
import { providerCapabilities } from "../host/relay-host.ts";
import { createMapForHost, mapTransport } from "../app/transport.ts";

/** The device lane: complete records, `slots` deep, `windowBytes` wide. */
function lane() {
  const inbound: Uint8Array[] = [], outbound: Uint8Array[] = [];
  let session = 1;
  const ops: RelayChannelOps = {
    session: () => session,
    send(record) {
      if (session <= 0 || outbound.length >= RELAY_CHANNEL.slots) return false;
      outbound.push(record.slice());
      return true;
    },
    take(into) {
      const next = inbound[0];
      if (!next) return 0;
      if (next.length > into.length) { inbound.shift(); return into.length + 1; }
      inbound.shift(); into.set(next);
      return next.length;
    },
  };
  return { ops, inbound, outbound, detach() { session = 0; }, attach(n: number) { session = n; } };
}

const fakeOffload = { session: () => 0, submit: () => false, take: () => undefined };
function withOffload<T>(run: () => T): T {
  const g = globalThis as unknown as { offload?: unknown };
  const had = "offload" in g, previous = g.offload;
  g.offload = fakeOffload;
  try { return run(); } finally { if (had) g.offload = previous; else delete g.offload; }
}

test("a host without the relay lane keeps the offload transport", () => {
  const choice = mapTransport(undefined);
  expect(choice).toEqual({ transport: "offload" });
  expect(choice.relay).toBeUndefined();
});

test("a host with the relay lane constructs a client, sends its HELLO through the lane and follows the attachment generation", () => {
  const link = lane();
  const channel = createRelayChannel(link.ops, { id: "companion", grants: ["pocket-map"] });
  const choice = mapTransport(channel);
  expect(choice.transport).toBe("relay");
  expect(choice.relay).toBeDefined();
  // The client advertises what the lane can carry, not the desktop ceiling.
  const expected = relayRxLimits(relayChannelRxLimits());
  expect(expected.maxWireBytes).toBe(RELAY_CHANNEL.recordBytes);
  expect(expected.windowFrames).toBe(RELAY_CHANNEL.slots);
  expect(expected.maxObjectBytes).toBe(MAP_RELAY.rxLimits.maxObjectBytes);
  // Every stream the guest opens still gets a slice of that smaller window.
  const perStream = [CATALOG_NS, namespaceFor("0".repeat(16))].map(ns => streamWindow(expected, ns));
  const control = Math.max(1, Math.min(8, Math.floor(expected.windowFrames / 4)));
  expect(control + perStream[0].windowFrames + 2 * perStream[1].windowFrames).toBeLessThanOrEqual(expected.windowFrames);
  // The attachment is up, so the handshake left through the lane.
  expect(link.outbound.length).toBe(1);
  const hello = decodeFrame(link.outbound[0], { maxWireBytes: RELAY_CHANNEL.recordBytes });
  expect(hello.ok).toBe(true);
  if (hello.ok) {
    expect(hello.frame.type).toBe(RELAY_TYPE.REQUEST);
    expect(hello.frame.metadata.op).toBe("relay.hello");
    expect((hello.frame.metadata.rxLimits as { maxWireBytes: number }).maxWireBytes).toBe(RELAY_CHANNEL.recordBytes);
  }
  expect(link.outbound[0].length).toBeLessThanOrEqual(RELAY_CHANNEL.recordBytes);
  // A lost attachment ends the session; the next one starts a new handshake.
  link.detach();
  channel.step();
  expect(choice.relay!.connected()).toBe(false);
  expect(choice.relay!.phase).toBe("idle");
  link.attach(2);
  channel.step();
  expect(choice.relay!.phase).toBe("hello-sent");
  channel.close();
});

test("createMapForHost injects the constructed client into the model", () => {
  resetFrameHooks();
  const link = lane();
  const channel = createRelayChannel(link.ops, { id: "companion", grants: ["pocket-map"] });
  const choice = mapTransport(channel);
  withOffload(() => {
    createRoot(dispose => {
      const model = createMapForHost({ width: 400, height: 240 }, 40, choice);
      // createMap throws when the relay transport has no client, so a model
      // that reports "relay" is a model that received one.
      expect(model.transport).toBe("relay");
      expect(model.relay).toBe(choice.relay);
      expect(model.diagnostics().transport).toBe("relay");
      expect(model.diagnostics().relay?.phase).toBe(choice.relay!.phase);
      dispose();
    });
  });
  channel.close();
  resetFrameHooks();
});

test("both shipped entries mount the model through the transport factory", () => {
  for (const entry of ["app/ui.tsx", "app/psp.tsx"]) {
    const source = readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
    expect({ entry, factory: source.includes("createMapForHost(") }).toEqual({ entry, factory: true });
    // No entry may bypass the factory and hard-wire the offload default.
    expect({ entry, direct: /(?<![A-Za-z])createMap\(/.test(source) }).toEqual({ entry, direct: false });
  }
});

/** A lane with the peer behind it. `attach(n)` is what a host does when the
 * companion link is re-established: the old provider session ends, a new
 * endpoint answers, and `session()` moves to `n`. The device sees one
 * number change; it never sees the peer swap. */
function peerLane() {
  const toGuest: Uint8Array[] = [];
  const hellos: Uint8Array[] = [];
  let provider: RelayEndpoint | undefined, session = 0;
  const ops: RelayChannelOps = {
    session: () => session,
    send(record) {
      if (session <= 0 || record.length > RELAY_CHANNEL.recordBytes) return false;
      const copy = record.slice();
      const decoded = decodeFrame(copy, { maxWireBytes: RELAY_CHANNEL.recordBytes });
      if (decoded.ok && decoded.frame.type === RELAY_TYPE.REQUEST && decoded.frame.metadata.op === RELAY_OP.HELLO) hellos.push(copy);
      queueMicrotask(() => provider?.handleRecord(copy));
      return true;
    },
    take(into) {
      const next = toGuest[0];
      if (!next) return 0;
      if (next.length > into.length) { toGuest.shift(); return into.length + 1; }
      toGuest.shift(); into.set(next);
      return next.length;
    },
  };
  return {
    ops, hellos,
    get provider() { return provider!; },
    attach(generation: number) {
      provider?.handleDisconnect("lane: attachment replaced");
      toGuest.length = 0;
      provider = new RelayEndpoint({
        role: "provider", local: providerCapabilities(), pingIntervalMs: 1e9, stallMs: 1e9,
        transport: { peer: { id: "device-1", grants: [MAP_RELAY.app] }, trySend: bytes => { toGuest.push(bytes.slice()); return "accepted"; } },
      });
      session = generation;
    },
    detach() { provider?.handleDisconnect("lane: attachment lost"); session = 0; },
    close() { provider?.close(); },
  };
}

test("every attachment generation change discards the relay session and runs one handshake against the new peer", async () => {
  const link = peerLane();
  link.attach(1);
  const channel = createRelayChannel(link.ops, { id: "companion", grants: ["pocket-map"] });
  const choice = mapTransport(channel), relay = choice.relay!;
  const pump = async (frames: number) => { for (let i = 0; i < frames; i++) { channel.step(); for (let j = 0; j < 8; j++) await Promise.resolve(); } };
  const state = () => ({ guest: relay.phase, provider: link.provider.phase, sessions: relay.stats().sessions, hellos: link.hellos.length });
  try {
    await pump(8);
    expect(state()).toEqual({ guest: "ready", provider: "ready", sessions: 1, hellos: 1 });
    // The companion re-attaches between two frames: 1 -> 2 with no detached
    // frame in between. The old session is discarded and exactly one new
    // handshake reaches the new peer; a carried-over session would leave the
    // guest ready against a peer that has no record of it.
    link.attach(2);
    await pump(8);
    expect(state()).toEqual({ guest: "ready", provider: "ready", sessions: 2, hellos: 2 });
    expect(relay.stats().streams).toBe(0);
    expect(relay.stats().pending).toBe(0);
    // Idle frames add no session and no handshake.
    await pump(8);
    expect(state()).toEqual({ guest: "ready", provider: "ready", sessions: 2, hellos: 2 });
    // The generation that passes through zero costs the same one handshake.
    link.detach();
    await pump(1);
    expect(relay.connected()).toBe(false);
    expect(relay.phase).toBe("idle");
    link.attach(3);
    await pump(8);
    expect(state()).toEqual({ guest: "ready", provider: "ready", sessions: 3, hellos: 3 });
  } finally { relay.disconnect("test over"); channel.close(); link.close(); }
});
