import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { OffloadImage, OffloadMesh } from "@pocketjs/framework/offload/provider";
import { prepareVector, labelsInWindow, type PreparedTile } from "./vector-geometry.ts";
import { HttpCache, type NetworkFetch } from "./cache.ts";
import { Bookmarks } from "./bookmarks.ts";
import { join, dirname } from "node:path";
import type { MapInfo, Place, SearchInput, TileInput } from "../shared/types.ts";

import type { ProviderConfig } from "./config.ts";
export { defaultConfig, type ProviderConfig } from "./config.ts";
export function packRGB(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): OffloadImage {
  if (rgba.byteLength !== width * height * 4) throw new Error("Invalid pixel plane");
  const pixels = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    const r = Math.round(rgba[i * 4] * alpha + 255 * (1 - alpha));
    const g = Math.round(rgba[i * 4 + 1] * alpha + 255 * (1 - alpha));
    const b = Math.round(rgba[i * 4 + 2] * alpha + 255 * (1 - alpha));
    const rgb = (r >> 3) | ((g >> 2) << 5) | ((b >> 3) << 11);
    pixels[i * 2] = rgb & 255;
    pixels[i * 2 + 1] = rgb >> 8;
  }
  return { width, height, pixels, format: "r5g6b5" };
}
export class MapProvider {
  readonly info: MapInfo;
  readonly cache: HttpCache;
  readonly bookmarks: Bookmarks;
  private decoded = new Map<string, { image: OffloadImage; expires: number }>();
  private loading = new Map<string, Promise<OffloadImage>>();
  private vectors = new Map<string, { value: PreparedTile; expires: number }>();
  private preparing = new Map<string, Promise<PreparedTile>>();
  private meshBytes = 0;
  private decodedHits = 0;
  private preparedHits = 0;
  private searching = false;
  private nextSearch = 0;
  constructor(
    readonly config: ProviderConfig,
    network: NetworkFetch = fetch,
  ) {
    for (const url of [config.tileURL, config.searchURL])
      if (new URL(url).protocol !== "https:" && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
        throw new Error("Use HTTPS or a local provider");
    if (
      !["{z}", "{x}", "{y}"].every((part) => config.tileURL.includes(part)) ||
      !Number.isInteger(config.maxZoom) ||
      config.maxZoom < 1 ||
      config.maxZoom > 18
    )
      throw new Error("Invalid tile source");
    if (
      config.format === "vector" &&
      (!Number.isInteger(config.dataZoom ?? 14) || (config.dataZoom ?? 14) < 0 || (config.dataZoom ?? 14) > 14)
    )
      throw new Error("Invalid vector source zoom");
    const rendition = config.format === "vector" ? "mesh-shortbread-v1" : "r5g6b5-v1";
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    this.info = {
      source: sha([config.tileURL, rendition]),
      // Relay revision (draft §3.5): the source identity extended by the
      // operator epoch. A resident guest tile revalidates with ifRevision and
      // is re-transferred only when this value moved.
      revision: sha([config.tileURL, rendition, config.revision ?? ""]),
      name: config.name.slice(0, 40),
      attribution: config.attribution.slice(0, 100),
      maxZoom: config.maxZoom,
      ...(config.format === "vector"
        ? {
            render: "mesh" as const,
            dataZoom: config.dataZoom ?? 14,
            markers: true,
            prefetch: new URL(config.tileURL).hostname !== "vector.openstreetmap.org",
          }
        : {}),
    };
    this.cache = new HttpCache(config.cache, network);
    this.bookmarks = new Bookmarks(
      config.cache === ":memory:" ? ":memory:" : join(dirname(config.cache), "places.sqlite"),
    );
  }
  methods() {
    return {
      "map.info": () => JSON.stringify(this.info),
      "map.mesh": (raw: string) => this.mesh(JSON.parse(raw)),
      "map.markers": async (raw: string) => JSON.stringify(await this.markerRows(JSON.parse(raw))),
      "map.tile": (raw: string) => this.tile(JSON.parse(raw)),
      "map.search": async (raw: string) => JSON.stringify(await this.search(JSON.parse(raw))),
      "map.label": (raw: string) => this.label(JSON.parse(raw)),
      "bookmarks.list": (raw: string) => JSON.stringify(this.bookmarks.list(JSON.parse(raw).offset)),
      "bookmarks.command": (raw: string) => this.bookmarks.command(JSON.parse(raw)),
    };
  }
  tile(input: TileInput): Promise<OffloadImage> {
    if (this.config.format === "vector") return Promise.reject(new Error("Use map.mesh for this vector source"));
    const { source, z, x, y } = input;
    if (
      source !== this.info.source ||
      ![z, x, y].every(Number.isInteger) ||
      z < 0 ||
      z > this.config.maxZoom ||
      x < 0 ||
      x >= 2 ** z ||
      y < 0 ||
      y >= 2 ** z
    )
      return Promise.reject(new Error("Invalid tile address or source"));
    const key = `${z}/${x}/${y}`,
      hit = this.decoded.get(key);
    if (hit && hit.expires > Date.now()) {
      this.decodedHits++;
      this.decoded.delete(key);
      this.decoded.set(key, hit);
      return Promise.resolve(hit.image);
    }
    const pending = this.loading.get(key);
    if (pending) return pending;
    if (this.loading.size >= 3) return Promise.reject(new Error("Tile decode budget exhausted"));
    const url = this.config.tileURL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    const work = this.decode(url)
      .then((image) => {
        this.decoded.set(key, { image, expires: this.cache.expires(url) });
        if (this.decoded.size > 64) this.decoded.delete(this.decoded.keys().next().value!);
        return image;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, work);
    return work;
  }
  private vector(input: TileInput): Promise<PreparedTile> {
    const { source, z, x, y } = input;
    if (
      this.config.format !== "vector" ||
      source !== this.info.source ||
      ![z, x, y].every(Number.isInteger) ||
      z < 0 ||
      z > (this.config.dataZoom ?? 14) ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** z ||
      y >= 2 ** z
    )
      return Promise.reject(new Error("Invalid vector tile address or source"));
    const key = `${z}/${x}/${y}`,
      hit = this.vectors.get(key);
    if (hit && hit.expires > Date.now()) {
      this.preparedHits++;
      this.vectors.delete(key);
      this.vectors.set(key, hit);
      return Promise.resolve(hit.value);
    }
    const pending = this.preparing.get(key);
    if (pending) return pending;
    if (this.preparing.size >= 3) return Promise.reject(new Error("Vector preparation budget exhausted"));
    const url = this.config.tileURL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    const work = this.cache
      .get(url, { maxBytes: 2 * 1024 * 1024, ttl: 7 * 86400_000 })
      .then((bytes) => {
        const value = prepareVector(bytes, z);
        this.meshBytes += value.mesh.bytes.length;
        this.vectors.set(key, { value, expires: this.cache.expires(url) });
        if (this.vectors.size > 128) this.vectors.delete(this.vectors.keys().next().value!);
        return value;
      })
      .finally(() => this.preparing.delete(key));
    this.preparing.set(key, work);
    return work;
  }
  async mesh(input: TileInput): Promise<OffloadMesh> {
    return (await this.vector(input)).mesh;
  }
  async markerRows(input: TileInput & { layer?: string }) {
    if (this.config.format !== "vector" || input.layer === "off") return [];
    if (
      ![input.z, input.x, input.y].every(Number.isInteger) ||
      input.z < 0 ||
      input.z > this.info.maxZoom ||
      input.x < 0 ||
      input.y < 0 ||
      input.x >= 2 ** input.z ||
      input.y >= 2 ** input.z
    )
      throw new Error("Invalid label window");
    const dataZoom = Math.min(input.z, this.config.dataZoom ?? 14),
      factor = 2 ** (input.z - dataZoom),
      x = Math.floor(input.x / factor),
      y = Math.floor(input.y / factor);
    const tile = await this.vector({ ...input, z: dataZoom, x, y }),
      scale = 2 ** dataZoom,
      size = 256 / factor;
    const labels = labelsInWindow(tile, input.z, (input.x % factor) * size, (input.y % factor) * size, size);
    return labels.map((l, i) => [
      input.y * 2 ** input.z * 16 + input.x * 16 + i,
      l.name,
      "landmark",
      (x * 256 + l.x) / scale,
      (y * 256 + l.y) / scale,
    ]);
  }

  private async decode(url: string) {
    const bytes = await this.cache.get(url, { maxBytes: 512 * 1024, ttl: 7 * 86400_000 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < 24 ||
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(12) !== 0x49484452 ||
      view.getUint32(16) !== 256 ||
      view.getUint32(20) !== 256
    )
      throw new Error("Expected a 256px PNG tile");
    const image = await loadImage(Buffer.from(bytes));
    if (image.width !== 256 || image.height !== 256) throw new Error("Invalid decoded tile size");
    const canvas = createCanvas(256, 256),
      ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return packRGB(ctx.getImageData(0, 0, 256, 256).data, 256, 256);
  }
  async search(input: SearchInput): Promise<Place[]> {
    if (
      input.space === "planar" ||
      typeof input.query !== "string" ||
      input.query.length > 80 ||
      !Number.isFinite(input.lat) ||
      Math.abs(input.lat) > 90 ||
      !Number.isFinite(input.lon) ||
      Math.abs(input.lon) > 180
    )
      throw new Error("Invalid place search");
    const query = input.query.trim();
    if (!query) return [];
    if (this.searching) throw new Error("A search is already running");
    this.searching = true;
    try {
      // Explicit submits only, at most one outgoing search per second.
      await Bun.sleep(Math.max(0, this.nextSearch - Date.now()));
      this.nextSearch = Date.now() + 1100;
      const url = new URL(this.config.searchURL);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "5");
      url.searchParams.set("lang", "en");
      url.searchParams.set("lat", input.lat.toFixed(1));
      url.searchParams.set("lon", input.lon.toFixed(1));
      const bytes = await this.cache.get(url.toString(), { maxBytes: 64 * 1024, ttl: 86400_000 });
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(result.features)) throw new Error("Invalid search response");
      const seen = new Set<string>(),
        places: Place[] = [];
      for (const feature of result.features.slice(0, 5)) {
        const p = feature.properties,
          xy = feature.geometry?.coordinates;
        if (
          !p ||
          typeof p.name !== "string" ||
          !Array.isArray(xy) ||
          !xy.slice(0, 2).every(Number.isFinite) ||
          Math.abs(xy[0]) > 180 ||
          Math.abs(xy[1]) > 90
        )
          continue;
        const id = `${String(p.osm_type).slice(0, 1)}${String(p.osm_id).slice(0, 20)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const detail = [
          ...new Set([p.street, p.city, p.state, p.country].filter((n) => typeof n === "string" && n !== p.name)),
        ]
          .join(", ")
          .slice(0, 60);
        places.push({
          id,
          name: p.name.slice(0, 36),
          detail,
          lon: xy[0],
          lat: xy[1],
          zoom: ["city", "town", "village", "state", "country"].includes(p.type) ? (p.type === "country" ? 5 : 13) : 16,
        });
      }
      return places;
    } finally {
      this.searching = false;
    }
  }
  label(input: { name: string; detail: string }) {
    return renderLabel(input);
  }
  diagnostics() {
    return {
      httpHits: this.cache.hits,
      downloads: this.cache.downloads,
      decodedHits: this.decodedHits,
      preparedHits: this.preparedHits,
      meshBytes: this.meshBytes,
      prepared: this.vectors.size,
    };
  }
  close() {
    this.cache.close();
    this.bookmarks.close();
  }
}

export function renderLabel(input: { name: string; detail: string }) {
  if (
    typeof input.name !== "string" ||
    input.name.length > 80 ||
    typeof input.detail !== "string" ||
    input.detail.length > 120
  )
    throw new Error("Invalid label");
  const canvas = createCanvas(256, 32),
    c = canvas.getContext("2d");
  c.fillStyle = "#f7f9fc";
  c.fillRect(0, 0, 256, 32);
  const family = /[\u3000-\u9fff]/.test(input.name + input.detail)
    ? '"Hiragino Sans GB", "Noto Sans CJK SC", sans-serif'
    : "Arial, sans-serif";
  c.fillStyle = "#263748";
  c.font = `bold 13px ${family}`;
  c.fillText(input.name, 5, 13, 246);
  c.fillStyle = "#627387";
  c.font = `11px ${family}`;
  c.fillText(input.detail, 5, 28, 246);
  return packRGB(c.getImageData(0, 0, 256, 32).data, 256, 32);
}
