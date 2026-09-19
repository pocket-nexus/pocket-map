import { resolve } from "node:path";
import { connectOffloadProvider } from "@pocketjs/framework/offload/provider";
import { defaultConfig, type ProviderConfig } from "./config.ts";
import { MAP_RELAY } from "../shared/relay.ts";
import { serveMapRelay, workerBackend } from "./relay-host.ts";
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
const config = await loadConfig();
const key = (await Bun.file(resolve(root, ".local/pair.key")).text()).trim();
const log = (message: string) => console.log(new Date().toISOString(), message);
const trace = process.env.POCKET_MAP_TRACE === "1";
// The transport switch: offload (default) dials the device with the method
// table; relay listens for the device and serves tiles, meshes, markers and
// labels as resources (map.info, search and saved places stay on offload in
// both modes, so a relay host expects the offload provider as well).
const transport = process.argv.includes("--relay") ? "relay" : process.argv.includes("--offload") ? "offload" : config.transport ?? "offload";
const worker = new URL("./worker.ts", import.meta.url);
const label = config.kind === "hyrule" ? "Hyrule (local atlas)" : config.name;
const store = config.kind === "hyrule" ? config.atlas : config.cache;
if (transport === "relay") {
  const port = config.relayPort ?? MAP_RELAY.port;
  const relay = await serveMapRelay({ key, port, host: "0.0.0.0", log, trace,
    backend: async () => workerBackend({ worker, data: await loadConfig(), isolation: "process", log }) });
  // SIGHUP re-reads .local/provider.json into a fresh worker; a moved source
  // revision reaches every connected device as one namespace INVALIDATE.
  process.on("SIGHUP", () => { relay.refresh({ reload: true }).then(result => log(`reloaded provider config; invalidated ${result.changed.length} namespace(s)`), error => log(`reload failed: ${error}`)); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { relay.close().finally(() => process.exit(0)); });
  console.log(`Pocket Map relay authority: ${label}; listening on :${relay.port} for the device; ${store}; sources=${relay.authority.sourceList().map(s => `${s.kind}@${s.revision.slice(0, 8)}`).join(",")}`);
}
connectOffloadProvider({ address, key, worker, isolation: "process", data: config, trace, log });
console.log(`Pocket Map: ${label} -> ${address}; ${store}${transport === "relay" ? " (offload carries map.info, search and saved places)" : ""}`);
