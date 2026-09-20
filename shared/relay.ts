import { RELAY_CODEC, RELAY_ERROR, RELAY_KIND, RELAY_LIMITS, type RelayResourceRef, type RelayRxLimits } from "@pocketjs/framework/relay/spec";
import { RELAY_CHANNEL } from "@pocketjs/framework/relay/channel";
import type { MapInfo, MarkerInput, MarkerLayer, SearchInput, TileInput } from "./types.ts";

/** The relay profile Pocket Map opens on its paired companion. Both ends
 * advertise the same receiver guarantees; negotiation takes min(local, peer),
 * so a device host may only shrink them (draft §3.2). A 256px R5G6B5 tile is
 * 131,072 bytes: three 65,536-byte frames, four assemblies of scratch. On a
 * device the L0 lane carries 16,384-byte records, so the same tile is nine
 * frames; `relayRxLimits` shrinks the advertisement to the lane. */
export const MAP_RELAY = Object.freeze({
  app: "pocket-map",
  profile: Object.freeze({ name: "map.tiles", version: 1 }),
  codecs: Object.freeze([RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.R5G6B5LE, RELAY_CODEC.PMH1]) as readonly number[],
  kinds: Object.freeze([RELAY_KIND.TILE, RELAY_KIND.TEXTURE, RELAY_KIND.EVENT]) as readonly number[],
  /** The attachment window covers stream 0 plus three business streams: the
   * catalog and the two map sources the catalog can list (§3.2 caps a
   * session at eight streams; `streamWindow` divides this between them).
   * maxAssemblies/maxScratchBytes cover four concurrent objects
   * (4 x 131,072) plus those three push channels: the catalog (4,096) and
   * two map namespaces (8,192 each, the largest JSON window the profile
   * defines). 4 x 131072 + 4096 + 2 x 8192 = 544,768. */
  rxLimits: Object.freeze({
    maxWireBytes: 65536, maxMetaBytes: 2048, windowFrames: 16, windowBytes: 458752,
    maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 7, maxScratchBytes: 544768,
  }) as RelayRxLimits,
  /** Request slots kept free for control and input (§3.9: two of eight). */
  requestReserve: 2,
  /** The companion listens here; the device dials it (offload uses 8741). */
  port: RELAY_CHANNEL.port,
});

/** Receiver guarantees for one attachment. A device lane carries one record
 * per slot, so maxWireBytes drops to the lane's record size and the window
 * to what the host reserved; the object, assembly and scratch ceilings are
 * the guest's own budget and do not change with the lane. */
export function relayRxLimits(lane?: { maxWireBytes: number; windowFrames: number; windowBytes: number }): RelayRxLimits {
  if (!lane) return { ...MAP_RELAY.rxLimits };
  return {
    ...MAP_RELAY.rxLimits,
    maxWireBytes: Math.min(MAP_RELAY.rxLimits.maxWireBytes, lane.maxWireBytes),
    windowFrames: Math.min(MAP_RELAY.rxLimits.windowFrames, lane.windowFrames),
    windowBytes: Math.min(MAP_RELAY.rxLimits.windowBytes, lane.windowBytes),
  };
}

/** The per-stream receive window an OPEN asks for, derived from the
 * attachment so a device lane with a smaller window divides the same way
 * (the provider takes min(attachment, request) per field, §3.2).
 *
 * Stream 0 takes its control slice first; the catalog stream then takes one
 * frame and one document, and what remains is split between the two map
 * sources. Without this the first business stream takes the whole window
 * and the second OPEN has no slice left. */
export function streamWindow(attachment: RelayRxLimits, ns: string): RelayRxLimits {
  const controlFrames = Math.max(1, Math.min(RELAY_LIMITS.controlWindowFrames, Math.floor(attachment.windowFrames / 4)));
  const controlBytes = Math.max(1, Math.min(RELAY_LIMITS.controlWindowBytes, Math.floor(attachment.windowBytes / 4)));
  const catalogBytes = Math.min(OBJECT_BYTES.catalog * 2, Math.max(1, attachment.windowBytes - controlBytes));
  if (ns === CATALOG_NS) return { ...attachment, windowFrames: 1, windowBytes: catalogBytes };
  return {
    ...attachment,
    windowFrames: Math.max(1, Math.floor((attachment.windowFrames - controlFrames - 1) / 2)),
    windowBytes: Math.max(1, Math.floor((attachment.windowBytes - controlBytes - catalogBytes) / 2)),
  };
}

/** Renditions bind codec, dimensions and renderer version (§3.5). The two
 * tile strings are the ones host/provider.ts already folds into `source`. */
