/** Headless drivers for the guest model on both transports against one
 * in-process MapService: the offload rig mirrors scripts/sim.ts's fake
 * `offload` global; the relay rig links a guest RelayMapClient to a provider
 * endpoint over an in-memory channel with per-frame delivery and counts
 * every wire record. Both record uploaded pixels/meshes per handle so tiles
 * can be compared byte for byte. */
import { createRoot } from "solid-js";
import { createCanvas } from "@napi-rs/canvas";
import { createOffloadClient } from "@pocketjs/framework/offload";
import type { OffloadImage, OffloadMesh } from "@pocketjs/framework/offload/provider";
import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { RELAY_OP, RELAY_TYPE } from "@pocketjs/framework/relay/spec";
import type { RelayScheduler, RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { installHost, type HostOps } from "../runtime/framework/src/host.ts";
import { runFrameHooks, resetFrameHooks } from "../runtime/framework/src/frame.ts";
import { runServicePumps } from "../runtime/framework/src/services.ts";
import { encodeOffloadRecord, encodeOffloadImage, encodeOffloadMesh } from "../runtime/tools/offload-wire.ts";
import { MapService } from "../host/service.ts";
import { defaultConfig } from "../host/config.ts";
import type { NetworkFetch } from "../host/cache.ts";
import { MapRelayAuthority, inProcessBackend, providerCapabilities, type BackendReply, type BackendRequest, type MapBackend } from "../host/relay-host.ts";
import { createRelayMapClient, type RelayMapClient } from "../app/relay.ts";
import { createMap, type MapModel } from "../app/model.ts";
import type { TileInput } from "../shared/types.ts";
import { vectorFixture } from "./vector-fixture.ts";

export type Transport = "offload" | "relay";
export type Fixture = "raster" | "vector";

// --- deterministic fixtures ----------------------------------------------------

/** One PNG per address: a two-tone tile whose colors follow z/x/y (plus an
 * epoch), so neighbouring tiles differ and a revision change is visible in
 * the pixels. */
export function rasterPng(z: number, x: number, y: number, epoch = "1"): Buffer {
  const seed = (z * 7919 + x * 104729 + y * 1299709 + epoch.length * 31337) >>> 0;
  const hex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
  const canvas = createCanvas(256, 256), c = canvas.getContext("2d");
  c.fillStyle = hex(seed * 2654435761); c.fillRect(0, 0, 256, 256);
  c.fillStyle = hex((seed ^ 0x5bd1e995) * 2246822519); c.fillRect(0, 0, 128, 256);
  c.fillStyle = epoch === "1" ? "#d03030" : "#3050d0"; c.fillRect(96, 96, 64, 64);
  return canvas.toBuffer("image/png");
}
export const RASTER_URL = "https://tile.example.test/{z}/{x}/{y}.png";
export function rasterService(epoch = "1"): MapService {
  const network: NetworkFetch = async url => {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(url));
    if (!m) return new Response("not found", { status: 404 });
    return new Response(rasterPng(Number(m[1]), Number(m[2]), Number(m[3]), epoch), { headers: { "cache-control": "max-age=3600" } });
  };
  return new MapService({ ...defaultConfig, format: "raster", tileURL: RASTER_URL, cache: ":memory:", kind: "osm", revision: epoch }, network);
}
export function vectorService(epoch = "1"): MapService {
  const network: NetworkFetch = async url => String(url).includes("photon")
    ? new Response(JSON.stringify({ features: [{ properties: { osm_type: "N", osm_id: 1, name: "Tokyo", country: "Japan", type: "city" }, geometry: { coordinates: [139.76, 35.68] } }] }))
    : new Response(vectorFixture(), { headers: { "cache-control": "max-age=3600" } });
  return new MapService({ ...defaultConfig, cache: ":memory:", kind: "osm", revision: epoch }, network);
}

// --- the shared fake host: every upload is recorded per handle -------------------

