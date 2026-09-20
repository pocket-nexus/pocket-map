import { invalid } from "../shared/failure.ts";
import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HYRULE_REVISION } from "./atlas-format.ts";
import { MARKER_KINDS, type MarkerInput, type MapMarker, type MarkerKind } from "../shared/types.ts";

const VERSION = `markers-v1/${HYRULE_REVISION}`;
const classify = (file: string, group: string): MarkerKind => file === "seeds" ? "seed" : file === "treasures" ? "treasure"
  : group === "Sheikah Tower" ? "tower" : group === "Shrine" ? "shrine" : group === "Stable" ? "stable"
  : /Village|Settlement|Lab/.test(group) ? "village" : /Talus|Hinox|Lynel|Molduga|Guardian/.test(group) ? "enemy"
  : /Memory|Fairy|Statue/.test(group) ? "special" : "landmark";

/** A separate small index can be refreshed without rebaking 592 MB of pixels. */
export async function prepareMarkers(directory: string, source: string) {
  const output = join(directory, "markers.sqlite");
  if (existsSync(output)) {
    const old = new Database(output, { readonly: true });
    const row = old.query("SELECT version,count FROM metadata").get() as { version: string; count: number } | null; old.close();
    if (row?.version === VERSION) return row.count;
  }
  const pending = join(directory, "markers.build.sqlite"); if (existsSync(pending)) rmSync(pending);
  const db = new Database(pending);
  db.exec(`CREATE TABLE metadata(version TEXT,count INTEGER);
    CREATE TABLE markers(id INTEGER PRIMARY KEY,name TEXT,kind TEXT,x REAL,y REAL,minZoom INTEGER,maxZoom INTEGER,priority INTEGER);
    CREATE VIRTUAL TABLE bounds USING rtree(id,x0,x1,y0,y1);`);
  const insert = db.query("INSERT INTO markers VALUES (?,?,?,?,?,?,?,?)"), bounds = db.query("INSERT INTO bounds VALUES (?,?,?,?,?)");
  let count = 0; const seen = new Set<string>();
  try {
    for (const file of ["locations", "pins", "seeds", "treasures"]) {
      const groups = await Bun.file(join(source, `markers/${file}.json`)).json();
      db.transaction(() => {
        for (const group of groups) for (const layer of group.layers ?? []) for (const marker of layer.markers ?? []) {
          if (!Array.isArray(marker.coords) || marker.coords.length !== 2 || !marker.coords.every(Number.isFinite)) continue;
          const [north, east] = marker.coords, x = (east + 12000) / 24000 * 256, y = (12000 - north) / 24000 * 256;
          if (x < 0 || x >= 256 || y < 0 || y >= 256) continue;
          const kind = classify(file, group.name), label = marker.name ?? `${kind === "seed" ? "Korok" : group.name} ${marker.id ?? ""}`;
          const name = String(label).replace(/<[^>]+>/g, "").replace(/[^\x20-\x7e]/g, "'").slice(0, 24);
          const key = `${kind}/${x}/${y}/${name}`; if (seen.has(key)) continue; seen.add(key);
          const min = group.name === "Region" ? 0 : group.name === "Subregion" ? 2 : kind === "tower" ? 2
            : kind === "seed" || kind === "treasure" ? 6 : kind === "enemy" ? 5 : kind === "landmark" ? 4 : 3;
          const max = group.name === "Region" ? 2 : group.name === "Subregion" ? 4 : 7;
          const priority = kind === "tower" ? 0 : kind === "village" ? 1 : kind === "shrine" ? 2 : kind === "stable" ? 3 : kind === "landmark" ? 4 : 5;
          insert.run(++count, name, kind, x, y, min, max, priority); bounds.run(count, x, x, y, y);
        }
      })();
    }
    db.query("INSERT INTO metadata VALUES (?,?)").run(VERSION, count); db.close(); renameSync(pending, output); return count;
  } catch (error) { db.close(); throw error; }
}
export class MarkerIndex {
  private db: Database;
  constructor(path: string) { this.db = new Database(path, { readonly: true }); }
  query(input: MarkerInput): MapMarker[] {
    const { z, x, y, layer } = input, cells = Math.max(1, 2 ** (z - 1));
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 7 || x < 0 || y < 0 || x >= cells || y >= cells || !["all", "travel", "collectibles", "enemies", "off"].includes(layer)) throw invalid("Invalid marker window");
    if (layer === "off") return [];
    const kinds = layer === "travel" ? ["tower", "shrine", "stable", "village", "landmark", "special"] : layer === "collectibles" ? ["seed", "treasure", "special"] : layer === "enemies" ? ["enemy"] : MARKER_KINDS;
    const size = 512 / 2 ** z, x0 = x * size, y0 = y * size;
    const rows = this.db.query(`SELECT m.id,m.name,m.kind,m.x,m.y FROM bounds b JOIN markers m ON m.id=b.id
      WHERE b.x1>=? AND b.x0<? AND b.y1>=? AND b.y0<? AND m.x>=? AND m.x<? AND m.y>=? AND m.y<? AND minZoom<=? AND maxZoom>=?
      AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY m.priority,m.id LIMIT 256`).all(x0, x0 + size, y0, y0 + size, x0, x0 + size, y0, y0 + size, z, z, ...kinds) as { id: number; name: string; kind: MarkerKind; x: number; y: number }[];
    // Labels occupy stable global grid slots; adjacent windows use the same grid.
    // This bounds density without relaying a viewport-sized layout every frame.
    const occupied = new Set<string>(), result: MapMarker[] = [];
    for (const r of rows) {
      const cell = `${Math.floor(r.x * 2 ** z / 128)}/${Math.floor(r.y * 2 ** z / 32)}`;
      if (occupied.has(cell)) continue; occupied.add(cell);
      result.push([r.id, r.name, r.kind, +r.x.toFixed(5), +r.y.toFixed(5)]);
      if (result.length === 12) break;
    }
    return result;
  }
  close() { this.db.close(); }
}
