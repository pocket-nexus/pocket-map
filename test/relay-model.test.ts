import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createResourceView } from "@pocketjs/framework/resource-view";
import { RELAY_ERROR } from "@pocketjs/framework/relay/spec";
import { MAP_RELAY } from "../shared/relay.ts";
import type { Place, TileInput } from "../shared/types.ts";
import { createRig, rasterService, type Fixture, type Transport } from "./relay-rig.ts";

const receipt = (name: string, value: unknown) => console.log(`RECEIPT ${name} ${JSON.stringify(value)}`);
const keyOf = (t: TileInput) => `${t.z}/${t.x}/${t.y}`;
const handleOf = (state: { status: string; value?: unknown }) => state.status === "ready" ? (state.value as { handle: number }).handle : -1;
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
/** The negotiated per-stream window slice: the attachment window minus the
 * stream-0 control quarter (framework relayControlSlice/relayStreamSlice). */
const SLICE = { frames: MAP_RELAY.rxLimits.windowFrames - Math.min(8, Math.floor(MAP_RELAY.rxLimits.windowFrames / 4)), bytes: MAP_RELAY.rxLimits.windowBytes - Math.min(32768, Math.floor(MAP_RELAY.rxLimits.windowBytes / 4)) };
const LABEL: Place = { id: "label:1", name: "日本橋", detail: "", lat: 0, lon: 0, zoom: 14 };

/** Frame hooks are process-global, so the two transports run one after the
 * other against identical fixtures and their screens are compared as
 * snapshots of uploaded bytes. */
async function screen(transport: Transport, fixture: Fixture) {
  const r = await createRig({ transport, fixture });
  try {
    await r.until(() => !!r.model.info(), 120);
    const framesToScreen = await r.until(r.screenReady, 900);
    await r.frames(30); // markers settle after the tiles
    const tiles = r.model.front()!.tiles.map(t => t.input);
    const bytes = new Map(tiles.map(t => [keyOf(t), r.tileBytes(t)?.slice()]));
    let view!: ReturnType<typeof createResourceView<Place, { handle: number }>>;
    createRoot(() => { view = createResourceView(r.model.labels, { demand: () => [{ input: LABEL, priority: 30, pin: true }] }); });
    await r.until(() => view.state(LABEL).status === "ready", 300);
    const label = r.host.textures.get(view.value(LABEL)!.handle)?.slice();
    const markers = r.model.annotations.rows();
    const relay = r.relayStats(), totals = r.wireTotals(), offload = r.offloadStats();
    if (transport === "relay") {
      // Nothing but map.info crossed offload; every read was a resource, and the link is quiet at the end.
      expect(Object.keys(offload.byMethod)).toEqual(["map.info"]);
      expect(relay!.protocolErrors).toBe(0); expect(r.providerEndpoint!.protocolErrors).toBe(0);
      expect(relay!.pending).toBe(0); expect(relay!.staged).toBe(0);
      expect(r.samples.providerInFlightFrames).toBeLessThanOrEqual(SLICE.frames);
      expect(r.samples.providerInFlightBytes).toBeLessThanOrEqual(SLICE.bytes);
    }
    const perTile = (n: number) => Math.round(n / tiles.length);
    const summary = transport === "offload"
      ? { framesToScreen, requests: offload.requests, replies: offload.replies, imageReplies: offload.imageReplies, meshReplies: offload.meshReplies, requestBytes: offload.requestBytes, replyBytes: offload.replyBytes,
        wireBytes: offload.requestBytes + offload.replyBytes, bytesPerTile: perTile(offload.requestBytes + offload.replyBytes), maxPending: offload.maxPending, maxStaging: offload.maxStaging, provider: r.service.diagnostics() }
      : { framesToScreen, gets: relay!.gets, objects: relay!.objects, notModified: relay!.notModified, busyRefusals: relay!.busy, cancels: relay!.cancels, evicts: relay!.evicts,
        frames: totals.frames, requestFrames: totals.requests, responseChunks: totals.responseChunks, creditFrames: totals.credits, cancelFrames: totals.cancels, evictFrames: totals.evicts, controlFrames: totals.control,
        bytesToGuest: totals.toGuestBytes, bytesToProvider: totals.toProviderBytes, wireBytes: totals.bytes, objectDataBytes: totals.dataBytes, bytesPerTile: perTile(totals.bytes),
        guestActiveMax: r.samples.guestActive, providerInFlightFramesMax: r.samples.providerInFlightFrames, providerInFlightBytesMax: r.samples.providerInFlightBytes,
        authority: { ...r.authorityStats()! }, provider: r.service.diagnostics() };
    return { tiles, bytes, label, markers, summary };
  } finally { r.dispose(); }
}

