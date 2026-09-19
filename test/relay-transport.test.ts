import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { RelayEndpoint } from "@pocketjs/framework/relay/endpoint";
import { attachRelayChannel, relaySocketChannel } from "@pocketjs/framework/relay/wire";
import { RELAY_CODEC } from "@pocketjs/framework/relay/spec";
import type { ResourceResult } from "@pocketjs/framework/resource-cache";
import { serveMapRelay, workerBackend, providerCapabilities } from "../host/relay-host.ts";
import { MAP_RELAY, RENDITION, namespaceFor, tileRef } from "../shared/relay.ts";
import { defaultConfig } from "../host/config.ts";
import { RASTER_URL, rasterPng } from "./relay-rig.ts";
import type { OffloadImage } from "@pocketjs/framework/offload/provider";

const KEY = "cd".repeat(32);

/** A device: dial, present the pairing key and the HELLO in one write
 * (coalesced, as a real socket may), run a guest endpoint over the socket. */
async function dial(port: number) {
  const socket = await new Promise<Socket>((resolve, reject) => { const s = connect(port, "127.0.0.1", () => resolve(s)); s.once("error", reject); });
  const channel = relaySocketChannel(socket, { id: "companion", grants: ["pocket-map"] });
  let first = true;
  const guest = new RelayEndpoint({
    role: "guest",
    transport: { peer: channel.peer, trySend: bytes => {
      if (first) { first = false; const combined = new Uint8Array(64 + bytes.length); combined.set(Buffer.from(KEY), 0); combined.set(bytes, 64); return channel.send(combined) ? "accepted" : "busy"; }
      return channel.send(bytes) ? "accepted" : "busy";
    } },
    local: { app: MAP_RELAY.app, ...providerCapabilities() },
    pingIntervalMs: 1e9, stallMs: 1e9,
  });
  attachRelayChannel(guest, channel, { maxWireBytes: MAP_RELAY.rxLimits.maxWireBytes });
  return { socket, guest };
}

for (const isolation of ["thread", "process"] as const) {
  test(`serveMapRelay (${isolation} worker) authenticates the pairing key, serves a tile over TCP byte-identical to the worker's decode, and drops a wrong key`, async () => {
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(new URL(request.url).pathname);
      return m ? new Response(rasterPng(Number(m[1]), Number(m[2]), Number(m[3]))) : new Response("nope", { status: 404 });
    } });
    const data = { ...defaultConfig, format: "raster", tileURL: `${http.url}{z}/{x}/{y}.png`, searchURL: String(http.url), cache: ":memory:", kind: "osm" };
    const log: string[] = [];
    const server = await serveMapRelay({ key: KEY, port: 0, host: "127.0.0.1", log: m => log.push(m),
      backend: () => workerBackend({ worker: new URL("../host/worker.ts", import.meta.url), data, isolation }) });
    let device: Awaited<ReturnType<typeof dial>> | undefined;
    try {
      const [source] = server.authority.sourceList();
      expect(source.kind).toBe("osm"); expect(source.revision).toMatch(/^[a-f0-9]{16}$/);
      device = await dial(server.port);
      const ready = device.guest.whenReady(); expect(device.guest.hello().ok).toBe(true); await ready;
      const opened = await device.guest.open({ app: MAP_RELAY.app, namespace: namespaceFor(source.source), profile: { ...MAP_RELAY.profile } });
      expect(opened.stream).toBe(1);
      const input = { source: source.source, z: 1, x: 0, y: 0 };
      const result = await new Promise<ResourceResult<unknown>>(resolve => {
        const started = device!.guest.get(opened.stream, tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, resolve);
        if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
      });
      if (!result.ok || !("value" in result)) throw new Error(`get failed: ${JSON.stringify(result)}`);
      const object = result.value as { data: Uint8Array; ref: { revision?: string } };
      expect(object.data.length).toBe(131072); expect(object.ref.revision).toBe(source.revision);
      // The same bytes the worker module produces when called directly.
      const { MapService } = await import("../host/service.ts");
      const direct = new MapService(data as never, async url => { const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(url))!; return new Response(rasterPng(Number(m[1]), Number(m[2]), Number(m[3]))); });
      try {
        const expected = await direct.methods()["map.tile"](JSON.stringify(input)) as OffloadImage;
        expect(Buffer.compare(Buffer.from(object.data), Buffer.from(expected.pixels))).toBe(0);
      } finally { direct.close(); }
      await new Promise(r => setTimeout(r, 50));
      expect(device.guest.inspect()!.sender.ledgerView().inFlight(1)).toEqual({ frames: 0, bytes: 0 });
      expect(server.authority.stats).toMatchObject({ gets: 1, objects: 1, opens: 1 });
      // A wrong key never reaches HELLO: the socket is closed by the listener.
      const bad = await new Promise<Socket>((resolve, reject) => { const s = connect(server.port, "127.0.0.1", () => resolve(s)); s.once("error", reject); });
      const closed = new Promise<void>(resolve => bad.once("close", () => resolve()));
      bad.write("ab".repeat(32));
      await closed;
      expect(server.authority.connectionCount()).toBe(1);
    } finally {
      device?.guest.close(); device?.socket.destroy();
      await server.close(); http.stop(true);
    }
  }, 20000);
}
