import { RELAY_CODEC, RELAY_KIND, type RelayResourceRef, type RelayRxLimits } from "@pocketjs/framework/relay/spec";
import type { MarkerInput, MarkerLayer, TileInput } from "./types.ts";

/** The relay profile Pocket Map opens on its paired companion. Both ends
 * advertise the same receiver guarantees; negotiation takes min(local, peer),
 * so a device host may only shrink them (draft §3.2). A 256px R5G6B5 tile is
 * 131,072 bytes: three 65,536-byte frames, four assemblies of scratch. */
export const MAP_RELAY = Object.freeze({
  app: "pocket-map",
  profile: Object.freeze({ name: "map.tiles", version: 1 }),
  codecs: Object.freeze([RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.R5G6B5LE, RELAY_CODEC.PMH1]) as readonly number[],
  kinds: Object.freeze([RELAY_KIND.TILE, RELAY_KIND.TEXTURE]) as readonly number[],
  rxLimits: Object.freeze({
    maxWireBytes: 65536, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 262144,
    maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 4, maxScratchBytes: 524288,
  }) as RelayRxLimits,
  /** Request slots kept free for control and input (§3.9: two of eight). */
  requestReserve: 2,
  /** The companion listens here; the device dials it (offload uses 8741). */
  port: 8742,
});

/** Renditions bind codec, dimensions and renderer version (§3.5). The two
 * tile strings are the ones host/provider.ts already folds into `source`. */
export const RENDITION = Object.freeze({
  raster: "r5g6b5-v1",
  mesh: "mesh-shortbread-v1",
  label: "label-r5g6b5-256x32-v1",
  markers: (layer: MarkerLayer) => `markers-${layer}-v1`,
});
const MARKER_RENDITION = /^markers-(all|travel|collectibles|enemies|off)-v1$/;
const TILE_KEY = /^(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;
const SOURCE = /^[a-f0-9]{16}$/;

/** Assembled-object ceilings per rendition; the guest reserves scratch for
 * exactly these before a get is admitted (§3.7 reserve-then-accept). */
export const OBJECT_BYTES = Object.freeze({ raster: 131072, mesh: 36880, label: 16384, markers: 8192 });

/** ns = the map source (the 16-hex source hash the guest already carries in
 * every TileInput), never a kind name: two OSM configurations are two
 * namespaces, and a namespace-scope INVALIDATE names exactly one source. */
export const namespaceFor = (source: string) => `map/${source}`;
export function sourceOf(ns: string): string | undefined {
  const source = ns.startsWith("map/") ? ns.slice(4) : "";
  return SOURCE.test(source) ? source : undefined;
}

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

export interface MapRefRequest { method: "map.tile" | "map.mesh" | "map.markers" | "map.label"; payload: string; response?: "image" | "mesh" }
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
  return undefined;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) { const cp = ch.codePointAt(0)!; n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
  return n;
}
/** Bounded UTF-8 decode for JSON objects (markers); the guest realm has no
 * TextDecoder and the framework keeps its byte helpers private. Invalid
 * sequences decode to U+FFFD so JSON.parse reports the error, not this. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp: number, n: number;
    if (b < 0x80) { cp = b; n = 1; }
    else if ((b & 0xe0) === 0xc0) { cp = b & 0x1f; n = 2; }
    else if ((b & 0xf0) === 0xe0) { cp = b & 0x0f; n = 3; }
    else if ((b & 0xf8) === 0xf0) { cp = b & 0x07; n = 4; }
    else { out += "�"; i++; continue; }
    if (i + n > bytes.length) { out += "�"; break; }
    let valid = true;
    for (let k = 1; k < n; k++) { const c = bytes[i + k]; if ((c & 0xc0) !== 0x80) { valid = false; break; } cp = (cp << 6) | (c & 0x3f); }
    if (!valid) { out += "�"; i++; continue; }
    out += String.fromCodePoint(cp); i += n;
  }
  return out;
}
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
