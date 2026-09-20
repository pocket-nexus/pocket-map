import { expect, test } from "bun:test";
import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import type { RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { RELAY_CODEC, RELAY_DELIVERY, RELAY_EFFECT, RELAY_ERROR, RELAY_KIND, RELAY_OP, RELAY_TYPE, type RelayResourceRef } from "@pocketjs/framework/relay/spec";
import type { ResourceResult } from "@pocketjs/framework/resource-cache";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { MapRelayAuthority, dispatchMapCapability, providerCapabilities } from "../host/relay-host.ts";
import { CATALOG_NS, MAP_RELAY, OBJECT_BYTES, RENDITION, catalogRef, jsonDecodeStrict, labelRef, markerRef, namespaceFor, parseMapRef, searchRef, tileRef, utf8DecodeStrict, utf8Encode } from "../shared/relay.ts";
import { MapFailure, busy, failureCode, invalid, notFound } from "../shared/failure.ts";
import { drainMicrotasks, holdableBackend, rasterService, vectorService } from "./relay-rig.ts";
import type { MapService } from "../host/service.ts";
import { defaultConfig } from "../host/config.ts";
import { SAVED_PLACES_ONLY } from "../host/capability.ts";
import type { BackendReply } from "../host/capability.ts";
import type { OffloadImage } from "@pocketjs/framework/offload/provider";

/** Two composed endpoints over an explicitly pumped link with the map
 * authority behind the provider; the guest calls resource.get directly.
 *
 * Determinism (task 1151 B6): `settle()` returns when a round produced no
 * frame *and* the backend reports no outstanding capability call. Awaiting
 * the backend's own barrier is what replaces the old guess — one
 * setImmediate with no new frame — which raced a capability that had not
 * finished decoding yet. Record delivery stays on the microtask queue,
 * which one `await` drains to completion, so no step depends on a timer or
 * on how many scheduler hops a decode happens to take. */
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
  const settle = async () => {
    for (let round = 0; round < 64; round++) {
      const before = frames.length;
      if (backend.outstanding() > 0) await backend.whenIdle();
      await drainMicrotasks(4);
      if (frames.length === before && backend.outstanding() === 0) return;
    }
    throw new Error("link: the session did not quiesce");
  };
  const ready = guest.whenReady(); expect(guest.hello().ok).toBe(true); await settle(); await ready;
  const decoded = () => frames.map(f => { const r = decodeFrame(f.bytes, { maxWireBytes: 65536 }); if (!r.ok) throw new Error(r.code); return { from: f.from, bytes: f.bytes.length, ...r.frame }; });
  const get = (stream: number, ref: RelayResourceRef, args: { accept: number[]; maxObjectBytes: number; ifRevision?: string }) =>
    new Promise<ResourceResult<unknown>>(resolve => { const started = guest.get(stream, ref, args, resolve); if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } }); });
  const open = async (ns: string) => { const opened = await guest.open({ app: MAP_RELAY.app, namespace: ns, profile: { ...MAP_RELAY.profile } }); await settle(); return opened.stream; };
  /** Open the namespace and establish the latest-snapshot subscription the
   * authority delivers PUSH/INVALIDATE on (§3.6). */
  const bind = async (ns: string, onPush?: (ref: RelayResourceRef, data: Uint8Array) => void) => {
    const stream = await open(ns);
    const subscription = await new Promise<number>((resolve, reject) => {
      const started = guest.subscribe(stream, { ns }, RELAY_DELIVERY.LATEST_SNAPSHOT,
        { onObject: object => onPush?.(object.ref, object.data) },
        result => (result.ok && "value" in result && typeof result.value.subscription === "number" ? resolve(result.value.subscription) : reject(new Error("subscribe refused"))),
        { maxObjectBytes: OBJECT_BYTES.catalog });
      if (!("correlation" in started)) reject(new Error(started.code));
    });
    await settle();
    return { stream, subscription };
  };
  return { authority, backend, guest, provider, frames, decoded, settle, get, open, bind, connection, close() { guest.close(); provider.close(); } };
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
    expect(markers.codec).toBe(RELAY_CODEC.JSON); expect(jsonDecodeStrict(markers.data)).toEqual([]);
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

