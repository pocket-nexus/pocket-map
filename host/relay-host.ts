/** The relay authority for Pocket Map: the same MapService the offload
 * worker runs (SQLite HTTP cache, atlas, decoders, rasterization stay in the
 * worker), exposed as resource.get on a relay stream per map namespace.
 *
 * Identity (draft §3.5): kind tile/texture/event, ns = map/<source> or the
 * control namespace map/catalog, key = z/x/y (labels: the JSON text pair;
 * search: the canonical query tuple), rendition = pixel/mesh/document
 * format, revision = the source's content revision (atlas revision, or the
 * OSM source hash extended by an operator epoch).
 *
 * A conditional get whose ifRevision equals the current revision is answered
 * notModified without touching the worker. A source whose revision moved is
 * announced with one namespace-scope INVALIDATE per *subscribed* stream
 * (§3.6: PUSH and INVALIDATE delivery is bound to an established
 * subscription; a stream that only opened gets nothing). §3.8 chooses
 * namespace scope: a source change touches every key, so key or revision
 * scope would need one frame per resident tile the authority does not know
 * about, while namespace scope is one reliable frame that moves the
 * generation of every key and fences every in-flight get.
 *
 * The catalog is the authority's own document: one refresh reads map.info
 * from the new backend, then swaps backend, source table and catalog in one
 * synchronous step, so a device never sees a map.info from one configuration
 * beside a namespace from another. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { RelayEndpoint, RelayIncomingRequest } from "@pocketjs/framework/relay/endpoint";
import type { RelayAuthoritySubscription } from "@pocketjs/framework/relay/resource";
import type { RelayLocalCapabilities, RelayOpenRequest, RelayPeerContext } from "@pocketjs/framework/relay/session";
import { RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, RELAY_INVALIDATE_SCOPE, type RelayResourceRef } from "@pocketjs/framework/relay/spec";
import { serveRelayTcp, type RelayProviderHooks } from "@pocketjs/framework/relay/wire";
import { CATALOG_NS, MAP_RELAY, OBJECT_BYTES, catalogRef, meshEnvelope, parseMapRef, namespaceFor, utf8Encode, type MapCatalog, type MapRefRequest } from "../shared/relay.ts";
import type { MapInfo, MapKind } from "../shared/types.ts";
import { dispatchMapCapability, type BackendReply, type BackendRequest } from "./capability.ts";
import type { MapService } from "./service.ts";

export type { BackendError, BackendReply, BackendRequest } from "./capability.ts";
export { dispatchMapCapability } from "./capability.ts";

/** Where capabilities execute: the offload worker module (thread or
 * process) in production, MapService in-process in tests. */
export interface MapBackend { call(request: BackendRequest): Promise<BackendReply>; close(): void | Promise<void> }
export interface MapSource { ns: string; kind: MapKind; source: string; revision: string; render?: "mesh"; info: MapInfo }
/** One refresh: `changed` is every namespace whose revision moved or that
 * left the table; `retired` is the subset the table no longer holds, which
 * receives no INVALIDATE and whose streams the guest frees on the catalog. */
export interface MapRefreshResult { changed: string[]; retired: string[]; sources: MapSource[]; catalog: MapCatalog }
export interface MapRelayConnection {
  hooks: RelayProviderHooks;
  /** The endpoint the wire adapter built for these hooks (onConnection). */
  bind(endpoint: RelayEndpoint): void;
  close(): void;
}
interface Connection { peer: RelayPeerContext; endpoint?: RelayEndpoint; streams: Map<string, number>; closed: boolean }

export const KINDS: readonly MapKind[] = ["hyrule", "osm"];

export function providerCapabilities(): RelayLocalCapabilities {
  return { versions: [[1, 0]], profiles: [{ ...MAP_RELAY.profile }], codecs: [...MAP_RELAY.codecs], kinds: [...MAP_RELAY.kinds], rxLimits: { ...MAP_RELAY.rxLimits } };
}

/** Tests and sims: capabilities run on the calling thread. */
export function inProcessBackend(service: MapService): MapBackend {
  return {
    call: request => dispatchMapCapability(service.methods(), request),
    close: () => service.close(),
  };
}

/** Production: the same worker module the offload provider runs
 * (host/worker.ts: `{init}` then one request per message), on a Worker
 * thread or, with the offload process shim, in a Bun subprocess. The relay
 * flag selects the coded dispatcher on the worker side. */