const uploads = { textures: new Map<number, Uint8Array>(), meshes: new Map<number, Uint8Array>(), next: 1, frameUploads: 0, texturesUploaded: 0, meshesUploaded: 0 };
let installed = false;
export function fakeHost() {
  if (!installed) {
    installed = true;
    const ops = {
      uploadImgEntry(blob: Uint8Array) {
        if (uploads.frameUploads >= 1) return -1;
        uploads.frameUploads++; uploads.texturesUploaded++;
        const handle = uploads.next++;
        uploads.textures.set(handle, blob.slice(8));
        return handle;
      },
      uploadMesh(bytes: Uint8Array) {
        if (uploads.frameUploads >= 1) return -1;
        uploads.frameUploads++; uploads.meshesUploaded++;
        const handle = uploads.next++;
        uploads.meshes.set(handle, bytes.slice());
        return handle;
      },
      freeTexture: (handle: number) => { uploads.textures.delete(handle); },
      freeMesh: (handle: number) => { uploads.meshes.delete(handle); },
      measureText: () => 0,
    } as unknown as HostOps;
    installHost({ kind: "injected", target: "relay-rig", strict: true, ops });
  }
  return uploads;
}

function fakeScheduler(): RelayScheduler & { advance(ms: number): void } {
  let now = 0, nextId = 1;
  const jobs = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => { jobs.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let dueId = 0, dueAt = 0, dueFn: (() => void) | undefined;
        for (const [id, job] of jobs) if (job.at <= until && (dueFn === undefined || job.at < dueAt)) { dueId = id; dueAt = job.at; dueFn = job.fn; }
        if (dueFn === undefined) break;
        now = dueAt; jobs.delete(dueId); dueFn();
      }
      now = until;
    },
  };
}
function seededBytes(seed: number) {
  let counter = seed;
  return (n: number) => { const out = new Uint8Array(n); for (let i = 0; i < n; i++) { counter = (counter * 1103515245 + 12345) >>> 0; out[i] = (counter >>> 16) & 0xff; } return out; };
}

/** A backend whose image/mesh replies can be held (a slow provider) and
 * whose service can be swapped (a reloaded host). */
export function holdableBackend(service: MapService, delay: { frames: number; now: () => number } = { frames: 0, now: () => 0 }) {
  const inner = inProcessBackend(service);
  const held: Array<() => void> = [];
  const delayed: Array<{ at: number; release: () => void }> = [];
  let holding = false, calls = 0;
  const backend: MapBackend & { hold(on: boolean): void; releaseHeld(): number; calls(): number; pump(): void } = {
    call(request: BackendRequest): Promise<BackendReply> {
      calls++;
      const reply = inner.call(request);
      if (request.response === undefined) return reply;
      if (holding) return new Promise(resolve => held.push(() => { reply.then(resolve); }));
      // A provider that needs `delay.frames` frames per image/mesh (a worker decode slower than one frame).
      if (delay.frames > 0) return new Promise(resolve => delayed.push({ at: delay.now() + delay.frames, release: () => { reply.then(resolve); } }));
      return reply;
    },
    close: () => {}, // the rig closes services at dispose(): a held reply may still need the old one
    hold(on) { holding = on; },
    releaseHeld() { const n = held.length; for (const release of held.splice(0)) release(); return n; },
    calls: () => calls,
    pump() { while (delayed.length && delayed[0].at <= delay.now()) delayed.shift()!.release(); },
  };
  return backend;
}

// --- rigs ------------------------------------------------------------------------

export interface RigOptions {
  transport: Transport;
  fixture?: Fixture;
  /** Frames a provider reply waits before the guest sees it. */
  latency?: number;
  /** Relay records handed to the guest per frame (a device pump budget). */
  deliveriesPerFrame?: number;
  viewport?: { width: number; height: number };
  tileEntries?: number;
  /** Service factory; called again by reload(). */
  service?: (epoch: string) => MapService;
  epoch?: string;
  /** Frames the provider needs per image/mesh reply (0 = same frame). */
  backendDelayFrames?: number;
}
export interface WireFrame { from: "guest" | "provider"; type: number; op: string; stream: number; bytes: number; seq: number; codec: number; data: number }

