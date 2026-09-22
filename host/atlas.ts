import { invalid, notFound } from "../shared/failure.ts";
import { Database } from "bun:sqlite";
import { inflateRawSync } from "node:zlib";
import { existsSync } from "node:fs";
import { MarkerIndex } from "./markers.ts";
import { join } from "node:path";
import type { OffloadImage } from "@pocketjs/framework/offload/provider";
import { Bookmarks } from "./bookmarks.ts";
import { renderLabel } from "./provider.ts";
import { validPosition, type MapInfo, type Place, type SearchInput, type TileInput, type MarkerInput } from "../shared/types.ts";

import { ATLAS_FORMAT } from "./atlas-format.ts";
export { HYRULE_REVISION, ATLAS_FORMAT } from "./atlas-format.ts";
export interface AtlasManifest { format: string; revision: string; tiles: number; places: number; info: MapInfo }

/** The installed atlas is complete and immutable. Reads never fall through to
 * a network provider; user bookmarks live in a different SQLite database. */
export class AtlasProvider {
  readonly info: MapInfo;
  readonly bookmarks: Bookmarks;
  private db: Database;
  private markers?: MarkerIndex;
  private images = new Map<string, OffloadImage>();
  private reads = 0;
  private hits = 0;
  constructor(directory: string) {
    this.db = new Database(join(directory, "atlas.sqlite"), { readonly: true });
    const row = this.db.query("SELECT value FROM metadata WHERE key='manifest'").get() as { value: string } | null;
    const manifest: AtlasManifest | undefined = row ? JSON.parse(row.value) : undefined;
    if (!manifest || manifest.format !== ATLAS_FORMAT || manifest.tiles !== 21845 || manifest.info.space !== "planar") {
      this.db.close(); throw new Error("Incomplete Hyrule atlas; run bun run prepare:hyrule");
    }
    if (existsSync(join(directory, "markers.sqlite"))) this.markers = new MarkerIndex(join(directory, "markers.sqlite"));
    // The atlas revision (the pinned upstream map revision) is the relay
    // content revision of every tile in this namespace; a rebuilt atlas is a
    // new revision and invalidates resident guest tiles through one
    // namespace-scope INVALIDATE.
    this.info = { ...manifest.info, revision: manifest.revision || manifest.info.source, markers: !!this.markers };
    this.bookmarks = new Bookmarks(join(directory, "places.sqlite"));
  }
  methods() { return {
    "map.info": () => JSON.stringify(this.info),
    "map.markers": (raw: string) => JSON.stringify(this.markerRows(JSON.parse(raw))),
    "map.tile": (raw: string) => this.tile(JSON.parse(raw)),
    "map.search": (raw: string) => JSON.stringify(this.search(JSON.parse(raw))),
    "map.label": (raw: string) => renderLabel(JSON.parse(raw)),
    "bookmarks.list": (raw: string) => JSON.stringify(this.bookmarks.list(JSON.parse(raw).offset)),
    "bookmarks.command": (raw: string) => this.bookmarks.command(JSON.parse(raw)),
  }; }
  tile(input: TileInput): OffloadImage {
    const { source, z, x, y } = input;
    if (source !== this.info.source || ![z, x, y].every(Number.isInteger) || z < 0 || z > 7 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw invalid("Invalid atlas tile");
    const key = `${z}/${x}/${y}`, hit = this.images.get(key);
    if (hit) { this.hits++; this.images.delete(key); this.images.set(key, hit); return hit; }
    const row = this.db.query("SELECT pixels FROM tiles WHERE z=? AND x=? AND y=?").get(z, x, y) as { pixels: Uint8Array } | null;
    if (!row) throw notFound("Missing installed atlas tile");
    const pixels = new Uint8Array(inflateRawSync(row.pixels, { maxOutputLength: 131072 }));
    if (pixels.length !== 131072) throw invalid("Invalid atlas pixels");
    const image: OffloadImage = { width: 256, height: 256, format: "r5g6b5", pixels };
    this.reads++; this.images.set(key, image);
    if (this.images.size > 128) this.images.delete(this.images.keys().next().value!);
    return image;
  }
  search(input: SearchInput): Place[] {
    if (!input || typeof input.query !== "string" || input.query.length > 80 || !validPosition(input) || input.space !== "planar") throw invalid("Invalid atlas search");
    const words = input.query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8);
    if (!words?.length) return [];
    const match = words.map(word => `"${word}"*`).join(" AND ");
    const rows = this.db.query(`SELECT id,name,detail,x,y,zoom FROM place_search WHERE place_search MATCH ?
      ORDER BY rank, ((x-?)*(x-?)+(y-?)*(y-?)) LIMIT 5`).all(match, input.x, input.x, input.y, input.y) as Omit<Extract<Place, { space: "planar" }>, "space">[];
    return rows.map(row => ({ ...row, space: "planar" }));
  }
  markerRows(input: MarkerInput) { if (input.source !== this.info.source) throw notFound("Unknown marker source"); return this.markers?.query(input) ?? []; }
  diagnostics() { return { atlasReads: this.reads, memoryHits: this.hits, downloads: 0 }; }
  close() { this.markers?.close(); this.db.close(); this.bookmarks.close(); }
}