for (const fixture of ["raster", "vector"] as Fixture[]) {
  test(`${fixture}: one 400x240 screen is byte-identical on offload and relay; bytes, requests and cache hits are measured`, async () => {
    const a = await screen("offload", fixture), b = await screen("relay", fixture);
    expect(a.tiles.map(keyOf)).toEqual(b.tiles.map(keyOf));
    expect(a.tiles.length).toBeGreaterThanOrEqual(4);
    for (const t of a.tiles) {
      const bytesA = a.bytes.get(keyOf(t)), bytesB = b.bytes.get(keyOf(t));
      expect(bytesA?.length).toBe(fixture === "raster" ? 131072 : bytesA?.length ?? -1);
      expect(same(bytesA, bytesB)).toBe(true);
    }
    expect(b.markers).toEqual(a.markers);
    if (fixture === "vector") expect(a.markers.length).toBeGreaterThan(0);
    expect(a.label?.length).toBe(16384);
    expect(same(a.label, b.label)).toBe(true);
    receipt(`screen-${fixture}`, { fixture, tiles: a.tiles.length, labels: 1, markerRows: a.markers.length, offload: a.summary, relay: b.summary });
  }, 60000);
}

test("a relay reconnect revalidates every resident tile with ifRevision: notModified terminals, no re-transfer, tiles never leave the ready state", async () => {
  const r = await createRig({ transport: "relay", fixture: "raster" });
  try {
    await r.until(() => !!r.model.info(), 120);
    await r.until(r.screenReady, 900);
    await r.frames(20);
    const before = r.relayStats()!, wireBefore = r.wireTotals(), tiles = r.model.front()!.tiles.map(t => t.input);
    const handles = tiles.map(t => handleOf(r.model.frontView.state(t)));
    await r.reconnect();
    let pendingSeen = 0;
    const frames = await r.until(() => r.relayStats()!.notModified - before.notModified >= r.model.tiles.stats().entries && r.relayStats()!.pending === 0, 600);
    for (let i = 0; i < 30; i++) { await r.frame(); if (!r.screenReady()) pendingSeen++; }
    const after = r.relayStats()!, wireAfter = r.wireTotals();
    const revalidated = after.notModified - before.notModified, transferred = after.objects - before.objects;
    receipt("reconnect", { residentEntries: r.model.tiles.stats().entries, revalidated, transferred, frames, bytesDuringReconnect: wireAfter.bytes - wireBefore.bytes, bytesPerRevalidation: Math.round((wireAfter.bytes - wireBefore.bytes) / revalidated), sessions: after.sessions, resync: after.errorCodes[RELAY_ERROR.RESYNC_REQUIRED] ?? 0 });
    expect(after.sessions).toBe(2);
    expect(revalidated).toBe(r.model.tiles.stats().entries);
    expect(transferred).toBe(0);
    expect(pendingSeen).toBe(0);
    expect(tiles.map(t => handleOf(r.model.frontView.state(t)))).toEqual(handles);
    // Each revalidation is one request frame and one small terminal: far below one tile's 131,072 bytes.
    expect(wireAfter.bytes - wireBefore.bytes).toBeLessThan(revalidated * 2000 + 4096);
  } finally { r.dispose(); }
}, 60000);

