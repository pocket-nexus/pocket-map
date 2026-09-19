import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import type { RelayPhase, RelayRandomBytes, RelayScheduler, RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { relayResourceKey } from "@pocketjs/framework/relay/resource";
import { RELAY_CODEC, RELAY_ERROR, RELAY_OP, RELAY_TYPE, type RelayResourceRef } from "@pocketjs/framework/relay/spec";
import type { ResourceLoad, ResourceResult } from "@pocketjs/framework/resource-cache";
import type { ResourceCollectionOptions, createResourceRuntime } from "@pocketjs/framework/resource-view";
import type { MeshResource, TextureResource } from "@pocketjs/framework/resource";
import { getOps } from "@pocketjs/framework/host";
import { resourcePacks } from "@pocketjs/framework/resource-pack";
import { MAP_RELAY, OBJECT_BYTES, meshEnvelope, utf8Decode } from "../shared/relay.ts";

/** One published relay object as the collections see it: the concrete
 * revision on the ref, the assembled bytes, the authority's value. */
export interface RelayObject { ref: RelayResourceRef; data: Uint8Array; value?: unknown }
export interface RelayInvalidation { scope: string; ns: string; ref?: RelayResourceRef; reason?: string }
export interface RelayMapClientOptions {
  /** The authenticated byte channel to the companion (draft §3.1 L0). The
   * owner of the channel calls connect()/handleRecord()/disconnect(). */
  transport: RelayTransportAdapter;
  scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes;
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
  onPhase?: (phase: RelayPhase, detail?: { reason?: string }) => void;
}
export type RelayMapClient = ReturnType<typeof createRelayMapClient>;

const TRANSIENT_OPEN = new Set<string>(["BUSY", "BAD_STATE", "NOT_READY"]);

/** The guest side of the map relay: one composed endpoint, one stream per
 * map namespace, gets with the held revision as ifRevision, CANCEL on
 * withdrawal, and a bounded staging table so a collection materializes from
 * a small ticket string (as it does from a native offload ticket). It owns
 * no residence: the resource collections keep the entry budget. */
export function createRelayMapClient(options: RelayMapClientOptions) {
  const stats = {
    sessions: 0, opens: 0, gets: 0, busy: 0, refused: 0, cancels: 0, objects: 0, notModified: 0, errors: 0,
    invalidates: 0, evicts: 0, protocolErrors: 0, framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, staged: 0, peakStaged: 0,
    /** Published objects the scheduler released without materializing (a late or replaced result). */
    dropped: 0,
    /** Objects that arrived after the collection withdrew interest (the CANCEL lost the race, §3.6). */
    discarded: 0,
    errorCodes: {} as Record<string, number>,
  };
  let generation = 0, ready = false;
  const streams = new Map<string, number>(), opening = new Set<string>(), refused = new Map<string, string>();
  /** Held revision per local identity, kept while a collection holds the
   * value (noteRevision on materialize, evict on dispose): the ifRevision of
   * the next get, across relay sessions. Bounded by resident entries. */
  const revisions = new Map<string, string>();
  const staging = new Map<number, Uint8Array>();
  let nextToken = 1;
  const listeners = new Set<(event: RelayInvalidation) => void>();
  const transport: RelayTransportAdapter = {
    peer: options.transport.peer,
    trySend(bytes) {
      const status = options.transport.trySend(bytes);
      if (status === "accepted") { stats.framesOut++; stats.bytesOut += bytes.length; }
      return status;
    },
  };
  const endpoint = new RelayEndpoint({
    role: "guest",
    transport,
    local: {
      app: MAP_RELAY.app, versions: [[1, 0]], profiles: [{ ...MAP_RELAY.profile }],
      codecs: [...MAP_RELAY.codecs], kinds: [...MAP_RELAY.kinds], rxLimits: { ...MAP_RELAY.rxLimits },
    },
    requestReserve: MAP_RELAY.requestReserve,
    scheduler: options.scheduler, randomBytes: options.randomBytes,
    pingIntervalMs: options.pingIntervalMs, stallMs: options.stallMs, retryMs: options.retryMs,
    hooks: {
      onPhase(phase, detail) {
        if (phase === "ready") { ready = true; generation++; stats.sessions++; }
        else if (phase === "closed" || phase === "idle") { ready = false; streams.clear(); opening.clear(); refused.clear(); }
        options.onPhase?.(phase, detail);
      },
      onStreamReset(stream) { for (const [ns, s] of streams) if (s === stream) streams.delete(ns); },
      onProtocolError() { stats.protocolErrors++; },
    },
  });

  /** The stream bound to a namespace, opening it on first use. Undefined
   * while the session or the OPEN is not there yet (the loader declines and
   * the scheduler retries next frame); a refused namespace throws so the
   * entry fails visibly instead of retrying forever. */
  function streamFor(ns: string): number | undefined {
    const open = streams.get(ns);
    if (open !== undefined) return open;
    if (!ready || opening.has(ns)) return undefined;
    const code = refused.get(ns);
    if (code) throw new Error(`Relay namespace refused: ${code}`);
    opening.add(ns);
    const session = generation;
    stats.opens++;
    endpoint.open({ app: MAP_RELAY.app, namespace: ns, profile: { ...MAP_RELAY.profile } }).then(
      result => { if (generation === session && ready) streams.set(ns, result.stream); },
      (error: unknown) => {
        const code = typeof error === "string" ? error : String((error as { message?: string })?.message ?? error);
        if (generation === session && !TRANSIENT_OPEN.has(code)) refused.set(ns, code);
      },
    ).finally(() => opening.delete(ns));
    return undefined;
  }

  /** resource.get for one identity. Returns false when the request cannot be
   * admitted now (no session/stream yet, window or scratch full: BUSY); the
   * resource scheduler keeps the demand and retries on a later frame. */
  function get(ref: RelayResourceRef, args: { accept: number[]; maxObjectBytes: number },
    complete: (result: ResourceResult<RelayObject>) => void): { cancel(): void } | false {
    const stream = streamFor(ref.ns);
    if (stream === undefined) return false;
    const started = endpoint.get(stream, ref, { accept: args.accept, maxObjectBytes: args.maxObjectBytes, ifRevision: revisions.get(relayResourceKey(ref)) }, result => {
      if (!result.ok) {
        stats.errors++;
        const code = (result.error as { code?: string } | undefined)?.code ?? "unknown";
        stats.errorCodes[code] = (stats.errorCodes[code] ?? 0) + 1;
        complete({ ok: false, error: result.error }); return;
      }
      if (!("value" in result)) { complete(result); return; }
      if ("notModified" in result.value) { stats.notModified++; complete({ ok: true, revalidated: true }); return; }
      stats.objects++;
      complete({ ok: true, value: { ref: result.value.ref, data: result.value.data, value: result.value.value } });
    });
    if ("correlation" in started) {
      stats.gets++;
      const correlation = started.correlation;
      // Withdrawing interest is a CANCEL on the sideband; the provider
      // answers the one terminal (CANCELLED, or the object if it was already
      // in flight) and the request slot frees when it is consumed (§3.6).
      return { cancel() { stats.cancels++; endpoint.cancel(correlation, "view"); } };
    }
    if (started.code === RELAY_ERROR.BUSY) { stats.busy++; return false; }
    stats.refused++;
    throw new Error(`Relay get refused: ${started.code}`);
  }

  function decodeInvalidation(bytes: Uint8Array): RelayInvalidation | undefined {
    const decoded = decodeFrame(bytes, { maxWireBytes: MAP_RELAY.rxLimits.maxWireBytes, maxMetaBytes: MAP_RELAY.rxLimits.maxMetaBytes });
    if (!decoded.ok || decoded.frame.metadata.op !== RELAY_OP.RESOURCE_INVALIDATE) return undefined;
    const args = decoded.frame.metadata.args as { scope?: unknown; namespace?: unknown; reason?: unknown } | undefined;
    const ref = decoded.frame.metadata.resource as RelayResourceRef | undefined;
    const ns = ref?.ns ?? (typeof args?.namespace === "string" ? args.namespace : undefined);
    if (!ns || typeof args?.scope !== "string") return undefined;
    return { scope: args.scope, ns, ref, reason: typeof args.reason === "string" ? args.reason : undefined };
  }

  return {
    endpoint,
    stats: () => ({ ...stats, errorCodes: { ...stats.errorCodes }, phase: endpoint.phase, streams: streams.size, pending: endpoint.inspect()?.requests.active ?? 0 }),
    connected: () => ready,
    /** Positive relay connection generation while READY, like offload's session(). */
    session: () => (ready ? generation : 0),
    get phase(): RelayPhase { return endpoint.phase; },
    /** The channel is up: start the §3.2 handshake. */
    connect() { if (endpoint.phase === "idle") endpoint.hello(); },
    /** The channel dropped: every pending get fails RESYNC_REQUIRED and the
     * per-session machines are discarded; connect() starts a new session. */
    disconnect(reason: string) { endpoint.handleDisconnect(reason); },
    /** One complete wire record from the channel. Authority INVALIDATEs are
     * observed here (after the endpoint applied them) so the model can mark
     * its collections stale; a frame the session drops is not reported. */
    handleRecord(bytes: Uint8Array) {
      stats.framesIn++; stats.bytesIn += bytes.length;
      const invalidation = ready && bytes.length > 48 && bytes[10] === RELAY_TYPE.INVALIDATE ? decodeInvalidation(bytes) : undefined;
      endpoint.handleRecord(bytes);
      if (invalidation && ready) { stats.invalidates++; for (const listener of listeners) listener(invalidation); }
    },
    onInvalidate(listener: (event: RelayInvalidation) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get,
    /** Bounded staging: a published object waits here between the transport
     * callback and the frame that materializes it. Every ticket is taken
     * once or released by the collection, so the table holds at most the
     * in-flight results of the scheduler. */
    stage(bytes: Uint8Array): number {
      const token = nextToken++;
      staging.set(token, bytes); stats.staged = staging.size; stats.peakStaged = Math.max(stats.peakStaged, staging.size);
      return token;
    },
    take(token: number): Uint8Array | undefined { const bytes = staging.get(token); staging.delete(token); stats.staged = staging.size; return bytes; },
    release(token: number) { if (staging.delete(token)) stats.dropped++; stats.staged = staging.size; },
    discard() { stats.discarded++; },
    noteRevision(ref: RelayResourceRef, revision: string) { revisions.set(relayResourceKey(ref), revision); },
    /** A collection disposed its value: forget the held revision and advise
     * the provider (cache.evict, no ACK; tiles need no lease, §3.8). */
    evict(ref: RelayResourceRef) {
      revisions.delete(relayResourceKey(ref));
      if (ready) { stats.evicts++; endpoint.reportEvict(ref, "budget"); }
    },
    heldRevision: (ref: RelayResourceRef) => revisions.get(relayResourceKey(ref)),
  };
}

type ImageTicket = { local: true; ticket: string } | { local: false; token: number; width: number; height: number; revision?: string };
type MeshTicket = { token: number; width: number; height: number; revision?: string };
type Owned<T> = T & { ref?: RelayResourceRef };

function uploadPixels(pixels: Uint8Array, width: number, height: number): number {
  const ops = getOps();
  if (!ops.uploadImgEntry) throw new Error("Host does not implement uploadImgEntry");
  // IMG entry (framework/compiler/pak.ts): u16 w, u16 h, u8 psm (PSM_5650),
  // u8 flags (IMG_FLAG_LINEAR, as the sim uploads offload tiles), u16 zero.
  const blob = new Uint8Array(8 + pixels.length);
  const view = new DataView(blob.buffer);
  view.setUint16(0, width, true); view.setUint16(2, height, true); blob[4] = 0; blob[5] = 2;
  blob.set(pixels, 8);
  const handle = ops.uploadImgEntry(blob);
  if (handle < 0) throw new Error("Image upload credit unavailable");
  return handle;
}

/** Images over relay with the offload/pack collection's lifecycle: the same
 * per-entry reservation (native staging, old + new core/GPU copies, upload
 * scratch, ticket), the same demand/retry/eviction; only the loader differs
 * (resource.get with the held revision, CANCEL on withdrawal, revalidated
 * on notModified). An optional SD pack is read first, as the packed
 * collection does; the relay is its fallback. */
export function createRelayImageCollection<I>(
  runtime: ReturnType<typeof createResourceRuntime>,
  client: RelayMapClient,
  options: Omit<ResourceCollectionOptions<I, string, TextureResource>, "load" | "materialize" | "dispose" | "releaseResponse" | "maxResponseBytes" | "cost" | "maxCost"> & {
    ref(input: I): RelayResourceRef;
    /** Maximum rendition envelope; the object must fit it exactly in R5G6B5. */
    width: number;
    height: number;
    pack?(input: I): { name: string; entry: number } | undefined;
    materialized?(storage: "local" | "desktop"): void;
  },
) {
  for (const n of [options.width, options.height])
    if (!Number.isInteger(n) || n < 16 || n > 256 || n & (n - 1)) throw new Error("Invalid image collection dimensions");
  const cost = options.width * options.height * 18 + 512;
  const maxObjectBytes = options.width * options.height * 2;
  const local = options.pack ? resourcePacks() : undefined;
  const absent = new Set<string>();
  let packGeneration = local?.session() ?? 0;
  return runtime.createCollection<I, string, Owned<TextureResource>>({
    ...options,
    maxResponseBytes: 512,
    cost: () => cost,
    maxCost: options.maxEntries * cost,
    load(input, complete) {
      const pack = options.pack?.(input);
      if (local && local.session() !== packGeneration) { packGeneration = local.session(); absent.clear(); }
      let cancelled = false, cancel: (() => void) | undefined;
      const relay = (): boolean => {
        const started = client.get(options.ref(input), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes }, result => {
          if (cancelled) { if (result.ok && "value" in result) client.discard(); return; }
          if (!result.ok || !("value" in result)) { complete(result); return; }
          const { ref, data } = result.value;
          const size = (result.value.value ?? {}) as { width?: unknown; height?: unknown };
          const width = typeof size.width === "number" ? size.width : options.width;
          const height = typeof size.height === "number" ? size.height : options.height;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > options.width || height < 1 || height > options.height || data.length !== width * height * 2) {
            complete({ ok: false, error: "Relay image does not match its envelope" }); return;
          }
          const ticket: ImageTicket = { local: false, token: client.stage(data), width, height, revision: ref.revision };
          complete({ ok: true, value: JSON.stringify(ticket) });
        });
        if (!started) return false;
        cancel = started.cancel;
        return true;
      };
      if (local?.connected() && pack && !absent.has(pack.name)) {
        if (!/^[a-z0-9-]{1,48}$/.test(pack.name) || !Number.isInteger(pack.entry) || pack.entry < 0 || pack.entry >= 65536) throw new Error("Invalid resource pack address");
        const id = local.requestImage("pack.read", `${pack.name}/${pack.entry}`, result => {
          if (cancelled) return;
          if (result.ok) { const ticket: ImageTicket = { local: true, ticket: result.value }; complete({ ok: true, value: JSON.stringify(ticket) }); return; }
          if (result.error === "Resource pack not installed") {
            if (absent.size === 4) absent.delete(absent.values().next().value!);
            absent.add(pack.name);
          }
          let fell = false;
          try { fell = relay(); } catch (error) { complete({ ok: false, error }); return; }
          if (!fell) complete(result);
        });
        if (!id) return false;
        cancel = () => local.cancel(id);
      } else if (!relay()) return false;
      return { cancel() { cancelled = true; cancel?.(); } };
    },
    materialize(raw, input) {
      const ticket = JSON.parse(raw) as ImageTicket;
      if (ticket.local) {
        if (!local) throw new Error("Invalid pack response owner");
        const native = JSON.parse(ticket.ticket) as { width: number; height: number };
        if (native.width > options.width || native.height > options.height) throw new Error("Image exceeds collection envelope");
        const value = local.uploadImage(ticket.ticket);
        try { options.materialized?.("local"); } catch (error) { getOps().freeTexture?.(value.handle); throw error; }
        return value;
      }
      const bytes = client.take(ticket.token);
      if (!bytes) throw new Error("Relay image staging was released");
      const handle = uploadPixels(bytes, ticket.width, ticket.height);
      try { options.materialized?.("desktop"); } catch (error) { getOps().freeTexture?.(handle); throw error; }
      const ref = options.ref(input);
      if (ticket.revision) client.noteRevision(ref, ticket.revision);
      return { handle, width: ticket.width, height: ticket.height, ref };
    },
    releaseResponse(raw) {
      const ticket = JSON.parse(raw) as ImageTicket;
      if (ticket.local) local?.releaseImage(ticket.ticket);
      else client.release(ticket.token);
    },
    dispose(value) {
      getOps().freeTexture?.(value.handle);
      if (value.ref) client.evict(value.ref);
    },
  });
}

