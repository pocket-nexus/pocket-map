import { expect, test } from "bun:test";
import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import type { RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, RELAY_KIND, RELAY_OP, RELAY_TYPE, type RelayResourceRef } from "@pocketjs/framework/relay/spec";
import type { ResourceResult } from "@pocketjs/framework/resource-cache";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { MapRelayAuthority, classifyProviderError, providerCapabilities } from "../host/relay-host.ts";
import { MAP_RELAY, RENDITION, labelRef, markerRef, namespaceFor, parseMapRef, tileRef, utf8Decode } from "../shared/relay.ts";
import { holdableBackend, rasterService, vectorService } from "./relay-rig.ts";
import type { MapService } from "../host/service.ts";
import type { OffloadImage } from "@pocketjs/framework/offload/provider";

/** Two composed endpoints over a microtask-delivered link (the pattern of
 * runtime tests/relay-endpoint.test.ts) with the map authority behind the
 * provider; the guest calls resource.get directly. */
async function link(service: MapService) {
  const backend = holdableBackend(service);
  const authority = new MapRelayAuthority({ backend: () => backend });
  await authority.refresh();
  const frames: { from: "guest" | "provider"; bytes: Uint8Array }[] = [];
  let guest!: RelayEndpoint, provider!: RelayEndpoint;
  const route = (from: "guest" | "provider", raw: Uint8Array) => {
    const copy = raw.slice(); frames.push({ from, bytes: copy });
    queueMicrotask(() => (from === "guest" ? provider : guest).handleRecord(copy));
    return "accepted" as const;
  };
  const guestTransport: RelayTransportAdapter = { peer: { id: "companion", grants: ["pocket-map"] }, trySend: b => route("guest", b) };
  const providerTransport: RelayTransportAdapter = { peer: { id: "device-1", grants: ["pocket-map"] }, trySend: b => route("provider", b) };
  const connection = authority.connection(providerTransport.peer);
  provider = new RelayEndpoint({ role: "provider", transport: providerTransport, local: providerCapabilities(), hooks: connection.hooks, pingIntervalMs: 1e9, stallMs: 1e9 });
  connection.bind(provider);
  guest = new RelayEndpoint({ role: "guest", transport: guestTransport, local: { app: MAP_RELAY.app, ...providerCapabilities() }, requestReserve: MAP_RELAY.requestReserve, pingIntervalMs: 1e9, stallMs: 1e9 });
  const settle = async () => { for (let round = 0; round < 64; round++) { const before = frames.length; for (let i = 0; i < 16; i++) await Promise.resolve(); await new Promise<void>(r => setImmediate(r)); if (frames.length === before) break; } };
  const ready = guest.whenReady(); expect(guest.hello().ok).toBe(true); await settle(); await ready;
  const decoded = () => frames.map(f => { const r = decodeFrame(f.bytes, { maxWireBytes: 65536 }); if (!r.ok) throw new Error(r.code); return { from: f.from, bytes: f.bytes.length, ...r.frame }; });
  const get = (stream: number, ref: RelayResourceRef, args: { accept: number[]; maxObjectBytes: number; ifRevision?: string }) =>
    new Promise<ResourceResult<unknown>>(resolve => { const started = guest.get(stream, ref, args, resolve); if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } }); });
  const open = async (ns: string) => { const opened = await guest.open({ app: MAP_RELAY.app, namespace: ns, profile: { ...MAP_RELAY.profile } }); await settle(); return opened.stream; };
  return { authority, backend, guest, provider, frames, decoded, settle, get, open, connection, close() { guest.close(); provider.close(); } };
}
const object = (r: ResourceResult<unknown>) => { if (!r.ok || !("value" in r)) throw new Error(`not an object: ${JSON.stringify(r)}`); return r.value as { ref: RelayResourceRef; codec: number; data: Uint8Array; value?: Record<string, unknown> }; };