export function workerBackend(options: { worker: URL; data: unknown; isolation?: "thread" | "process"; deadlineMs?: number; log?: (message: string) => void }): MapBackend {
  const pending = new Map<number, { resolve: (reply: BackendReply) => void; timer: ReturnType<typeof setTimeout> }>();
  const deliver = (reply: BackendReply & { ready?: boolean }) => {
    if (!reply || reply.ready === true || !Number.isSafeInteger(reply.id)) return;
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id); clearTimeout(waiting.timer); waiting.resolve(reply);
  };
  const failAll = (code: string, message: string) => {
    for (const [id, waiting] of pending) { clearTimeout(waiting.timer); waiting.resolve({ id, error: { code, message } }); }
    pending.clear();
  };
  let post: (value: unknown) => void, terminate: () => void | Promise<unknown>;
  if (options.isolation === "process") {
    const shim = new URL("./offload-process.ts", import.meta.resolve("@pocketjs/framework/offload/provider"));
    const child = Bun.spawn([process.execPath, fileURLToPath(shim), options.worker.href], {
      stdin: "ignore", stdout: "inherit", stderr: "inherit", serialization: "advanced",
      ipc: reply => deliver(reply as BackendReply),
      onExit(_child, code, signal) { failAll(RELAY_ERROR.BUSY, `provider process exited (code=${code}, signal=${signal ?? "none"})`); },
    });
    options.log?.(`provider process pid=${child.pid}`);
    post = value => child.send(value);
    terminate = () => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); return child.exited; };
  } else {
    const thread = new Worker(options.worker, { type: "module" });
    thread.onmessage = event => deliver(event.data as BackendReply);
    thread.onerror = () => failAll(RELAY_ERROR.BUSY, "provider worker error");
    post = value => thread.postMessage(value);
    terminate = () => thread.terminate();
  }
  post({ init: options.data });
  return {
    call: request => new Promise(resolve => {
      const timer = setTimeout(() => { if (pending.delete(request.id)) resolve({ id: request.id, error: { code: RELAY_ERROR.DEADLINE, message: "Provider request deadline" } }); }, options.deadlineMs ?? 9000);
      timer.unref?.();
      pending.set(request.id, { resolve, timer });
      post({ v: 1, relay: 1, ...request });
    }),
    close() { failAll(RELAY_ERROR.BUSY, "provider closed"); return Promise.resolve(terminate()).then(() => undefined); },
  };
}

export interface MapRelayAuthorityOptions {
  /** Builds the backend; called on the first refresh and on reload. */
  backend: () => MapBackend | Promise<MapBackend>;
  kinds?: readonly MapKind[];
  log?: (message: string) => void;
  trace?: boolean;
}

/** The revision of the whole table: a device holding this value holds every
 * listed (kind, source, revision), so one conditional get confirms it. */
function catalogRevision(sources: readonly MapSource[]): string {
  const hash = createHash("sha256");
  for (const s of sources) hash.update(`${s.kind}\u0000${s.source}\u0000${s.revision}\u0000`);
  return hash.digest("hex").slice(0, 16);
}

export class MapRelayAuthority {
  private backend?: MapBackend;
  private sources = new Map<string, MapSource>();
  private catalog: MapCatalog = { v: 1, revision: catalogRevision([]), maps: [] };
  private connections = new Set<Connection>();
  private nextId = 1;
  readonly stats = { gets: 0, notModified: 0, objects: 0, errors: 0, refused: 0, cancelRequests: 0, cancelled: 0, evicts: 0, invalidates: 0, pushes: 0, opens: 0 };
  constructor(private readonly options: MapRelayAuthorityOptions) {}
  sourceList(): MapSource[] { return [...this.sources.values()]; }
  source(ns: string): MapSource | undefined { return this.sources.get(ns); }
  catalogDocument(): MapCatalog { return this.catalog; }
  connectionCount(): number { return this.connections.size; }