test("authority serves PMH1 meshes, vector marker windows and place searches byte-identical to the offload methods", async () => {
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
    expect(jsonDecodeStrict(rows.data)).toEqual(direct); expect(direct.length).toBeGreaterThan(0);
    // Place search: kind 8 (a query-scoped state snapshot), the canonical
    // query tuple as key, the same rows map.search answers over offload.
    const query = { query: "tokyo", source: info.source as string, lat: 35.7, lon: 139.8 };
    const places = object(await l.get(stream, searchRef(query), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 8192 }));
    const offloadRows = JSON.parse(await service.methods()["map.search"](JSON.stringify(query)) as string);
    expect(places.ref.kind).toBe(RELAY_KIND.EVENT);
    expect(jsonDecodeStrict(places.data)).toEqual(offloadRows);
    expect((offloadRows as unknown[]).length).toBeGreaterThan(0);
    // A raster get against a vector source is a shape the profile does not
    // offer here: UNSUPPORTED, declared by the provider, not guessed.
    expect(await l.get(stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNSUPPORTED } });
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

test("a reloaded source revision reaches subscribed streams only: one namespace INVALIDATE per subscription, nothing for a stream that only opened", async () => {
  const service = rasterService("1");
  const l = await link(service);
  const later = rasterService("2");
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const ns = namespaceFor(info.source);
    const bound = await l.bind(ns);
    expect((await l.authority.refresh()).changed).toEqual([]);
    await l.settle();
    expect(l.decoded().filter(f => f.type === RELAY_TYPE.INVALIDATE).length).toBe(0);
    // Same source (URL + rendition), moved revision (epoch): one INVALIDATE on the subscribed stream.
    l.backend.swap(later);
    const result = await l.authority.refresh();
    await l.settle();
    expect(result.changed).toEqual([ns]);
    expect(result.sources[0].revision).not.toBe(info.revision);
    const invalidates = l.decoded().filter(f => f.type === RELAY_TYPE.INVALIDATE);
    expect(invalidates.map(f => [f.from, f.stream, f.correlation, f.metadata.op, (f.metadata.args as { scope: string }).scope, (f.metadata.args as { namespace: string }).namespace]))
      .toEqual([["provider", bound.stream, 0, RELAY_OP.RESOURCE_INVALIDATE, "namespace", ns]]);
    expect(l.authority.stats.invalidates).toBe(1);
    // The guest's resource client moved the namespace generation: a later get is stamped with the new revision.
    const got = object(await l.get(bound.stream, tileRef({ source: info.source, z: 14, x: 2621, y: 6332 }, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: info.revision }));
    expect(got.ref.revision).toBe(result.sources[0].revision);
    // Withdraw the subscription: the next revision move announces nothing on
    // this stream, because §3.6 binds INVALIDATE delivery to a subscription.
    await new Promise<void>((resolve, reject) => { const started = l.guest.unsubscribe(bound.subscription, r => (r.ok ? resolve() : reject(new Error("unsubscribe refused")))); if (!("correlation" in started)) reject(new Error(started.code)); });
    await l.settle();
    const third = rasterService("3");
    try {
      l.backend.swap(third);
      expect((await l.authority.refresh()).changed).toEqual([ns]);
      await l.settle();
      expect(l.decoded().filter(f => f.type === RELAY_TYPE.INVALIDATE).length).toBe(1);
      expect(l.authority.stats.invalidates).toBe(1);
    } finally { third.close(); }
  } finally { l.close(); service.close(); later.close(); }
});