export async function createRig(options: RigOptions) {
  resetFrameHooks();
  const host = fakeHost();
  const fixture = options.fixture ?? "raster";
  const makeService = options.service ?? ((epoch: string) => (fixture === "vector" ? vectorService(epoch) : rasterService(epoch)));
  let epoch = options.epoch ?? "1";
  let service = makeService(epoch);
  const services = [service];
  let tick = 0;
  const backendDelay = { frames: options.backendDelayFrames ?? 0, now: () => tick };
  let backend = holdableBackend(service, backendDelay);
  const backends = [backend];
  const latency = options.latency ?? 3, deliveriesPerFrame = options.deliveriesPerFrame ?? 16;
  const viewport = options.viewport ?? { width: 400, height: 240 }, tileEntries = options.tileEntries ?? 40;

  // --- offload side (map.info/search/bookmarks always; tiles too on the offload rig)
  const offloadRequests: string[] = [], offloadReplies: { at: number; raw: string }[] = [];
  const images = new Map<number, OffloadImage>(), meshes = new Map<number, OffloadMesh>();
  let token = 1, offloadSession = 1;
  const uploadsBefore = { textures: host.texturesUploaded, meshes: host.meshesUploaded };
  const offload = { requests: 0, replies: 0, requestBytes: 0, replyBytes: 0, imageReplies: 0, meshReplies: 0, uploaded: 0, released: 0, byMethod: new Map<string, number>(), maxPending: 0, maxStaging: 0 };
  let executing = 0;
  const io = createOffloadClient({
    session: () => offloadSession,
    submit: raw => {
      if (offloadRequests.length >= 8) return false;
      offloadRequests.push(raw); offload.requests++; offload.requestBytes += encodeOffloadRecord(raw).length;
      const method = JSON.parse(raw).method as string; offload.byMethod.set(method, (offload.byMethod.get(method) ?? 0) + 1);
      return true;
    },
    take: () => { const n = offloadReplies.findIndex(r => r.at <= tick); return n < 0 ? undefined : offloadReplies.splice(n, 1)[0].raw; },
    uploadImage: id => {
      const image = images.get(id);
      if (!image || host.frameUploads >= 1) return -1;
      host.frameUploads++; host.texturesUploaded++; offload.uploaded++;
      const handle = host.next++; host.textures.set(handle, image.pixels.slice()); return handle;
    },
    releaseImage: id => { if (images.delete(id)) offload.released++; },
    uploadMesh: id => {
      const mesh = meshes.get(id);
      if (!mesh || host.frameUploads >= 1) return -1;
      host.frameUploads++; host.meshesUploaded++; offload.uploaded++;
      const handle = host.next++; host.meshes.set(handle, mesh.bytes.slice()); return handle;
    },
    releaseMesh: id => { if (meshes.delete(id)) offload.released++; },
  });

  // --- relay side
  const wire: WireFrame[] = [];
  const toGuest: { at: number; bytes: Uint8Array }[] = [];
  const clocks = { guest: fakeScheduler(), provider: fakeScheduler() };
  const samples = { providerInFlightFrames: 0, providerInFlightBytes: 0, providerDemand: 0, guestActive: 0, guestOccupancyFrames: 0, guestOccupancyBytes: 0, providerActive: 0 };
  const busy = { guest: false, provider: false };
  let held = false;
  const decodeFor = (from: WireFrame["from"], bytes: Uint8Array) => {
    const decoded = decodeFrame(bytes, { maxWireBytes: 65536, maxMetaBytes: 2048 });
    if (!decoded.ok) throw new Error(`rig: undecodable ${from} frame: ${decoded.code}`);
    const f = decoded.frame;
    wire.push({ from, type: f.type, op: String(f.metadata.op), stream: f.stream, bytes: bytes.length, seq: f.seq, codec: f.codec, data: f.data.length });
  };
  let providerEndpoint: RelayEndpoint | undefined, client: RelayMapClient | undefined, providerTransport: RelayTransportAdapter | undefined;
  let authority: MapRelayAuthority | undefined, connection: ReturnType<MapRelayAuthority["connection"]> | undefined;
  if (options.transport === "relay") {
    authority = new MapRelayAuthority({ backend: () => backend });
    await authority.refresh();
    const guestTransport: RelayTransportAdapter = {
      peer: { id: "companion", grants: ["pocket-map"] },
      trySend: bytes => {
        if (busy.guest) return "busy";
        decodeFor("guest", bytes);
        providerEndpoint!.handleRecord(bytes.slice());
        const p = providerEndpoint!.inspect();
        if (p) samples.providerActive = Math.max(samples.providerActive, p.requests.active);
        return "accepted";
      },
    };
    providerTransport = {
      peer: { id: "device-1", grants: ["pocket-map"] },
      trySend: bytes => {
        if (busy.provider) return "busy";
        decodeFor("provider", bytes);
        toGuest.push({ at: tick + latency, bytes: bytes.slice() });
        const p = providerEndpoint!.inspect();
        if (p) {
          for (const stream of p.allocations.keys()) if (stream !== 0) {
            const flight = p.sender.ledgerView().inFlight(stream);
            samples.providerInFlightFrames = Math.max(samples.providerInFlightFrames, flight.frames);
            samples.providerInFlightBytes = Math.max(samples.providerInFlightBytes, flight.bytes);
            samples.providerDemand = Math.max(samples.providerDemand, p.demand.get(stream)?.length ?? 0);
          }
        }
        return "accepted";
      },
    };
    connection = authority.connection(providerTransport.peer);
    providerEndpoint = new RelayEndpoint({ role: "provider", transport: providerTransport, local: providerCapabilities(), hooks: connection.hooks, scheduler: clocks.provider, randomBytes: seededBytes(0x50) });
    connection.bind(providerEndpoint);
    client = createRelayMapClient({ transport: guestTransport, scheduler: clocks.guest, randomBytes: seededBytes(0x47) });
    client.connect();
  }

  // --- the model
  let model!: MapModel, dispose!: () => void;
  createRoot(d => {
    dispose = d;
    model = createMap(io, viewport, tileEntries, options.transport === "relay" ? { transport: "relay", relay: client } : {});
  });

  async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }
  async function frame(buttons = 0) {
    tick++; host.frameUploads = 0;
    for (const b of backends) b.pump();
    if (client && !held) {
      let delivered = 0;
      while (toGuest.length && toGuest[0].at <= tick && delivered < deliveriesPerFrame) { client.handleRecord(toGuest.shift()!.bytes); delivered++; }
      const g = client.endpoint.inspect();
      if (g) {
        samples.guestActive = Math.max(samples.guestActive, g.requests.active);
        const occupancy = g.receiver.occupancy();
        samples.guestOccupancyFrames = Math.max(samples.guestOccupancyFrames, occupancy.frames);
        samples.guestOccupancyBytes = Math.max(samples.guestOccupancyBytes, occupancy.bytes);
      }
    }
    runServicePumps();
    const before = model.runtime.stats().frame;
    runFrameHooks(buttons);
    if (model.runtime.stats().frame === before) model.runtime.step();
    io.step();
    offload.maxPending = Math.max(offload.maxPending, io.pending());
    // The provider's eight credits cover executing requests, queued replies and
    // staged images (tools/offload-provider.ts canRead); replies are staged
    // when the capability finishes and delivered `latency` frames later.
    while (offloadRequests.length && executing + images.size + meshes.size < 8) {
      const raw = offloadRequests.shift()!, request = JSON.parse(raw);
      executing++;
      void backend.call(request).then(result => {
        executing--;
        if (result.image) {
          const id = token++; images.set(id, result.image); offload.imageReplies++;
          offload.replyBytes += encodeOffloadImage(result.id, result.image).length;
          offloadReplies.push({ at: tick + latency, raw: JSON.stringify({ id: result.id, image: { token: id, width: result.image.width, height: result.image.height } }) });
        } else if (result.mesh) {
          const id = token++; meshes.set(id, result.mesh); offload.meshReplies++;
          const record = encodeOffloadMesh(result.id, result.mesh); offload.replyBytes += record.length;
          const view = new DataView(result.mesh.bytes.buffer, result.mesh.bytes.byteOffset);
          offloadReplies.push({ at: tick + latency, raw: JSON.stringify({ id: result.id, mesh: { token: id, width: view.getUint16(4, true), height: view.getUint16(6, true), bytes: result.mesh.bytes.length } }) });
        } else {
          const record = JSON.stringify(result); offload.replyBytes += encodeOffloadRecord(record).length;
          offloadReplies.push({ at: tick + latency, raw: record });
        }
        offload.replies++;
        offload.maxStaging = Math.max(offload.maxStaging, images.size + meshes.size);
      });
    }
    clocks.guest.advance(1000 / 60); clocks.provider.advance(1000 / 60);
    await settle();
  }
  async function frames(n: number, buttons = 0) { for (let i = 0; i < n; i++) await frame(buttons); }
  async function until(predicate: () => boolean, maxFrames = 600, buttons = 0): Promise<number> {
    let n = 0;
    while (!predicate()) { if (n >= maxFrames) throw new Error(`rig: condition not met within ${maxFrames} frames`); await frame(buttons); n++; }
    return n;
  }
  const screenReady = () => !!model.front() && model.front()!.tiles.every(t => model.frontView.state(t.input).status === "ready");
  const tileBytes = (input: TileInput): Uint8Array | undefined => {
    const state = model.frontView.state(input);
    if (state.status !== "ready") return undefined;
    const handle = (state.value as { handle: number }).handle;
    return model.vector() ? host.meshes.get(handle) : host.textures.get(handle);
  };
  const wireTotals = () => {
    const totals = { frames: 0, bytes: 0, toGuestFrames: 0, toGuestBytes: 0, toProviderFrames: 0, toProviderBytes: 0, requests: 0, responseChunks: 0, credits: 0, cancels: 0, invalidates: 0, evicts: 0, pings: 0, control: 0, dataBytes: 0 };
    for (const f of wire) {
      totals.frames++; totals.bytes += f.bytes;
      if (f.from === "provider") { totals.toGuestFrames++; totals.toGuestBytes += f.bytes; } else { totals.toProviderFrames++; totals.toProviderBytes += f.bytes; }
      if (f.op === RELAY_OP.RESOURCE_GET && f.type === RELAY_TYPE.REQUEST) totals.requests++;
      else if (f.op === RELAY_OP.RESOURCE_GET && f.type === RELAY_TYPE.RESPONSE) { totals.responseChunks++; totals.dataBytes += f.data; }
      else if (f.op === RELAY_OP.CREDIT) totals.credits++;
      else if (f.type === RELAY_TYPE.CANCEL) totals.cancels++;
      else if (f.op === RELAY_OP.RESOURCE_INVALIDATE) totals.invalidates++;
      else if (f.op === RELAY_OP.CACHE_EVICT) totals.evicts++;
      else if (f.op === RELAY_OP.PING) totals.pings++;
      else totals.control++;
    }
    return totals;
  };
  return {
    transport: options.transport, fixture, model, io, client, authority, providerEndpoint, host, wire, samples,
    get service() { return service; }, get backend() { return backend; }, get tick() { return tick; },
    frame, frames, until, screenReady, tileBytes, wireTotals, settle,
    offloadStats: () => ({ ...offload, byMethod: Object.fromEntries(offload.byMethod), staging: images.size + meshes.size }),
    relayStats: () => client?.stats(),
    authorityStats: () => authority?.stats,
    /** Hold provider->guest delivery (frames queue on the link). */
    holdDelivery(on: boolean) { held = on; },
    busy,
    /** Break and re-establish the relay session (the device reconnects). */
    async reconnect() {
      if (!client || !providerTransport) return;
      toGuest.length = 0;
      client.disconnect("rig: link lost");
      providerEndpoint!.handleDisconnect("rig: link lost");
      connection!.close();
      connection = authority!.connection(providerTransport.peer);
      providerEndpoint = new RelayEndpoint({ role: "provider", transport: providerTransport, local: providerCapabilities(), hooks: connection.hooks, scheduler: clocks.provider, randomBytes: seededBytes(0x51 + tick) });
      connection.bind(providerEndpoint);
      client.connect();
    },
    /** A reloaded host: a new service (new epoch); the authority re-reads
     * map.info through the factory and invalidates every namespace whose
     * revision moved. The previous service keeps answering replies that
     * were already in flight (the old worker draining), as a real reload
     * would. */
    async reload(nextEpoch: string) {
      epoch = nextEpoch;
      service = makeService(epoch); services.push(service);
      backend = holdableBackend(service, backendDelay); backends.push(backend);
      return authority!.refresh({ reload: true });
    },
    /** Textures/meshes materialized by this rig's model so far. */
    uploaded: () => ({ textures: host.texturesUploaded - uploadsBefore.textures, meshes: host.meshesUploaded - uploadsBefore.meshes }),
    dispose() { dispose(); io.dispose(); client?.disconnect("rig: dispose"); providerEndpoint?.close(); for (const s of services) s.close(); resetFrameHooks(); },
  };
}