  /** (Re)build the source table from the backend's map.info. With `reload`
   * the backend is rebuilt first (a new worker with re-read configuration:
   * the host's SIGHUP); every map.info is read from that new backend before
   * anything is published, and backend, source table and catalog then move
   * together in one synchronous step. A changed or removed namespace is
   * invalidated on every subscribed stream, and every catalog subscription
   * receives the new document. */
  async refresh(options: { reload?: boolean } = {}): Promise<MapRefreshResult> {
    const rebuilt = !this.backend || options.reload === true;
    const backend = rebuilt ? await this.options.backend() : this.backend!;
    const next = new Map<string, MapSource>();
    for (const kind of this.options.kinds ?? KINDS) {
      const reply = await backend.call({ id: this.nextId++, method: "map.info", payload: JSON.stringify({ kind }) })
        .catch((error: unknown): BackendReply => ({ id: 0, error: { code: RELAY_ERROR.DEADLINE, message: String(error) } }));
      if (reply.error !== undefined || typeof reply.payload !== "string") continue;
      let info: MapInfo;
      try { info = JSON.parse(reply.payload); } catch { continue; }
      if (typeof info.source !== "string" || !/^[a-f0-9]{16}$/.test(info.source)) continue;
      const ns = namespaceFor(info.source);
      const revision = typeof info.revision === "string" && info.revision ? info.revision : info.source;
      next.set(ns, { ns, kind, source: info.source, revision, render: info.render, info: { ...info, kind, revision } });
    }
    const changed: string[] = [];
    for (const [ns, old] of this.sources) { const now = next.get(ns); if (!now || now.revision !== old.revision) changed.push(ns); }
    // The one publication step: after it no reader can observe the old
    // backend beside the new table, or the old table beside the new catalog.
    const retired = rebuilt ? this.backend : undefined;
    const previousCatalog = this.catalog.revision;
    this.backend = backend;
    this.sources = next;
    this.catalog = { v: 1, revision: catalogRevision([...next.values()]), maps: [...next.values()].map(s => s.info) };
    await retired?.close();
    // A namespace that left the table gets no INVALIDATE: the frame would
    // tell a device to refetch keys this authority now answers NOT_FOUND,
    // and the catalog below carries the replacement the device follows.
    for (const ns of changed) if (next.has(ns)) this.announceInvalidate(ns);
    if (this.catalog.revision !== previousCatalog) this.pushCatalog();
    return { changed, retired: changed.filter(ns => !next.has(ns)), sources: [...next.values()], catalog: this.catalog };
  }

  /** Active subscriptions of one connection whose filter names `ns`. */
  private subscriptionsFor(connection: Connection, ns: string): { stream: number; subscription: RelayAuthoritySubscription }[] {
    const stream = connection.streams.get(ns);
    const authority = connection.endpoint?.inspect()?.authority;
    if (stream === undefined || !authority || connection.closed) return [];
    return authority.subscriptionsOn(stream).filter(s => s.ns === ns).map(subscription => ({ stream, subscription }));
  }

  /** One INVALIDATE per subscribed stream, however many subscriptions that
   * stream holds: the scope is the namespace, so a second frame would move
   * the same generations again. */
  private announceInvalidate(ns: string): void {
    for (const connection of this.connections) {
      const bound = this.subscriptionsFor(connection, ns);
      if (!bound.length) continue;
      const stream = bound[0].stream;
      connection.endpoint!.invalidate({ stream, scope: RELAY_INVALIDATE_SCOPE.NAMESPACE, ns, reason: "source revision changed" });
      this.stats.invalidates++;
      this.options.log?.(`invalidated ${ns} on stream ${stream} for ${connection.peer.id}`);
    }
  }

  /** The catalog is a latest-snapshot subscription (§3.6): one PUSH carries
   * the whole new table, so a device whose namespace was replaced learns its
   * replacement on the stream it still holds. */
  private pushCatalog(): void {
    const data = utf8Encode(JSON.stringify(this.catalog));
    const ref = { ...catalogRef(), revision: this.catalog.revision };
    for (const connection of this.connections) {
      for (const { stream, subscription } of this.subscriptionsFor(connection, CATALOG_NS)) {
        const sent = connection.endpoint!.pushObject({ stream, subscription: subscription.id, ref, codec: RELAY_CODEC.JSON, data });
        if (sent.ok) { this.stats.pushes++; this.options.log?.(`pushed catalog ${this.catalog.revision} to ${connection.peer.id}`); }
        else this.stats.refused++;
      }
    }
  }