test("the catalog is one document on a control namespace: a get, a conditional get, and a PUSH when a reload moves it", async () => {
  const service = rasterService("1");
  const l = await link(service);
  const later = rasterService("2");
  try {
    const pushes: { ref: RelayResourceRef; data: Uint8Array }[] = [];
    const bound = await l.bind(CATALOG_NS, (ref, data) => pushes.push({ ref, data: data.slice() }));
    const first = object(await l.get(bound.stream, catalogRef(), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 }));
    const document = jsonDecodeStrict(first.data) as { v: number; revision: string; maps: { kind: string; source: string; revision: string }[] };
    expect(document.v).toBe(1);
    expect(document.revision).toMatch(/^[a-f0-9]{16}$/);
    expect(document.maps.map(m => [m.kind, m.source, m.revision])).toEqual([["osm", l.authority.sourceList()[0].source, l.authority.sourceList()[0].revision]]);
    expect(first.ref.revision).toBe(document.revision);
    // The catalog is served by the authority itself: no capability call.
    const calls = l.backend.calls();
    expect(await l.get(bound.stream, catalogRef(), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096, ifRevision: document.revision })).toEqual({ ok: true, value: { notModified: true, revision: document.revision } });
    expect(l.backend.calls()).toBe(calls);
    // A reload that moves a source moves the catalog and pushes it once.
    l.backend.swap(later);
    const reloaded = await l.authority.refresh({ reload: true });
    await l.settle();
    expect(reloaded.catalog.revision).not.toBe(document.revision);
    expect(pushes.length).toBe(1);
    expect(pushes[0].ref.revision).toBe(reloaded.catalog.revision);
    const pushed = jsonDecodeStrict(pushes[0].data) as { revision: string; maps: { revision: string }[] };
    expect(pushed.revision).toBe(reloaded.catalog.revision);
    expect(pushed.maps[0].revision).toBe(reloaded.sources[0].revision);
    expect(l.authority.stats.pushes).toBe(1);
  } finally { l.close(); service.close(); later.close(); }
});

test("the L2 fence: a reply generated after the revision moved (stamped with the old revision) is dropped RESYNC_REQUIRED, never published", async () => {
  const service = rasterService("1");
  const l = await link(service);
  const later = rasterService("2");
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const ns = namespaceFor(info.source);
    const bound = await l.bind(ns);
    const input = { source: info.source, z: 14, x: 2621, y: 6332 };
    // The get is at the authority (capability call in progress) when the source is reloaded.
    l.backend.hold(true);
    const outcomes: ResourceResult<unknown>[] = [];
    const started = l.guest.get(bound.stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, r => outcomes.push(r));
    if (!("correlation" in started)) throw new Error("get refused");
    await l.settle();
    l.backend.swap(later);
    expect((await l.authority.refresh()).changed).toEqual([ns]);
    await l.settle();
    // The old worker's reply drains: chunks stamped with the old revision, after the INVALIDATE on the same stream.
    expect(l.backend.releaseHeld()).toBe(1);
    await l.settle();
    expect(outcomes).toEqual([{ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } }]);
    const chunks = l.decoded().filter(f => f.from === "provider" && f.stream === bound.stream && f.type === RELAY_TYPE.RESPONSE && f.metadata.op === RELAY_OP.RESOURCE_GET);
    expect(chunks.length).toBe(3);
    expect((chunks[0].metadata.resource as RelayResourceRef).revision).toBe(info.revision);
    expect(l.guest.inspect()!.client!.localEntry(tileRef(input, RENDITION.raster))).toBeUndefined();
    expect(l.guest.inspect()!.requests.active).toBe(0);
    // The get's assembly is gone; the one that remains is the subscription's
    // reserved push channel, which outlives any single get.
    expect(l.guest.inspect()!.assembler!.stats().assemblies).toBe(1);
    // The next get publishes the new revision's pixels: the reloaded worker
    // is not held, only the old one was.
    l.backend.hold(false);
    const fresh = object(await l.get(bound.stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }));
    expect(fresh.ref.revision).toBe(l.authority.sourceList()[0].revision);
    const expected = await later.methods()["map.tile"](JSON.stringify(input)) as OffloadImage;
    expect(Buffer.compare(Buffer.from(fresh.data), Buffer.from(expected.pixels))).toBe(0);
  } finally { l.close(); service.close(); later.close(); }
});

