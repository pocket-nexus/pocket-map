export interface ProviderConfig {
  tileURL: string; format?: "raster" | "vector"; dataZoom?: number; searchURL: string; name: string; attribution: string; maxZoom: number; cache: string; kind?: "osm" | "hyrule"; atlas?: string;
  /** Which transport `bun run host` starts: the offload provider that dials the
   * device (default), or the relay authority the device dials (docs/RELAY.md). */
  transport?: "offload" | "relay";
  /** Relay listener port (offload uses 8741). */
  relayPort?: number;
  /** Operator-declared epoch folded into the relay revision of the OSM source.
   * Changing it (and restarting or SIGHUP-ing the host) invalidates every
   * resident guest tile of that source through one namespace INVALIDATE. */
  revision?: string;
}
export const defaultConfig: ProviderConfig = {
  tileURL: "https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}", format: "vector", dataZoom: 14, searchURL: "https://photon.komoot.io/api/",
  name: "OpenStreetMap", attribution: "OpenStreetMap contributors", maxZoom: 18, cache: ".local/cache.sqlite",
};