test("authority serves raster tiles, labels and markers as chunked resources with the source revision; ifRevision confirms without provider work", async () => {
  const service = rasterService();
  const l = await link(service);
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const ns = namespaceFor(info.source);
    expect(l.authority.sourceList().map(s => [s.kind, s.ns, s.revision])).toEqual([["osm", ns, info.revision]]);
    expect(info.revision).toMatch(/^[a-f0-9]{16}$/); expect(info.revision).not.toBe(info.source);
    const stream = await l.open(ns);
    const input = { source: info.source, z: 14, x: 2621, y: 6332 };
    const expected = await service.methods()["map.tile"](JSON.stringify(input)) as OffloadImage;
    const calls = l.backend.calls();
    const got = object(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }));
    await l.settle();
    expect(got.ref).toEqual({ ...tileRef(input, RENDITION.raster), revision: info.revision });
    expect(got.codec).toBe(RELAY_CODEC.R5G6B5LE); expect(got.value).toEqual({ width: 256, height: 256 });
    expect(got.data.length).toBe(131072); expect(Buffer.compare(Buffer.from(got.data), Buffer.from(expected.pixels))).toBe(0);
    const chunks = l.decoded().filter(f => f.from === "provider" && f.stream === stream && f.type === RELAY_TYPE.RESPONSE);
    expect(chunks.length).toBe(3); expect(chunks.every(c => c.bytes <= 65536)).toBe(true);
    expect(chunks.map(c => c.metadata.final)).toEqual([false, false, true]);
    expect(l.backend.calls() - calls).toBe(1);
    // Conditional get for the held revision: notModified, no capability call.
    const before = l.backend.calls();
    expect(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: info.revision })).toEqual({ ok: true, value: { notModified: true, revision: info.revision } });
    expect(l.backend.calls()).toBe(before);
    expect(l.authority.stats.notModified).toBe(1);
    // A stale revision is answered with the object again.
    const again = object(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: "older" }));
    expect(again.ref.revision).toBe(info.revision); expect(again.data.length).toBe(131072);
    // Labels are 256x32 textures keyed by their JSON text pair.
    const label = object(await l.get(stream, labelRef(info.source, { name: "Union Square", detail: "San Francisco" }), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 16384 }));
    expect(label.value).toEqual({ width: 256, height: 32 }); expect(label.data.length).toBe(16384);
    const rendered = service.methods()["map.label"](JSON.stringify({ name: "Union Square", detail: "San Francisco" })) as OffloadImage;
    expect(Buffer.compare(Buffer.from(label.data), Buffer.from(rendered.pixels))).toBe(0);
    // Markers on a raster source are an empty JSON window.
    const markers = object(await l.get(stream, markerRef({ ...input, layer: "all" }), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 8192 }));
    expect(markers.codec).toBe(RELAY_CODEC.JSON); expect(JSON.parse(utf8Decode(markers.data))).toEqual([]);
    // Refusals carry stable codes: an unknown namespace, an address outside the profile, a non-accepted codec.
    expect(await l.get(stream, { ...tileRef(input, RENDITION.raster), ns: namespaceFor("0123456789abcdef") }, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.NOT_FOUND } });
    expect(await l.get(stream, { ...tileRef(input, RENDITION.raster), key: "z14/x1/y1" }, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID } });
    expect(await l.get(stream, tileRef({ ...input, x: -1 }, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID } });
    expect(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 131072 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNSUPPORTED } });
    expect(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 65536 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.TOO_LARGE } });
    // OPEN refusals: another app, an unknown namespace.
    await expect(l.guest.open({ app: "pocket-term", namespace: ns, profile: { ...MAP_RELAY.profile } })).rejects.toBe(RELAY_ERROR.UNAUTHORIZED);
    await expect(l.guest.open({ app: MAP_RELAY.app, namespace: namespaceFor("0123456789abcdef"), profile: { ...MAP_RELAY.profile } })).rejects.toBe(RELAY_ERROR.NOT_FOUND);
    expect(l.guest.protocolErrors + l.provider.protocolErrors).toBe(0);
  } finally { l.close(); service.close(); }
});