test("a provider failure carries the code it declared; the message never selects behaviour", async () => {
  const methods = {
    "map.english": () => { throw notFound("missing tile"); },
    "map.french": () => { throw notFound("tuile absente"); },
    "map.budget-worded-not-found": () => { throw notFound("budget tile is missing and invalid"); },
    "map.busy": () => { throw busy("quota épuisé"); },
    "map.plain": () => { throw new Error("Invalid tile address or source"); },
    "map.custom-code": () => { throw new MapFailure("NOT_A_CODE", "invalid") },
  };
  const code = async (method: string) => (await dispatchMapCapability(methods, { id: 1, method, payload: "{}" })).error?.code;
  // Two languages, one failure: the same code.
  expect(await code("map.english")).toBe(RELAY_ERROR.NOT_FOUND);
  expect(await code("map.french")).toBe(RELAY_ERROR.NOT_FOUND);
  // Words a text classifier keys off ("budget", "invalid") do not move it.
  expect(await code("map.budget-worded-not-found")).toBe(RELAY_ERROR.NOT_FOUND);
  expect(await code("map.busy")).toBe(RELAY_ERROR.BUSY);
  // An unclassified fault falls back to the one retryable code, whatever it says.
  expect(await code("map.plain")).toBe(RELAY_ERROR.DEADLINE);
  // A code outside §3.6 is not passed to the wire.
  expect(await code("map.custom-code")).toBe(RELAY_ERROR.DEADLINE);
  expect(await code("map.absent")).toBe(RELAY_ERROR.UNSUPPORTED);
  expect(failureCode(invalid("x"))).toBe(RELAY_ERROR.INVALID);
  expect(failureCode(new Error("invalid"), RELAY_ERROR.BUSY)).toBe(RELAY_ERROR.BUSY);
  // The message survives for diagnostics, clipped to the §3.6 bound.
  const reply = await dispatchMapCapability(methods, { id: 7, method: "map.french", payload: "{}" });
  expect(reply.error).toEqual({ code: RELAY_ERROR.NOT_FOUND, message: "tuile absente" });
});

test("a provider failure reaches the guest as the declared code over the wire", async () => {
  const service = rasterService();
  const l = await link(service);
  try {
    const info = JSON.parse(service.methods()["map.info"]("{}"));
    const stream = await l.open(namespaceFor(info.source));
    // z 14 with an x outside the level: the provider refuses with INVALID.
    const outOfRange = await l.get(stream, tileRef({ source: info.source, z: 2, x: 9, y: 0 }, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 });
    expect(outOfRange).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID } });
    // The upstream place service answers 404 in this fixture: the cache
    // raises NOT_FOUND and the guest sees that code, not a message.
    const missing = await l.get(stream, searchRef({ query: "anywhere", source: info.source, lat: 1, lon: 2 }), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 8192 });
    expect(missing).toMatchObject({ ok: false, error: { code: RELAY_ERROR.NOT_FOUND } });
    expect((missing as { error: { message: string } }).error.message).toContain("404");
  } finally { l.close(); service.close(); }
});

test("the offload worker a relay host runs for saved places cannot answer a map read", async () => {
  // Task 1151 B5: a SIGHUP left map.info on a worker holding the previous
  // configuration while the relay namespace had already moved. In relay
  // mode the catalog is a relay resource and this worker's table is
  // restricted, so the split has no path left: the old worker refuses.
  const replies: BackendReply[] = [];
  const scope = { onmessage: undefined as ((event: { data: unknown }) => unknown) | undefined, postMessage: (value: unknown) => replies.push(value as BackendReply) };
  const g = globalThis as unknown as { self?: unknown };
  const had = "self" in g, previous = g.self;
  g.self = scope;
  try {
    await import("../host/worker.ts");
    const send = async (data: unknown) => { await scope.onmessage!({ data }); };
    await send({ init: { ...defaultConfig, cache: ":memory:", kind: "osm", only: [...SAVED_PLACES_ONLY] } });
    await send({ v: 1, relay: 1, id: 1, method: "map.info", payload: "{}" });
    await send({ v: 1, relay: 1, id: 2, method: "map.tile", payload: JSON.stringify({ source: "0".repeat(16), z: 1, x: 0, y: 0 }), response: "image" });
    await send({ v: 1, relay: 1, id: 3, method: "bookmarks.list", payload: JSON.stringify({ offset: 0 }) });
    expect(replies.map(r => [r.id, r.error?.code])).toEqual([
      [1, RELAY_ERROR.UNSUPPORTED],
      [2, RELAY_ERROR.UNSUPPORTED],
      [3, undefined],
    ]);
    expect(typeof replies[2].payload).toBe("string");
  } finally {
    if (had) g.self = previous; else delete g.self;
  }
});