export const RENDITION = Object.freeze({
  raster: "r5g6b5-v1",
  mesh: "mesh-shortbread-v1",
  label: "label-r5g6b5-256x32-v1",
  search: "search-places-v1",
  catalog: "map-catalog-v1",
  markers: (layer: MarkerLayer) => `markers-${layer}-v1`,
});
const MARKER_RENDITION = /^markers-(all|travel|collectibles|enemies|off)-v1$/;
const TILE_KEY = /^(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;
const SOURCE = /^[a-f0-9]{16}$/;

/** Assembled-object ceilings per rendition; the guest reserves scratch for
 * exactly these before a get is admitted (§3.7 reserve-then-accept). */
export const OBJECT_BYTES = Object.freeze({ raster: 131072, mesh: 36880, label: 16384, markers: 8192, search: 8192, catalog: 4096 });

/** ns = the map source (the 16-hex source hash the guest already carries in
 * every TileInput), never a kind name: two OSM configurations are two
 * namespaces, and a namespace-scope INVALIDATE names exactly one source. */
export const namespaceFor = (source: string) => `map/${source}`;
export function sourceOf(ns: string): string | undefined {
  const source = ns.startsWith("map/") ? ns.slice(4) : "";
  return SOURCE.test(source) ? source : undefined;
}

/** The control namespace: one authority-owned document listing the installed
 * maps with their source and revision. It exists for as long as the authority
 * does, so a guest whose map namespace was replaced still has a stream to
 * learn the replacement on (the SIGHUP path). */
export const CATALOG_NS = "map/catalog";
export const CATALOG_KEY = "maps";
export const catalogRef = (): RelayResourceRef =>
  ({ kind: RELAY_KIND.EVENT, ns: CATALOG_NS, key: CATALOG_KEY, rendition: RENDITION.catalog });
/** The catalog document. `revision` moves whenever any listed map's source
 * or revision moves, so one conditional get confirms the whole table. */
export interface MapCatalog { v: 1; revision: string; maps: MapInfo[] }

/** key = z/x/y; the revision is never inside the key (§3.5 errata). */
export const tileRef = (input: TileInput, rendition: string): RelayResourceRef =>
  ({ kind: RELAY_KIND.TILE, ns: namespaceFor(input.source), key: `${input.z}/${input.x}/${input.y}`, rendition });
export const markerRef = (input: MarkerInput): RelayResourceRef =>
  ({ kind: RELAY_KIND.TILE, ns: namespaceFor(input.source), key: `${input.z}/${input.x}/${input.y}`, rendition: RENDITION.markers(input.layer) });
/** A label is a texture without spatial paging; its key is the rendered
 * text as a JSON pair (a `/` inside a name cannot alias two labels). */
export function labelRef(source: string, input: { name: string; detail: string }): RelayResourceRef {
  const key = JSON.stringify([input.name, input.detail]);
  if (utf8Length(key) > 256) throw new Error("Label exceeds the relay key bound");
  return { kind: RELAY_KIND.TEXTURE, ns: namespaceFor(source), key, rendition: RENDITION.label };
}
/** A place search is a query-scoped state snapshot of one source (kind 8,
 * §3.5): the key is the canonical query tuple, the coordinates already
 * rounded by the caller so two equal views share one cache entry. */
export function searchRef(input: SearchInput): RelayResourceRef {
  if (typeof input.source !== "string" || !SOURCE.test(input.source)) throw new Error("Search needs a map source");
  const key = searchKey(input);
  if (utf8Length(key) > 256) throw new Error("Search query exceeds the relay key bound");
  return { kind: RELAY_KIND.EVENT, ns: namespaceFor(input.source), key, rendition: RENDITION.search };
}
export const searchKey = (input: SearchInput): string => input.space === "planar"
  ? JSON.stringify(["planar", input.query, input.x, input.y])
  : JSON.stringify(["mercator", input.query, (input as { lat: number }).lat, (input as { lon: number }).lon]);

export interface MapRefRequest { method: "map.tile" | "map.mesh" | "map.markers" | "map.label" | "map.search" | "map.catalog"; payload: string; response?: "image" | "mesh" }
/** Authority side: a validated ResourceRef becomes one provider capability
 * call. Everything the provider validates itself (address range, source)
 * stays there; this only refuses shapes the profile does not define. */
export function parseMapRef(ref: RelayResourceRef, source: string): MapRefRequest | undefined {
  if (ref.kind === RELAY_KIND.TILE) {
    const m = TILE_KEY.exec(ref.key);
    if (!m) return undefined;
    const address = { source, z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
    if (ref.rendition === RENDITION.raster) return { method: "map.tile", payload: JSON.stringify(address), response: "image" };
    if (ref.rendition === RENDITION.mesh) return { method: "map.mesh", payload: JSON.stringify(address), response: "mesh" };
    const layer = MARKER_RENDITION.exec(ref.rendition)?.[1] as MarkerLayer | undefined;
    if (layer) return { method: "map.markers", payload: JSON.stringify({ ...address, layer }) };
    return undefined;
  }
  if (ref.kind === RELAY_KIND.TEXTURE && ref.rendition === RENDITION.label) {
    let pair: unknown;
    try { pair = JSON.parse(ref.key); } catch { return undefined; }
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") return undefined;
    return { method: "map.label", payload: JSON.stringify({ name: pair[0], detail: pair[1] }), response: "image" };
  }
  if (ref.kind === RELAY_KIND.EVENT && ref.rendition === RENDITION.search) {
    const input = parseSearchKey(ref.key, source);
    return input && { method: "map.search", payload: JSON.stringify(input) };
  }
  if (ref.kind === RELAY_KIND.EVENT && ref.rendition === RENDITION.catalog && ref.ns === CATALOG_NS && ref.key === CATALOG_KEY) {
    return { method: "map.catalog", payload: "{}" };
  }
  return undefined;
}

export function parseSearchKey(key: string, source: string): SearchInput | undefined {
  let tuple: unknown;
  try { tuple = JSON.parse(key); } catch { return undefined; }
  if (!Array.isArray(tuple) || tuple.length !== 4) return undefined;
  const [space, query, a, b] = tuple as [unknown, unknown, unknown, unknown];
  if (typeof query !== "string" || query.length === 0 || query.length > 80) return undefined;
  if (typeof a !== "number" || !Number.isFinite(a) || typeof b !== "number" || !Number.isFinite(b)) return undefined;
  if (space === "planar") return { space: "planar", query, source, x: a, y: b };
  if (space === "mercator") return { query, source, lat: a, lon: b };
  return undefined;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) { const cp = ch.codePointAt(0)!; n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
  return n;
}

/** A codec-1 object that is not one strict UTF-8 JSON value. The code is the
 * §3.6 error a caller acts on; the message is diagnostics only. */
export class MapDecodeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "MapDecodeError"; }
}

