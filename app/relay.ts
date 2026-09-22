import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import type { RelayPhase, RelayRandomBytes, RelayScheduler, RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { relayResourceKey } from "@pocketjs/framework/relay/resource";
import { RELAY_CODEC, RELAY_DELIVERY, RELAY_ERROR, RELAY_OP, RELAY_TYPE, type RelayResourceRef, type RelayRxLimits } from "@pocketjs/framework/relay/spec";
import type { ResourceLoad, ResourceResult } from "@pocketjs/framework/resource-cache";
import type { ResourceCollectionOptions, createResourceRuntime } from "@pocketjs/framework/resource-view";
import type { MeshResource, TextureResource } from "@pocketjs/framework/resource";
import { getOps } from "@pocketjs/framework/host";
import { resourcePacks } from "@pocketjs/framework/resource-pack";
import { CATALOG_NS, MAP_RELAY, MapDecodeError, OBJECT_BYTES, catalogRef, jsonTextStrict, meshEnvelope, namespaceFor, relayRxLimits, streamWindow, type MapCatalog } from "../shared/relay.ts";
import type { MapInfo } from "../shared/types.ts";

/** One published relay object as the collections see it: the concrete
 * revision on the ref, the assembled bytes, the authority's value. */
export interface RelayObject { ref: RelayResourceRef; data: Uint8Array; value?: unknown }
export interface RelayInvalidation { scope: string; ns: string; ref?: RelayResourceRef; reason?: string }
/** Every relay failure a collection sees names a §3.6 code. The message is
 * diagnostics; no caller branches on its text. */
export interface RelayFailure { code: string; message?: string }
export const relayFailure = (code: string, message?: string): RelayFailure => ({ code, message });
export interface RelayMapClientOptions {
  /** The authenticated byte channel to the companion (draft §3.1 L0). The
   * owner of the channel calls connect()/handleRecord()/disconnect(). */
  transport: RelayTransportAdapter;
  /** Receiver guarantees to advertise; a device lane shrinks maxWireBytes
   * and the window to what its host reserved (shared/relay.ts). */
  rxLimits?: RelayRxLimits;
  scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes;
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
  onPhase?: (phase: RelayPhase, detail?: { reason?: string }) => void;
}
export type RelayMapClient = ReturnType<typeof createRelayMapClient>;

const TRANSIENT_OPEN = new Set<string>([RELAY_ERROR.BUSY, "BAD_STATE", "NOT_READY"]);
/** The catalog document the authority publishes; anything else is refused
 * before it can reach installInfo. */
function validCatalog(value: unknown): value is MapCatalog {
  const c = value as MapCatalog | undefined;
  return !!c && c.v === 1 && typeof c.revision === "string" && /^[a-f0-9]{16}$/.test(c.revision)
    && Array.isArray(c.maps) && c.maps.length <= 4
    && c.maps.every(m => !!m && typeof (m as MapInfo).source === "string");
}

/** The guest side of the map relay: one composed endpoint, one stream per
 * map namespace with one latest-snapshot subscription on it, gets with the
 * held revision as ifRevision, CANCEL on withdrawal, and a bounded staging
 * table so a collection materializes from a small ticket string (as it does
 * from a native offload ticket). It owns no residence: the resource
 * collections keep the entry budget. */
export function createRelayMapClient(options: RelayMapClientOptions) {
  const rxLimits = options.rxLimits ?? relayRxLimits();
  const stats = {
    sessions: 0, opens: 0, subscribes: 0, gets: 0, busy: 0, refused: 0, cancels: 0, objects: 0, notModified: 0, errors: 0,
    invalidates: 0, pushes: 0, evicts: 0, protocolErrors: 0, framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, staged: 0, peakStaged: 0,
    /** Published objects the scheduler released without materializing (a late or replaced result). */
    dropped: 0,
    /** Objects that arrived after the collection withdrew interest (the CANCEL lost the race, §3.6). */
    discarded: 0,
    /** Catalog documents refused by validCatalog or strict decoding. */
    badCatalog: 0,
    errorCodes: {} as Record<string, number>,
    /** Namespace bindings refused, by §3.6 code: a transient code is retried
     * on a later frame, anything else marks the namespace refused. */
    bindRefusals: {} as Record<string, number>,
    /** Streams reset because the catalog stopped naming their namespace. */
    retired: 0,
  };
  let generation = 0, bindingGeneration = 0, ready = false, catalogStale = true;
  /** A namespace is usable once its stream carries an established
   * subscription: §3.6 binds INVALIDATE delivery to a subscription, so a get
   * admitted before it could miss the fence that invalidates it. */
  const streams = new Map<string, { stream: number; subscription: number }>();
  const binding = new Set<string>(), refused = new Map<string, string>();
  /** The namespaces the accepted catalog names, plus the control namespace;
   * undefined until the first document arrives. Anything outside it is
   * retired: the authority answers NOT_FOUND there, and the attachment
   * window the replacement namespace needs is the slice the retired stream
   * holds. */
  let live: Set<string> | undefined;
  const isLive = (ns: string) => ns === CATALOG_NS || live === undefined || live.has(ns);
  /** Held revision per local identity, kept while a collection holds the
   * value (noteRevision on materialize, evict on dispose): the ifRevision of
   * the next get, across relay sessions. Bounded by resident entries. */
  const revisions = new Map<string, string>();
  const staging = new Map<number, Uint8Array>();
  let nextToken = 1;
  const listeners = new Set<(event: RelayInvalidation) => void>();
  const catalogListeners = new Set<(catalog: MapCatalog) => void>();
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
      codecs: [...MAP_RELAY.codecs], kinds: [...MAP_RELAY.kinds], rxLimits,
    },
    requestReserve: MAP_RELAY.requestReserve,
    scheduler: options.scheduler, randomBytes: options.randomBytes,
    pingIntervalMs: options.pingIntervalMs, stallMs: options.stallMs, retryMs: options.retryMs,
    hooks: {
      onPhase(phase, detail) {
        if (phase === "ready") { ready = true; generation++; stats.sessions++; }
        else if (phase === "closed" || phase === "idle") {
          // Fence callbacks at teardown, before the next READY. Rejecting
          // an old OPEN schedules a microtask that can run during HELLO.
          bindingGeneration++;
          ready = false; streams.clear(); binding.clear(); refused.clear(); live = undefined; catalogStale = true;
        }
        options.onPhase?.(phase, detail);
      },
      onStreamReset(stream) { for (const [ns, s] of streams) if (s.stream === stream) streams.delete(ns); },
      onProtocolError() { stats.protocolErrors++; },
    },
  });

  /** Free one namespace's stream: relay.reset fails its pending gets, ends
   * its subscription and returns its slice of the attachment window, and
   * the receiver drops whatever the peer already sent on it. Bounded by the
   * live streams this end opened, which §3.2 caps at eight at a time. */
  function retire(ns: string): void {
    const bound = streams.get(ns);
    streams.delete(ns);
    refused.delete(ns);
    if (bound === undefined) return;
    stats.retired++;
    endpoint.resetStream(bound.stream, "namespace retired");
  }

  /** One accepted catalog document is the authority's whole source table:
   * a namespace it stopped naming was replaced or removed, so its stream
   * retires here, before the listeners install the new source and demand
   * tiles from it. */
  function acceptCatalog(catalog: MapCatalog): void {
    const next = new Set<string>([CATALOG_NS]);
    for (const map of catalog.maps) next.add(namespaceFor(map.source));
    live = next;
    for (const ns of [...streams.keys()]) if (!next.has(ns)) retire(ns);
    for (const ns of [...refused.keys()]) if (!next.has(ns)) refused.delete(ns);
    catalogStale = false;
    for (const listener of catalogListeners) listener(catalog);
  }

  function deliverCatalog(data: Uint8Array): void {
    let catalog: unknown;
    try { catalog = JSON.parse(jsonTextStrict(data)); }
    catch { stats.badCatalog++; return; }
    if (!validCatalog(catalog)) { stats.badCatalog++; return; }
    acceptCatalog(catalog);
  }

  /** Bind a namespace: OPEN, then one latest-snapshot subscription on the
   * stream. Undefined while either is outstanding (the loader declines and
   * the scheduler retries next frame); a refused namespace throws so the
   * entry fails visibly instead of retrying forever. */
  function streamFor(ns: string): number | undefined {
    const bound = streams.get(ns);
    if (bound !== undefined) return bound.stream;
    // A namespace the catalog no longer names: no stream is opened for it,
    // so a demand the model has not dropped yet costs no window slice.
    if (!ready || binding.has(ns) || !isLive(ns)) return undefined;
    const code = refused.get(ns);
    if (code) throw new Error(`Relay namespace refused: ${code}`);
    binding.add(ns);
    const session = bindingGeneration;
    // Endpoint unbind invokes subscription callbacks before onPhase above.
    // Check its phase too, so none can mutate map state during teardown.
    const current = () => bindingGeneration === session && ready && endpoint.phase === "ready";
    stats.opens++;
    endpoint.open({ app: MAP_RELAY.app, namespace: ns, profile: { ...MAP_RELAY.profile }, rxLimits: streamWindow(rxLimits, ns) }).then(
      result => {
        if (!current()) return;
        // The catalog retired the namespace while the OPEN was in flight:
        // give the slice back instead of subscribing to a dead source.
        if (!isLive(ns)) { binding.delete(ns); stats.retired++; endpoint.resetStream(result.stream, "namespace retired"); return; }
        stats.subscribes++;
        const started = endpoint.subscribe(result.stream, { ns }, RELAY_DELIVERY.LATEST_SNAPSHOT, {
          onObject(object) {
            if (!current()) return;
            stats.pushes++;
            if (object.ref.ns === CATALOG_NS) deliverCatalog(object.data);
          },
          onEnd() { if (current() && streams.get(ns)?.stream === result.stream) streams.delete(ns); },
        }, outcome => {
          if (!current()) return;
          binding.delete(ns);
          if (!isLive(ns)) { stats.retired++; endpoint.resetStream(result.stream, "namespace retired"); return; }
          if (outcome.ok && "value" in outcome && typeof outcome.value.subscription === "number") {
            streams.set(ns, { stream: result.stream, subscription: outcome.value.subscription });
            return;
          }
          const failed = (outcome as { error?: { code?: string } }).error?.code ?? RELAY_ERROR.BUSY;
          stats.bindRefusals[failed] = (stats.bindRefusals[failed] ?? 0) + 1;
          if (failed === RELAY_ERROR.NOT_FOUND) catalogStale = true;
          if (!TRANSIENT_OPEN.has(failed)) refused.set(ns, failed);
        }, { maxObjectBytes: ns === CATALOG_NS ? OBJECT_BYTES.catalog : OBJECT_BYTES.markers });
        if (!("correlation" in started)) {
          if (!current()) return;
          binding.delete(ns);
          stats.bindRefusals[started.code] = (stats.bindRefusals[started.code] ?? 0) + 1;
          if (!TRANSIENT_OPEN.has(started.code)) refused.set(ns, started.code);
        }
      },
      (error: unknown) => {
        // This callback may outlive both disconnect and the replacement
        // binding. It owns no state in a newer generation, including the
        // binding marker, catalog freshness and permanent refusal table.
        if (!current()) return;
        binding.delete(ns);
        const code = typeof error === "string" ? error : String((error as { message?: string })?.message ?? error);
        stats.bindRefusals[code] = (stats.bindRefusals[code] ?? 0) + 1;
        if (code === RELAY_ERROR.NOT_FOUND) catalogStale = true;
        if (!TRANSIENT_OPEN.has(code)) refused.set(ns, code);
      },
    );
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
        // The authority no longer knows this namespace: the source moved
        // under us and the catalog this end holds is the stale half.
        if (code === RELAY_ERROR.NOT_FOUND && ref.ns !== CATALOG_NS) catalogStale = true;
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
    stats: () => ({ ...stats, errorCodes: { ...stats.errorCodes }, bindRefusals: { ...stats.bindRefusals }, phase: endpoint.phase, streams: streams.size, pending: endpoint.inspect()?.requests.active ?? 0 }),
    connected: () => ready,
    /** Positive relay connection generation while READY, like offload's session(). */
    session: () => (ready ? generation : 0),
    get phase(): RelayPhase { return endpoint.phase; },
    /** The channel is up: start the §3.2 handshake. */
    connect() { if (endpoint.phase === "idle") endpoint.hello(); },
    /** End of one lane frame: retry whatever the lane refused earlier. A
     * device lane admits a fixed number of records per frame, so a busy
     * outbox needs this edge to drain when nothing is arriving. */
    step() { endpoint.flush(); },
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
      // §3.6 binds INVALIDATE delivery to a subscription: a frame for a
      // namespace whose stream this end retired names a source the
      // authority no longer serves, and the endpoint dropped it with the
      // stream. It reaches no listener here either.
      if (invalidation && ready && streams.has(invalidation.ns)) { stats.invalidates++; for (const listener of listeners) listener(invalidation); }
    },
    onInvalidate(listener: (event: RelayInvalidation) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Catalog snapshots: the answer to the first get and every later PUSH
     * the authority sends on the catalog subscription. */
    onCatalog(listener: (catalog: MapCatalog) => void) { catalogListeners.add(listener); return () => { catalogListeners.delete(listener); }; },
    /** One conditional get of the catalog. False means the namespace is not
     * bound yet and the caller should retry on a later frame; a resolved
     * result with `catalog` absent is a notModified. */
    requestCatalog(complete: (result: { ok: true; catalog?: MapCatalog } | { ok: false; error: RelayFailure }) => void): boolean {
      const ref = catalogRef();
      const started = get(ref, { accept: [RELAY_CODEC.JSON], maxObjectBytes: OBJECT_BYTES.catalog }, result => {
        if (!result.ok) { complete({ ok: false, error: toFailure(result.error) }); return; }
        if (!("value" in result)) { catalogStale = false; complete({ ok: true }); return; }
        let catalog: unknown;
        try { catalog = JSON.parse(jsonTextStrict(result.value.data)); }
        catch (error) { stats.badCatalog++; complete({ ok: false, error: toFailure(error) }); return; }
        if (!validCatalog(catalog)) { stats.badCatalog++; complete({ ok: false, error: relayFailure(RELAY_ERROR.INVALID, "catalog document") }); return; }
        if (result.value.ref.revision) revisions.set(relayResourceKey(ref), result.value.ref.revision);
        acceptCatalog(catalog);
        complete({ ok: true, catalog });
      });
      return started !== false;
    },
    /** True until a catalog document has been accepted on this session, and
     * again once the authority answers NOT_FOUND for a map namespace: the
     * source table this end holds no longer matches the authority's. */
    catalogStale: () => catalogStale,
    /** The catalog revision this end holds, so a namespace change forces a
     * fresh document rather than a notModified. */
    forgetCatalog() { revisions.delete(relayResourceKey(catalogRef())); catalogStale = true; },
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

/** Any failure a relay path reports, as a code the caller acts on. A
 * MapDecodeError already carries one; a framework error carries `code`;
 * anything else is an unclassified local fault. */
export function toFailure(error: unknown): RelayFailure {
  if (error instanceof MapDecodeError) return relayFailure(error.code, error.message);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") return relayFailure(code, (error as { message?: string }).message);
  return relayFailure(RELAY_ERROR.INVALID, error instanceof Error ? error.message : String(error));
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
            complete({ ok: false, error: relayFailure(RELAY_ERROR.INVALID, "relay image does not match its envelope") }); return;
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
          try { fell = relay(); } catch (error) { complete({ ok: false, error: toFailure(error) }); return; }
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
        if (!envelope) { complete({ ok: false, error: relayFailure(RELAY_ERROR.INVALID, "relay mesh has an invalid envelope") }); return; }
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

/** A bounded JSON resource (marker windows, place searches) over relay:
 * codec 1 bytes, decoded as one strict UTF-8 JSON value once the complete
 * object passed its digest (§3.4), then parsed by the collection's own
 * materialize. A malformed object fails the entry with the §3.6 code, never
 * with a replacement character that would parse as a different document. */
export function relayJsonLoad<I>(client: RelayMapClient, ref: (input: I) => RelayResourceRef, maxObjectBytes: number): ResourceLoad<I, string> {
  return (input, complete) => client.get(ref(input), { accept: [RELAY_CODEC.JSON], maxObjectBytes }, result => {
    if (!result.ok || !("value" in result)) { complete(result); return; }
    if (result.value.data.length > maxObjectBytes) { complete({ ok: false, error: relayFailure(RELAY_ERROR.TOO_LARGE, "relay object exceeds budget") }); return; }
    let text: string;
    try { text = jsonTextStrict(result.value.data); }
    catch (error) { complete({ ok: false, error: toFailure(error) }); return; }
    complete({ ok: true, value: text });
  });
}