test("authority serves PMH1 meshes and vector marker windows byte-identical to the offload methods", async () => {
  const service = vectorService();
  const l = await link(service);
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const stream = await l.open(namespaceFor(info.source));
    const input = { source: info.source, z: 14, x: 2621, y: 6332 };
    const mesh = object(await l.get(stream, tileRef(input, RENDITION.mesh), { accept: [RELAY_CODEC.PMH1], maxObjectBytes: 36880 }));
    const expected = await service.methods()["map.mesh"](JSON.stringify(input)) as { bytes: Uint8Array };
    expect(mesh.codec).toBe(RELAY_CODEC.PMH1); expect(Buffer.compare(Buffer.from(mesh.data), Buffer.from(expected.bytes))).toBe(0);
    expect(mesh.value).toMatchObject({ width: 256, height: 256, bytes: expected.bytes.length });
    const rows = object(await l.get(stream, markerRef({ ...input, z: 15, x: 5242, y: 12664, layer: "all" }), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 8192 }));
    const direct = JSON.parse(await service.methods()["map.markers"](JSON.stringify({ ...input, z: 15, x: 5242, y: 12664, layer: "all" })) as string);
    expect(JSON.parse(utf8Decode(rows.data))).toEqual(direct); expect(direct.length).toBeGreaterThan(0);
    expect(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  } finally { l.close(); service.close(); }
});

test("CANCEL before the provider answered yields one CANCELLED/none terminal and no object bytes", async () => {
  const service = rasterService();
  const l = await link(service);
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const stream = await l.open(namespaceFor(info.source));
    const input = { source: info.source, z: 14, x: 2621, y: 6332 };
    l.backend.hold(true);
    const outcomes: ResourceResult<unknown>[] = [];
    const started = l.guest.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, r => outcomes.push(r));
    if (!("correlation" in started)) throw new Error("get refused");
    await l.settle();
    l.guest.cancel(started.correlation, "scrolled out");
    await l.settle();
    expect(l.authority.stats.cancelRequests).toBe(1);
    expect(l.backend.releaseHeld()).toBe(1);
    await l.settle();
    expect(outcomes).toEqual([{ ok: false, error: { code: RELAY_ERROR.CANCELLED, message: "cancelled" } }]);
    const terminal = l.decoded().filter(f => f.from === "provider" && f.stream === stream && f.type === RELAY_TYPE.RESPONSE);
    expect(terminal.length).toBe(1); expect(terminal[0].metadata.effect).toBe(RELAY_EFFECT.NONE); expect(terminal[0].data.length).toBe(0);
    expect(l.authority.stats.cancelled).toBe(1); expect(l.authority.stats.objects).toBe(0);
    expect(l.guest.inspect()!.requests.active).toBe(0); expect(l.provider.inspect()!.requests.active).toBe(0);
    // The same address afterwards is served normally.
    l.backend.hold(false);
    expect(object(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 })).data.length).toBe(131072);
  } finally { l.close(); service.close(); }
});

test("a reloaded source revision is announced with one namespace-scope INVALIDATE per bound stream; an unchanged reload announces nothing", async () => {
  const service = rasterService("1");
  const l = await link(service);
  const later = rasterService("2");
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const ns = namespaceFor(info.source);
    const stream = await l.open(ns);
    expect((await l.authority.refresh()).changed).toEqual([]);
    await l.settle();
    expect(l.decoded().filter(f => f.type === RELAY_TYPE.INVALIDATE).length).toBe(0);
    // Same source (URL + rendition), moved revision (epoch): one INVALIDATE on the stream bound to the namespace.
    (l.backend as { call: unknown }).call = holdableBackend(later).call;
    const result = await l.authority.refresh();
    await l.settle();
    expect(result.changed).toEqual([ns]);
    expect(result.sources[0].revision).not.toBe(info.revision);
    const invalidates = l.decoded().filter(f => f.type === RELAY_TYPE.INVALIDATE);
    expect(invalidates.map(f => [f.from, f.stream, f.correlation, f.metadata.op, (f.metadata.args as { scope: string; namespace: string }).scope, (f.metadata.args as { namespace: string }).namespace]))
      .toEqual([["provider", stream, 0, RELAY_OP.RESOURCE_INVALIDATE, "namespace", ns]]);
    expect(l.authority.stats.invalidates).toBe(1);
    // The guest's resource client moved the namespace generation: a later get is stamped with the new revision.
    const got = object(await l.get(stream, tileRef({ source: info.source, z: 14, x: 2621, y: 6332 }, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: info.revision }));
    expect(got.ref.revision).toBe(result.sources[0].revision);
  } finally { l.close(); service.close(); later.close(); }
});