  /** Hooks for one relay connection; bind() the endpoint once the wire
   * adapter created it. */
  connection(peer: RelayPeerContext): MapRelayConnection {
    const connection: Connection = { peer, streams: new Map(), closed: false };
    const log = (message: string) => this.options.log?.(`${peer.id}: ${message}`);
    const hooks: RelayProviderHooks = {
      authorizeOpen: request => this.authorize(request),
      onStreamOpened: opened => { this.stats.opens++; connection.streams.set(opened.namespace, opened.stream); if (this.options.trace) log(`stream ${opened.stream} bound to ${opened.namespace}`); },
      onStreamReset: stream => { for (const [ns, s] of connection.streams) if (s === stream) connection.streams.delete(ns); },
      onGet: request => this.serve(connection, request),
      onCancel: () => { this.stats.cancelRequests++; },
      onEvict: () => { this.stats.evicts++; },
      onPhase: (phase, detail) => {
        if (this.options.trace || phase === "ready" || phase === "closed") log(`relay ${phase}${detail?.reason ? ` (${detail.reason})` : ""}`);
        if (phase === "closed" || phase === "idle") { connection.closed = true; this.connections.delete(connection); }
      },
      onProtocolError: (code, detail) => log(`protocol error ${code}${detail ? `: ${detail}` : ""}`),
    };
    this.connections.add(connection);
    return {
      hooks,
      bind: endpoint => { connection.endpoint = endpoint; },
      close: () => { connection.closed = true; this.connections.delete(connection); connection.endpoint?.close(); },
    };
  }

  private authorize(request: RelayOpenRequest): string | null {
    if (request.app !== MAP_RELAY.app) return RELAY_ERROR.UNAUTHORIZED;
    if (request.profile.name !== MAP_RELAY.profile.name || request.profile.version !== MAP_RELAY.profile.version) return RELAY_ERROR.UNSUPPORTED;
    if (request.namespace !== CATALOG_NS && !this.sources.has(request.namespace)) return RELAY_ERROR.NOT_FOUND;
    return null;
  }

  private serve(connection: Connection, request: RelayIncomingRequest): void {
    const endpoint = connection.endpoint;
    if (!endpoint || connection.closed) return;
    this.stats.gets++;
    const ref = request.metadata.resource as RelayResourceRef;
    const args = request.metadata.args as { accept: number[]; maxObjectBytes: number; ifRevision?: string };
    const catalog = ref.ns === CATALOG_NS;
    const source = catalog ? undefined : this.sources.get(ref.ns);
    if (!catalog && !source) { this.stats.refused++; endpoint.replyError(request, RELAY_ERROR.NOT_FOUND, "unknown map namespace"); return; }
    if (connection.streams.get(ref.ns) !== request.stream) { this.stats.refused++; endpoint.replyError(request, RELAY_ERROR.UNAUTHORIZED, "namespace is not bound to this stream"); return; }
    const parsed = parseMapRef(ref, source?.source ?? "");
    if (!parsed) { this.stats.refused++; endpoint.replyError(request, RELAY_ERROR.INVALID, "unknown map resource shape"); return; }
    const revision = catalog ? this.catalog.revision : source!.revision;
    // §3.6: a conditional get for the current revision is confirmed without
    // any provider work. Tiles are immutable within a revision, so the held
    // copy is current whenever the source revision is.
    if (args.ifRevision !== undefined && args.ifRevision === revision) {
      this.stats.notModified++;
      endpoint.replyNotModified(request, { ...ref, revision });
      return;
    }
    if (parsed.method === "map.catalog") {
      this.publish(connection, request, { ...ref, revision }, parsed, { id: 0, payload: JSON.stringify(this.catalog) });
      return;
    }
    const backend = this.backend;
    if (!backend) { this.stats.refused++; endpoint.replyError(request, RELAY_ERROR.BUSY, "provider is restarting"); return; }
    const id = this.nextId++;
    backend.call({ id, method: parsed.method, payload: parsed.payload, response: parsed.response })
      .catch((error: unknown): BackendReply => ({ id, error: { code: RELAY_ERROR.DEADLINE, message: error instanceof Error ? error.message : String(error) } }))
      .then(reply => this.answer(connection, request, ref, revision, parsed, reply));
  }

  private answer(connection: Connection, request: RelayIncomingRequest, ref: RelayResourceRef, revision: string, parsed: MapRefRequest, reply: BackendReply): void {
    const endpoint = connection.endpoint;
    if (!endpoint || connection.closed) return;
    // The canceller finished first: the one terminal is CANCELLED with
    // effect none; the object is not transferred (§3.6). A cancel that
    // arrives after the chunks entered the send queue lets the success
    // terminal stand.
    if (request.cancelRequested()) { this.stats.cancelled++; endpoint.replyError(request, RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE); return; }
    // The provider named its own §3.6 code; nothing here reads the message.
    if (reply.error !== undefined) { this.stats.errors++; endpoint.replyError(request, reply.error.code, reply.error.message); return; }
    this.publish(connection, request, { ...ref, revision }, parsed, reply);
  }