test("a moved source revision: resident tiles are refetched, the gets in flight at the authority end CANCELLED, and no old-revision pixels are published", async () => {
  const r = await createRig({ transport: "relay", fixture: "raster", latency: 2 });
  try {
    await r.until(() => !!r.model.info(), 120);
    await r.until(r.screenReady, 900);
    await r.frames(10);
    const oldRevision = r.authority!.sourceList()[0].revision;
    const oldTiles = r.model.front()!.tiles.map(t => t.input);
    const oldBytes = new Map(oldTiles.map(t => [keyOf(t), r.tileBytes(t)!.slice()]));
    const oldBackend = r.backend, statsBefore = r.relayStats()!, authorityBefore = { ...r.authorityStats()! };
    // Hold the provider's capability replies, then expose new tiles: their gets are in flight at the authority.
    oldBackend.hold(true);
    const v = r.model.camera.view();
    r.model.camera.jump(v.x + 2 * 400 / 2 ** v.zoom, v.y, v.zoom);
    await r.until(() => r.relayStats()!.pending > 0, 60);
    await r.frames(4);
    const inFlight = r.relayStats()!.pending;
    expect(inFlight).toBeGreaterThan(0);
    // The host reloads with a new epoch: one namespace INVALIDATE, then the old replies (old pixels, old revision) drain.
    const reload = await r.reload("2");
    expect(reload.changed).toEqual([r.authority!.sourceList()[0].ns]);
    const newRevision = r.authority!.sourceList()[0].revision;
    expect(newRevision).not.toBe(oldRevision);
    await r.frames(6);
    expect(r.relayStats()!.invalidates).toBe(1);
    expect(oldBackend.releaseHeld()).toBe(inFlight);
    await r.until(r.screenReady, 900);
    await r.frames(30);
    const stats = r.relayStats()!, authority = r.authorityStats()!;
    // The in-flight gets were withdrawn by the cache's invalidate (CANCEL) and answered CANCELLED, not with the old object.
    expect((stats.errorCodes[RELAY_ERROR.CANCELLED] ?? 0)).toBeGreaterThanOrEqual(inFlight);
    expect(authority.cancelled - authorityBefore.cancelled).toBeGreaterThanOrEqual(inFlight);
    // Every visible tile carries the new epoch's pixels and none the old ones; nothing was confirmed notModified across the change.
    const newTiles = r.model.front()!.tiles.map(t => t.input);
    const fresh = rasterService("2");
    try {
      for (const t of newTiles) {
        const expected = (await fresh.methods()["map.tile"](JSON.stringify(t)) as { pixels: Uint8Array }).pixels;
        expect(same(r.tileBytes(t), expected)).toBe(true);
        const old = oldBytes.get(keyOf(t));
        if (old) expect(same(r.tileBytes(t), old)).toBe(false);
      }
    } finally { fresh.close(); }
    expect(stats.notModified).toBe(statsBefore.notModified);
    expect(r.model.tiles.stats().ready).toBe(r.model.tiles.stats().entries);
    receipt("invalidate", { inFlightAtReload: inFlight, cancelledTerminals: stats.errorCodes[RELAY_ERROR.CANCELLED] ?? 0, resync: stats.errorCodes[RELAY_ERROR.RESYNC_REQUIRED] ?? 0, invalidates: stats.invalidates, authorityInvalidates: authority.invalidates,
      oldRevision, newRevision, tilesChecked: newTiles.length, residentEntries: r.model.tiles.stats().entries, objectsRefetched: stats.objects - statsBefore.objects, notModified: stats.notModified - statsBefore.notModified });
  } finally { r.dispose(); }
}, 60000);

async function drive(transport: Transport, backendDelayFrames: number) {
  const r = await createRig({ transport, fixture: "raster", latency: 2, deliveriesPerFrame: 8, backendDelayFrames });
  await r.until(() => !!r.model.info(), 120);
  await r.until(r.screenReady, 900);
  const start = r.model.camera.view();
  const issued = () => transport === "relay" ? r.relayStats()!.gets : r.offloadStats().byMethod["map.tile"] ?? 0;
  let jumps = 0;
  const demanded = new Set<string>();
  const step = 400 / 2 ** start.zoom; // one viewport width in world units
  while (issued() < 600 && jumps < 1500) {
    // A widening spiral of one-screen jumps, four frames per jump: every jump exposes a new column or row.
    const ring = Math.floor(Math.sqrt(jumps)) + 1, angle = jumps * 2.399;
    r.model.camera.jump(start.x + Math.cos(angle) * ring * step, start.y + Math.sin(angle) * ring * step * 0.6, start.zoom);
    jumps++;
    for (let i = 0; i < 4; i++) {
      await r.frame();
      for (const t of r.model.front()?.tiles ?? []) demanded.add(keyOf(t.input));
      for (const t of r.model.lookAhead()) demanded.add(keyOf(t.input));
    }
  }
  await r.frames(150);
  return { r, summary: { providerDelayFrames: backendDelayFrames, jumps, distinctTilesDemanded: demanded.size, frames: r.tick, residentEntries: r.model.tiles.stats().entries, materialized: r.uploaded().textures } };
}