/** Prepared geometry over relay: the offload mesh collection's reservation
 * (staging, old/new native records, retained VBOs) with a relay loader. */
export function createRelayMeshCollection<I>(
  runtime: ReturnType<typeof createResourceRuntime>,
  client: RelayMapClient,
  options: Omit<ResourceCollectionOptions<I, string, MeshResource>, "load" | "materialize" | "dispose" | "releaseResponse" | "maxResponseBytes" | "cost" | "maxCost"> & {
    ref(input: I): RelayResourceRef;
  },
) {
  const cost = 131088 + 2 * (4096 * 4 + 2048 * 12 + 2048 * 3 * 32 + 512);
  return runtime.createCollection<I, string, Owned<MeshResource>>({
    ...options,
    maxResponseBytes: 512,
    cost: () => cost,
    maxCost: options.maxEntries * cost,
    load(input, complete) {
      let cancelled = false;
      const started = client.get(options.ref(input), { accept: [RELAY_CODEC.PMH1], maxObjectBytes: OBJECT_BYTES.mesh }, result => {
        if (cancelled) { if (result.ok && "value" in result) client.discard(); return; }
        if (!result.ok || !("value" in result)) { complete(result); return; }
        const envelope = meshEnvelope(result.value.data);
        if (!envelope) { complete({ ok: false, error: "Relay mesh has an invalid envelope" }); return; }
        const ticket: MeshTicket = { token: client.stage(result.value.data), width: envelope.width, height: envelope.height, revision: result.value.ref.revision };
        complete({ ok: true, value: JSON.stringify(ticket) });
      });
      if (!started) return false;
      return { cancel() { cancelled = true; started.cancel(); } };
    },
    materialize(raw, input) {
      const ticket = JSON.parse(raw) as MeshTicket;
      const bytes = client.take(ticket.token);
      if (!bytes) throw new Error("Relay mesh staging was released");
      const ops = getOps();
      if (!ops.uploadMesh) throw new Error("Host does not implement uploadMesh");
      const handle = ops.uploadMesh(bytes);
      if (handle < 0) throw new Error("Mesh staging or frame upload credit unavailable");
      const ref = options.ref(input);
      if (ticket.revision) client.noteRevision(ref, ticket.revision);
      return { handle, width: ticket.width, height: ticket.height, ref };
    },
    releaseResponse(raw) { client.release((JSON.parse(raw) as MeshTicket).token); },
    dispose(value) {
      getOps().freeMesh?.(value.handle);
      if (value.ref) client.evict(value.ref);
    },
  });
}

/** A bounded JSON resource (marker windows) over relay: codec 1 bytes,
 * decoded once the complete object passed its digest, parsed by the
 * collection's own materialize. No revision is held for these, so a get
 * never asks ifRevision and never sees a revalidation. */
export function relayJsonLoad<I>(client: RelayMapClient, ref: (input: I) => RelayResourceRef, maxObjectBytes: number): ResourceLoad<I, string> {
  return (input, complete) => client.get(ref(input), { accept: [RELAY_CODEC.JSON], maxObjectBytes }, result => {
    if (!result.ok || !("value" in result)) { complete(result); return; }
    if (result.value.data.length > maxObjectBytes) { complete({ ok: false, error: "Relay object exceeds budget" }); return; }
    complete({ ok: true, value: utf8Decode(result.value.data) });
  });
}