/** Strict UTF-8 decode for codec-1 data (draft §3.3/§3.4). The guest realm
 * has no TextDecoder and the framework keeps its byte helpers private, so
 * the checks are spelled out: a lead byte outside the four legal shapes, a
 * missing or malformed continuation, a truncated tail, an overlong encoding,
 * a UTF-16 surrogate code point and anything above U+10FFFF all throw. No
 * input produces U+FFFD: a replacement character would let malformed bytes
 * reach JSON.parse as a different, well-formed document. */
export function utf8DecodeStrict(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp: number, n: number, min: number;
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    else if ((b & 0xe0) === 0xc0) { cp = b & 0x1f; n = 2; min = 0x80; }
    else if ((b & 0xf0) === 0xe0) { cp = b & 0x0f; n = 3; min = 0x800; }
    else if ((b & 0xf8) === 0xf0) { cp = b & 0x07; n = 4; min = 0x10000; }
    else throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 lead byte 0x${b.toString(16)} at ${i}`);
    if (i + n > bytes.length) throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 truncated sequence at ${i}`);
    for (let k = 1; k < n; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 continuation byte 0x${c.toString(16)} at ${i + k}`);
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min) throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 overlong encoding of U+${cp.toString(16).toUpperCase()} at ${i}`);
    if (cp >= 0xd800 && cp <= 0xdfff) throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 surrogate code point U+${cp.toString(16).toUpperCase()} at ${i}`);
    if (cp > 0x10ffff) throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 code point above U+10FFFF at ${i}`);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

/** One strict UTF-8 JSON value (§3.4 codec 1), returned as its text so a
 * collection parses it once in materialize. A decode fault and a JSON fault
 * both raise MapDecodeError with a stable code, so a caller never
 * distinguishes them by message text. */
export function jsonTextStrict(bytes: Uint8Array): string {
  const text = utf8DecodeStrict(bytes);
  try { JSON.parse(text); }
  catch (error) { throw new MapDecodeError(RELAY_ERROR.INVALID, `codec 1 is not one JSON value: ${error instanceof Error ? error.message : "parse failed"}`); }
  return text;
}
export const jsonDecodeStrict = (bytes: Uint8Array): unknown => JSON.parse(jsonTextStrict(bytes));

export function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(utf8Length(s));
  let i = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out[i++] = cp;
    else if (cp < 0x800) { out[i++] = 0xc0 | (cp >> 6); out[i++] = 0x80 | (cp & 0x3f); }
    else if (cp < 0x10000) { out[i++] = 0xe0 | (cp >> 12); out[i++] = 0x80 | ((cp >> 6) & 0x3f); out[i++] = 0x80 | (cp & 0x3f); }
    else { out[i++] = 0xf0 | (cp >> 18); out[i++] = 0x80 | ((cp >> 12) & 0x3f); out[i++] = 0x80 | ((cp >> 6) & 0x3f); out[i++] = 0x80 | (cp & 0x3f); }
  }
  return out;
}

/** PMH1 mesh envelope (contracts/spec/offload.ts): 16-byte header with
 * magic, u16 width/height/vertices/triangles and a zero u32. */
export function meshEnvelope(bytes: Uint8Array): { width: number; height: number; bytes: number } | undefined {
  if (bytes.length < 16 || bytes.length > OBJECT_BYTES.mesh) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint16(4, true), height = v.getUint16(6, true), nv = v.getUint16(8, true), nt = v.getUint16(10, true);
  if (v.getUint32(0, true) !== 0x31484d50 || v.getUint32(12, true) || !width || !height || width > 4095 || height > 4095
    || nv > 4096 || nt > 2048 || bytes.length !== 16 + nv * 4 + nt * 10) return undefined;
  return { width, height, bytes: bytes.length };
}
