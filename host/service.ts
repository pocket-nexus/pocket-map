import { notFound, unsupported } from "../shared/failure.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MapProvider } from "./provider.ts";
import { AtlasProvider } from "./atlas.ts";
import type { ProviderConfig } from "./config.ts";
import type { NetworkFetch } from "./cache.ts";
import type { MapKind } from "../shared/types.ts";

/** Selection is in each request, never mutable connection-wide state. Old
 * reads and lost command acknowledgements cannot cross databases on a switch. */
export class MapService {
  private providers = new Map<MapKind, MapProvider | AtlasProvider>();
  private selected: MapKind;
  constructor(config: ProviderConfig, network?: NetworkFetch) {
    this.providers.set("osm", new MapProvider(config, network));
    if (config.atlas && existsSync(join(config.atlas, "atlas.sqlite"))) this.providers.set("hyrule", new AtlasProvider(config.atlas));
    this.selected = config.kind ?? "osm";
    if (!this.providers.has(this.selected)) throw new Error("Prepare the Hyrule atlas first");
  }
  private resolve(source?: string) {
    if (source === undefined) return this.providers.get(this.selected)!; // Existing guest compatibility.
    for (const p of this.providers.values()) if (p.info.source === source) return p;
    throw notFound("Unknown map source");
  }
  methods() { return {
    "map.info": (raw: string) => {
      const kind = JSON.parse(raw).kind ?? this.selected, p = this.providers.get(kind);
      if (!p) throw notFound("Map is not installed on your Mac");
      return JSON.stringify({ ...p.info, kind, maps: [...this.providers].map(([kind, p]) => ({ kind, name: p.info.name })) });
    },
    "map.mesh": (raw:string) => {const v=JSON.parse(raw),p=this.resolve(v.source);if(!(p instanceof MapProvider))throw unsupported("This source uses raster tiles");return p.mesh(v);},
    "map.tile": (raw: string) => { const v = JSON.parse(raw); return this.resolve(v.source).tile(v); },
    "map.search": async (raw: string) => { const v = JSON.parse(raw); return JSON.stringify(await this.resolve(v.source).search(v)); },
    "map.label": (raw: string) => this.resolve().methods()["map.label"](raw),
    "map.markers": async (raw: string) => { const v = JSON.parse(raw), p = this.resolve(v.source); return JSON.stringify(await p.markerRows(v)); },
    "bookmarks.list": (raw: string) => { const v = JSON.parse(raw); return JSON.stringify(this.resolve(v.source).bookmarks.list(v.offset)); },
    "bookmarks.command": (raw: string) => { const v = JSON.parse(raw); return this.resolve(v.source).bookmarks.command(v); },
  }; }
  diagnostics() { return Object.fromEntries([...this.providers].map(([key, p]) => [key, p.diagnostics()])); }
  close() { for (const p of this.providers.values()) p.close(); }
}