async function burstOffload(backendDelayFrames: number) {
  const { r, summary } = await drive("offload", backendDelayFrames);
  try {
    const o = r.offloadStats();
    return { ...summary, tileRequests: o.byMethod["map.tile"] ?? 0, imageReplies: o.imageReplies, uploaded: o.uploaded, wastedImageReplies: o.imageReplies - o.uploaded, wastedBytes: (o.imageReplies - o.uploaded) * 131088,
      wireBytes: o.requestBytes + o.replyBytes, maxPending: o.maxPending, maxStaging: o.maxStaging, endStaging: o.staging, provider: r.service.diagnostics() };
  } finally { r.dispose(); }
}

async function burstRelay(backendDelayFrames: number) {
  const { r, summary: drove } = await drive("relay", backendDelayFrames);
  try {
    const s = r.relayStats()!, t = r.wireTotals(), a = r.authorityStats()!, g = r.client!.endpoint.inspect()!, p = r.providerEndpoint!.inspect()!;
    const summary = { ...drove, gets: s.gets, objects: s.objects, cancels: s.cancels, cancelledTerminals: s.errorCodes[RELAY_ERROR.CANCELLED] ?? 0, objectsDiscardedAfterCancel: s.discarded, wastedBytes: s.discarded * 131072, busyRefusals: s.busy, otherErrors: s.errors - (s.errorCodes[RELAY_ERROR.CANCELLED] ?? 0), droppedObjects: s.dropped,
      framesToGuest: t.toGuestFrames, framesToProvider: t.toProviderFrames, framesReceivedByGuest: s.framesIn, framesSentByGuest: s.framesOut, wireBytes: t.bytes, objectDataBytes: t.dataBytes, creditFrames: t.credits, cancelFrames: t.cancels, evictFrames: t.evicts,
      maxGuestActiveRequests: r.samples.guestActive, maxProviderActiveRequests: r.samples.providerActive, maxProviderInFlightFrames: r.samples.providerInFlightFrames, maxProviderInFlightBytes: r.samples.providerInFlightBytes, maxProviderDemandQueue: r.samples.providerDemand,
      peakStaged: s.peakStaged, peakAssemblyBytes: g.assembler!.stats().peakStagedBytes,
      negotiated: { maxPending: MAP_RELAY.rxLimits.maxPending, requestReserve: MAP_RELAY.requestReserve, slice: SLICE },
      endState: { pending: s.pending, staged: s.staged, assemblies: g.assembler!.stats().assemblies, providerDemand: [...p.demand.values()].reduce((n, q) => n + q.length, 0), protocolErrors: s.protocolErrors + r.providerEndpoint!.protocolErrors },
      authority: { ...a }, provider: r.service.diagnostics() };
    expect(s.gets).toBeGreaterThanOrEqual(600);
    expect(r.samples.providerInFlightFrames).toBeLessThanOrEqual(SLICE.frames);
    expect(r.samples.providerInFlightBytes).toBeLessThanOrEqual(SLICE.bytes);
    expect(r.samples.guestActive).toBeLessThanOrEqual(MAP_RELAY.rxLimits.maxPending - MAP_RELAY.requestReserve);
    expect(r.samples.providerActive).toBeLessThanOrEqual(MAP_RELAY.rxLimits.maxPending);
    expect(r.samples.providerDemand).toBeLessThanOrEqual(MAP_RELAY.rxLimits.maxPending * 3);
    // No frame lost: everything the provider sent reached the guest and vice versa; every get ended in exactly one terminal.
    expect(s.framesIn).toBe(t.toGuestFrames); expect(s.framesOut).toBe(t.toProviderFrames);
    expect(s.objects + s.notModified + s.errors).toBe(s.gets);
    expect(summary.endState).toEqual({ pending: 0, staged: 0, assemblies: 0, providerDemand: 0, protocolErrors: 0 });
    expect(r.model.tiles.stats().entries).toBeLessThanOrEqual(40);
    return summary;
  } finally { r.dispose(); }
}

for (const providerDelay of [0, 3]) {
  test(`a burst of >=600 tile requests from rapid panning stays inside the negotiated window and request slots on relay (provider delay ${providerDelay} frames); offload numbers for contrast`, async () => {
    const relay = await burstRelay(providerDelay);
    const offload = await burstOffload(providerDelay);
    receipt(`burst-delay${providerDelay}`, { relay, offload });
    expect(offload.maxPending).toBeLessThanOrEqual(8); expect(offload.maxStaging).toBeLessThanOrEqual(8);
    // With a provider slower than one frame, a withdrawn tile ends as a CANCELLED terminal, not a transferred object.
    if (providerDelay > 0) expect(relay.cancelledTerminals).toBeGreaterThan(relay.objectsDiscardedAfterCancel);
  }, 240000);
}