  private publish(connection: Connection, request: RelayIncomingRequest, stamped: RelayResourceRef, parsed: MapRefRequest, reply: BackendReply): void {
    const endpoint = connection.endpoint!;
    let object: { ref: RelayResourceRef; codec: number; data: Uint8Array; value?: Record<string, unknown> } | undefined;
    if (reply.image) {
      const image = reply.image;
      if (image.format === "r5g6b5" && image.pixels.length === image.width * image.height * 2) object = { ref: stamped, codec: RELAY_CODEC.R5G6B5LE, data: image.pixels, value: { width: image.width, height: image.height } };
    } else if (reply.mesh) {
      const envelope = meshEnvelope(reply.mesh.bytes);
      if (envelope) object = { ref: stamped, codec: RELAY_CODEC.PMH1, data: reply.mesh.bytes, value: { ...envelope } };
    } else if (typeof reply.payload === "string" && parsed.response === undefined) {
      object = { ref: stamped, codec: RELAY_CODEC.JSON, data: utf8Encode(reply.payload) };
    }
    if (!object) { this.stats.errors++; endpoint.replyError(request, RELAY_ERROR.INVALID, "provider reply does not match the resource"); return; }
    const sent = endpoint.replyObject(request, object);
    if (sent.ok) this.stats.objects++; else this.stats.refused++;
    if (this.options.trace) this.options.log?.(`${connection.peer.id}: ${parsed.method} ${stamped.key} -> ${sent.ok ? `${sent.frames} frame(s), ${object.data.length} bytes` : sent.code}`);
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections]) { connection.closed = true; connection.endpoint?.close(); }
    this.connections.clear();
    const backend = this.backend; this.backend = undefined;
    await backend?.close();
  }
}

/** The device presents the 64-hex pairing key before its HELLO (the offload
 * convention); the L0 adapter never trusts HELLO metadata for identity. Any
 * bytes after the key are pushed back for the relay record decoder. */
export function authenticatePairingKey(socket: Socket, key: string, timeoutMs = 5000): Promise<RelayPeerContext | null> {
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0), done = false;
    const finish = (peer: RelayPeerContext | null) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.off("data", onData);
      resolve(peer);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 64) return;
      socket.pause();
      const presented = buffer.subarray(0, 64), rest = buffer.subarray(64);
      const expected = Buffer.from(key);
      const accepted = presented.length === expected.length && timingSafeEqual(presented, expected);
      if (accepted && rest.length) socket.unshift(rest);
      // The wire adapter attaches its data listener right after this
      // resolves; the explicit pause survives that, so resume once it did.
      if (accepted) setTimeout(() => { if (!socket.destroyed) socket.resume(); }, 0);
      finish(accepted ? { id: `device:${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`, grants: [MAP_RELAY.app] } : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", onData);
    socket.once("close", () => finish(null));
    socket.once("error", () => finish(null));
  });
}

export interface MapRelayServer {
  authority: MapRelayAuthority;
  port: number;
  refresh(options?: { reload?: boolean }): Promise<MapRefreshResult>;
  close(): Promise<void>;
}

/** Listen for paired devices and serve every relay session from one
 * authority. The companion is the listener; the device dials it. */
export async function serveMapRelay(options: {
  key: string;
  backend: () => MapBackend | Promise<MapBackend>;
  port?: number;
  host?: string;
  kinds?: readonly MapKind[];
  log?: (message: string) => void;
  trace?: boolean;
}): Promise<MapRelayServer> {
  const authority = new MapRelayAuthority({ backend: options.backend, kinds: options.kinds, log: options.log, trace: options.trace });
  await authority.refresh();
  const pending: MapRelayConnection[] = [];
  const server = await serveRelayTcp({
    port: options.port ?? MAP_RELAY.port,
    host: options.host ?? "0.0.0.0",
    local: providerCapabilities(),
    authenticate: socket => authenticatePairingKey(socket, options.key),
    hooks: peer => { const connection = authority.connection(peer); pending.push(connection); return connection.hooks; },
    onConnection: connection => { pending.shift()?.bind(connection.endpoint); options.log?.(`relay connection from ${connection.peer.id}`); },
  });
  return {
    authority,
    port: server.port,
    refresh: refreshOptions => authority.refresh(refreshOptions),
    close: async () => { await server.close(); await authority.close(); },
  };
}

export { OBJECT_BYTES };
