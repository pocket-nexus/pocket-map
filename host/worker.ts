import { dispatchOffload } from "@pocketjs/framework/offload/provider";
import { dispatchMapCapability } from "./capability.ts";
import { MapService } from "./service.ts";
declare const self: { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let provider: MapService;
/** Capabilities this worker answers. `init.only` restricts the table: the
 * relay host runs a second worker for saved places, and that one must not
 * be able to answer a map read from a configuration the relay authority has
 * already replaced. */
let granted: readonly string[] | undefined;
const trace = process.env.POCKET_MAP_TRACE === "1";
const table = () => {
  const methods = provider.methods();
  if (!granted) return methods;
  return Object.fromEntries(Object.entries(methods).filter(([name]) => granted!.includes(name)));
};
self.onmessage = async event => {
  if (event.data.init) {
    const { only, ...config } = event.data.init as { only?: string[] } & Record<string, unknown>;
    provider = new MapService(config as never);
    granted = Array.isArray(only) ? [...only] : undefined;
    return;
  }
  const started = Date.now();
  // `relay` selects the coded dispatcher: the authority acts on error.code,
  // and a place search or the catalog exceeds the offload record budget.
  const reply = event.data.relay === 1
    ? await dispatchMapCapability(table(), event.data)
    : await dispatchOffload(table(), event.data);
  if (trace) console.log(new Date().toISOString(), `Map request id=${event.data.id} method=${event.data.method} workMs=${Date.now() - started} stats=${JSON.stringify(provider.diagnostics())} error=${typeof reply.error === "string" ? reply.error : reply.error?.code ?? "none"}`);
  self.postMessage(reply);
};