test("codec 1 is decoded as strict UTF-8: overlong, surrogate, out-of-range and truncated bytes are refused with a stable code", () => {
  const cases: [string, number[]][] = [
    ["overlong solidus", [0xc0, 0xaf]],
    ["overlong NUL", [0xe0, 0x80, 0x80]],
    ["UTF-16 surrogate", [0xed, 0xa0, 0x80]],
    ["above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
    ["five-byte lead", [0xf8, 0x88, 0x80, 0x80, 0x80]],
    ["lone continuation", [0x80]],
    ["truncated tail", [0xe6, 0x97]],
    ["missing continuation", [0xe6, 0x97, 0x41]],
  ];
  for (const [label, bytes] of cases) {
    let thrown: unknown;
    try { utf8DecodeStrict(new Uint8Array(bytes)); } catch (error) { thrown = error; }
    expect({ label, code: failureCode(thrown, "NONE") }).toEqual({ label, code: RELAY_ERROR.INVALID });
  }
  // Legal text still round-trips, including astral planes.
  for (const text of ["", "[]", '["日本橋","東京"]', "\u{1f5fa}", "a\u0000b"]) {
    expect(utf8DecodeStrict(utf8Encode(text))).toBe(text);
  }
  // A strict decode that is not one JSON value is the same stable code.
  expect(failureCode((() => { try { jsonDecodeStrict(utf8Encode("{oops")); } catch (e) { return e; } })(), "NONE")).toBe(RELAY_ERROR.INVALID);
  expect(jsonDecodeStrict(utf8Encode('[{"a":1}]'))).toEqual([{ a: 1 }]);
});

test("resource identity helpers", () => {
  const input = { source: "0123456789abcdef", z: 3, x: 5, y: 2 };
  expect(tileRef(input, RENDITION.raster)).toEqual({ kind: RELAY_KIND.TILE, ns: "map/0123456789abcdef", key: "3/5/2", rendition: "r5g6b5-v1" });
  expect(parseMapRef(tileRef(input, RENDITION.raster), input.source)).toEqual({ method: "map.tile", payload: JSON.stringify(input), response: "image" });
  expect(parseMapRef(tileRef(input, RENDITION.mesh), input.source)).toEqual({ method: "map.mesh", payload: JSON.stringify(input), response: "mesh" });
  expect(parseMapRef(markerRef({ ...input, layer: "travel" }), input.source)).toEqual({ method: "map.markers", payload: JSON.stringify({ ...input, layer: "travel" }) });
  expect(parseMapRef(labelRef(input.source, { name: "a/b", detail: "c" }), input.source)).toEqual({ method: "map.label", payload: JSON.stringify({ name: "a/b", detail: "c" }), response: "image" });
  expect(parseMapRef(catalogRef(), "")).toEqual({ method: "map.catalog", payload: "{}" });
  // The search key round-trips through the authority into one map.search call.
  const query = { query: "kyoto", source: input.source, lat: 35.1, lon: 135.8 };
  expect(searchRef(query)).toEqual({ kind: RELAY_KIND.EVENT, ns: "map/0123456789abcdef", key: '["mercator","kyoto",35.1,135.8]', rendition: "search-places-v1" });
  expect(parseMapRef(searchRef(query), input.source)).toEqual({ method: "map.search", payload: JSON.stringify({ query: "kyoto", source: input.source, lat: 35.1, lon: 135.8 }) });
  const planar = { query: "shrine", source: input.source, space: "planar" as const, x: 12.5, y: 30 };
  expect(parseMapRef(searchRef(planar), input.source)).toEqual({ method: "map.search", payload: JSON.stringify({ space: "planar", query: "shrine", source: input.source, x: 12.5, y: 30 }) });
  expect(parseMapRef({ ...tileRef(input, RENDITION.raster), rendition: "markers-everything-v1" }, input.source)).toBeUndefined();
  expect(parseMapRef({ ...tileRef(input, RENDITION.raster), key: "3/5/2/1" }, input.source)).toBeUndefined();
  expect(parseMapRef({ kind: RELAY_KIND.TEXTURE, ns: "map/x", key: "not json", rendition: RENDITION.label }, input.source)).toBeUndefined();
  expect(parseMapRef({ ...searchRef(query), key: '["mercator","",1,2]' }, input.source)).toBeUndefined();
  expect(parseMapRef({ ...catalogRef(), ns: "map/0123456789abcdef" }, input.source)).toBeUndefined();
  expect(() => labelRef(input.source, { name: "語".repeat(80), detail: "語".repeat(20) })).toThrow("key bound");
  expect(() => searchRef({ query: "語".repeat(80), source: input.source, lat: 1, lon: 2 })).toThrow("key bound");
  expect(() => searchRef({ query: "x", lat: 1, lon: 2 })).toThrow("map source");
});
