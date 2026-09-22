import { resolve } from "node:path";
import { connectOffloadProvider } from "@pocketjs/framework/offload/provider";
import { defaultConfig, type ProviderConfig } from "./config.ts";
import { MAP_RELAY } from "../shared/relay.ts";
import { serveMapRelay, workerBackend } from "./relay-host.ts";
import { SAVED_PLACES_ONLY } from "./capability.ts";
const root = resolve(import.meta.dir, "..");
const address = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "192.168.8.102";
const configPath = resolve(root, ".local/provider.json");
async function loadConfig(): Promise<ProviderConfig> {
  const overrides = await Bun.file(configPath).exists() ? await Bun.file(configPath).json() : {};
  const config: ProviderConfig = { ...defaultConfig, ...overrides, format: overrides.format ?? (overrides.tileURL?.endsWith(".png") ? "raster" : defaultConfig.format), cache: resolve(root, ".local/cache.sqlite") };
  config.kind = process.argv.includes("--osm") ? "osm" : process.argv.includes("--hyrule") ? "hyrule" : config.kind ?? "hyrule";
  config.atlas = resolve(root, ".local/hyrule");
  if (config.kind === "hyrule" && !await Bun.file(resolve(config.atlas, "atlas.sqlite")).exists()) throw new Error("Run bun run prepare:hyrule before starting the Hyrule host");
  return config;
}
let config = await loadConfig();
const key = (await Bun.file(resolve(root, ".local/pair.key")).text()).trim();
const log = (message: string) => console.log(new Date().toISOString(), message);
const trace = process.env.POCKET_MAP_TRACE === "1";
// The transport switch: offload (default) dials the device with the method
// table; relay listens for the device and serves the catalog (map.info),
// tiles, meshes, markers, labels and place search as resources. Saved
// places are mutations and stay on offload in both modes (#437 pilot
// order), so a relay host also runs the offload provider — restricted to
// the bookmark capabilities, so no map read can be answered by a worker
// holding a configuration the relay authority has already replaced.
const transport = process.argv.includes("--relay") ? "relay" : process.argv.includes("--offload") ? "offload" : config.transport ?? "offload";
const worker = new URL("./worker.ts", import.meta.url);
const label = config.kind === "hyrule" ? "Hyrule (local atlas)" : config.name;
const store = config.kind === "hyrule" ? config.atlas : config.cache;
const offloadData = (value: ProviderConfig) => transport === "relay" ? { ...value, only: [...SAVED_PLACES_ONLY] } : value;
let offloadLink = connectOffloadProvider({ address, key, worker, isolation: "process", data: offloadData(config), trace, log });
if (transport === "relay") {
  const port = config.relayPort ?? MAP_RELAY.port;
  const relay = await serveMapRelay({ key, port, host: "0.0.0.0", log, trace,
    backend: () => workerBackend({ worker, data: config, isolation: "process", log }) });
  // SIGHUP re-reads .local/provider.json once. The authority reads every
  // map.info from the new worker before it publishes, then swaps backend,
  // source table and catalog together and pushes the new catalog to the
  // device on its catalog subscription; the device's map.info, revision and
  // namespace therefore move in one step. The offload provider is replaced
  // with the same configuration afterwards, and it never served a map read.
  process.on("SIGHUP", () => {
    void (async () => {
      try {
        config = await loadConfig();
        const result = await relay.refresh({ reload: true });
        offloadLink.close();
        offloadLink = connectOffloadProvider({ address, key, worker, isolation: "process", data: offloadData(config), trace, log });
        log(`reloaded provider config; invalidated ${result.changed.length} namespace(s); catalog ${result.catalog.revision}`);
      } catch (error) { log(`reload failed: ${error}`); }
    })();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { relay.close().finally(() => process.exit(0)); });
  console.log(`Pocket Map relay authority: ${label}; listening on :${relay.port} for the device; ${store}; catalog=${relay.authority.catalogDocument().revision}; sources=${relay.authority.sourceList().map(s => `${s.kind}@${s.revision.slice(0, 8)}`).join(",")}`);
}
console.log(`Pocket Map: ${label} -> ${address}; ${store}${transport === "relay" ? " (offload carries saved places only)" : ""}`);