test("the L2 fence: a reply generated after the revision moved (stamped with the old revision) is dropped RESYNC_REQUIRED, never published", async () => {
  const service = rasterService("1");
  const l = await link(service);
  const later = rasterService("2");
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const ns = namespaceFor(info.source);
    const stream = await l.open(ns);
    const input = { source: info.source, z: 14, x: 2621, y: 6332 };
    // The get is at the authority (capability call in progress) when the source is reloaded.
    l.backend.hold(true);
    const outcomes: ResourceResult<unknown>[] = [];
    const started = l.guest.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, r => outcomes.push(r));
    if (!("correlation" in started)) throw new Error("get refused");
    await l.settle();
    (l.backend as { call: unknown }).call = holdableBackend(later).call;
    expect((await l.authority.refresh()).changed).toEqual([ns]);
    await l.settle();
    // The old worker's reply drains: chunks stamped with the old revision, after the INVALIDATE on the same stream.
    expect(l.backend.releaseHeld()).toBe(1);
    await l.settle();
    expect(outcomes).toEqual([{ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } }]);
    const chunks = l.decoded().filter(f => f.from === "provider" && f.stream === stream && f.type === RELAY_TYPE.RESPONSE);
    expect(chunks.length).toBe(3);
    expect((chunks[0].metadata.resource as RelayResourceRef).revision).toBe(info.revision);
    expect(l.guest.inspect()!.client!.localEntry(tileRef(input, RENDITION.raster))).toBeUndefined();
    expect(l.guest.inspect()!.requests.active).toBe(0); expect(l.guest.inspect()!.assembler!.stats().assemblies).toBe(0);
    // The next get publishes the new revision's pixels.
    const fresh = object(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }));
    expect(fresh.ref.revision).toBe(l.authority.sourceList()[0].revision);
    const expected = await later.methods()["map.tile"](JSON.stringify(input)) as OffloadImage;
    expect(Buffer.compare(Buffer.from(fresh.data), Buffer.from(expected.pixels))).toBe(0);
  } finally { l.close(); service.close(); later.close(); }
});

test("resource identity helpers and provider error classification", () => {
  const input = { source: "0123456789abcdef", z: 3, x: 5, y: 2 };
  expect(tileRef(input, RENDITION.raster)).toEqual({ kind: RELAY_KIND.TILE, ns: "map/0123456789abcdef", key: "3/5/2", rendition: "r5g6b5-v1" });
  expect(parseMapRef(tileRef(input, RENDITION.raster), input.source)).toEqual({ method: "map.tile", payload: JSON.stringify(input), response: "image" });
  expect(parseMapRef(tileRef(input, RENDITION.mesh), input.source)).toEqual({ method: "map.mesh", payload: JSON.stringify(input), response: "mesh" });
  expect(parseMapRef(markerRef({ ...input, layer: "travel" }), input.source)).toEqual({ method: "map.markers", payload: JSON.stringify({ ...input, layer: "travel" }) });
  expect(parseMapRef(labelRef(input.source, { name: "a/b", detail: "c" }), input.source)).toEqual({ method: "map.label", payload: JSON.stringify({ name: "a/b", detail: "c" }), response: "image" });
  expect(parseMapRef({ ...tileRef(input, RENDITION.raster), rendition: "markers-everything-v1" }, input.source)).toBeUndefined();
  expect(parseMapRef({ ...tileRef(input, RENDITION.raster), key: "3/5/2/1" }, input.source)).toBeUndefined();
  expect(parseMapRef({ kind: RELAY_KIND.TEXTURE, ns: "map/x", key: "not json", rendition: RENDITION.label }, input.source)).toBeUndefined();
  expect(() => labelRef(input.source, { name: "語".repeat(80), detail: "語".repeat(20) })).toThrow("key bound");
  expect(classifyProviderError("Tile decode budget exhausted")).toBe(RELAY_ERROR.BUSY);
  expect(classifyProviderError("Invalid tile address or source")).toBe(RELAY_ERROR.INVALID);
  expect(classifyProviderError("Missing installed atlas tile")).toBe(RELAY_ERROR.NOT_FOUND);
  expect(classifyProviderError("Capability not granted")).toBe(RELAY_ERROR.UNSUPPORTED);
  expect(classifyProviderError("Map service returned HTTP 503")).toBe(RELAY_ERROR.DEADLINE);
});
