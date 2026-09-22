/** The shipped device path end to end: the production transport factory
 * (app/transport.ts) over a bounded host lane on a real TCP socket, against
 * serveMapRelay with the real host/worker.ts behind it.
 *
 * The lane is what a device host implements natively
 * (contracts/spec/relay-channel.ts): complete records only, `slots` deep,
 * one record per take. Here it is backed by node:net, so the record
 * framing, the pairing handshake, the catalog and a 131,072-byte tile all
 * cross a socket exactly as they would on a 3DS or PSP. */
import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { attachRelayChannel, relaySocketChannel } from "@pocketjs/framework/relay/wire";
import { RELAY_CHANNEL, createRelayChannel, relayChannelRxLimits, type RelayChannelOps } from "@pocketjs/framework/relay/channel";
import { RELAY_CODEC } from "@pocketjs/framework/relay/spec";
import type { ResourceResult } from "@pocketjs/framework/resource-cache";
import { serveMapRelay, workerBackend } from "../host/relay-host.ts";
import { OBJECT_BYTES, RENDITION, namespaceFor, relayRxLimits, searchRef, tileRef, type MapCatalog } from "../shared/relay.ts";
import { mapTransport } from "../app/transport.ts";
import { defaultConfig } from "../host/config.ts";
import { RASTER_URL, rasterPng } from "./relay-rig.ts";
import type { OffloadImage } from "@pocketjs/framework/offload/provider";

const KEY = "cd".repeat(32);

/** The bounded lane a device host owns: the pairing key rides the first
 * record, inbound records queue in `slots` and leave one per take. */
function deviceLane(socket: Socket, key: string) {
  const channel = relaySocketChannel(socket, { id: "companion", grants: ["pocket-map"] });
  const inbound: Uint8Array[] = [];
  let generation = 1, dropped = 0, refused = 0, first = true;
  attachRelayChannel({
    handleRecord(bytes) {
      if (inbound.length >= RELAY_CHANNEL.slots) { dropped++; return; }
      inbound.push(bytes.slice());
    },
    handleDisconnect() { generation = 0; },
    close() { generation = 0; },
  }, channel, { maxWireBytes: RELAY_CHANNEL.recordBytes });
  const ops: RelayChannelOps = {
    session: () => generation,
    send(record) {
      if (generation <= 0 || record.length > RELAY_CHANNEL.recordBytes) { refused++; return false; }
      if (first) {
        first = false;
        const combined = new Uint8Array(64 + record.length);
        combined.set(Buffer.from(key), 0); combined.set(record, 64);
        return channel.send(combined);
      }
      return channel.send(record);
    },
    take(into) {
      const next = inbound[0];
      if (!next) return 0;
      if (next.length > into.length) { inbound.shift(); dropped++; return into.length + 1; }
      inbound.shift(); into.set(next);
      return next.length;
    },
    stats: () => `queued=${inbound.length} dropped=${dropped} refused=${refused}`,
  };
  return { ops, channel, detach() { generation = 0; } };
}

for (const isolation of ["thread", "process"] as const) {
  test(`the shipped transport factory (${isolation} worker) pairs over TCP, reads the catalog and a tile byte-identical to the worker's decode, and drops a wrong key`, async () => {
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
      if (m) return new Response(rasterPng(Number(m[1]), Number(m[2]), Number(m[3])));
      if (url.searchParams.has("q")) return new Response(JSON.stringify({ features: [{ properties: { osm_type: "N", osm_id: 7, name: "Ferry Building", country: "USA", type: "attraction" }, geometry: { coordinates: [-122.39, 37.79] } }] }));
      return new Response("nope", { status: 404 });
    } });
    const data = { ...defaultConfig, format: "raster", tileURL: `${http.url}{z}/{x}/{y}.png`, searchURL: String(http.url), cache: ":memory:", kind: "osm" };
    const log: string[] = [];
    const server = await serveMapRelay({ key: KEY, port: 0, host: "127.0.0.1", log: m => log.push(m),
      backend: () => workerBackend({ worker: new URL("../host/worker.ts", import.meta.url), data, isolation }) });
    let socket: Socket | undefined, choice: ReturnType<typeof mapTransport> | undefined;
    try {
      const [source] = server.authority.sourceList();
      expect(source.kind).toBe("osm"); expect(source.revision).toMatch(/^[a-f0-9]{16}$/);
      socket = await new Promise<Socket>((resolve, reject) => { const s = connect(server.port, "127.0.0.1", () => resolve(s)); s.once("error", reject); });
      const lane = deviceLane(socket, KEY);
      const channel = createRelayChannel(lane.ops, { id: "companion", grants: ["pocket-map"] });
      choice = mapTransport(channel);
      expect(choice.transport).toBe("relay");
      const relay = choice.relay!;
      // The lane's guarantees are what the guest advertised, so every record
      // the authority sends fits one slot.
      expect(relayRxLimits(relayChannelRxLimits()).maxWireBytes).toBe(RELAY_CHANNEL.recordBytes);
      /** Step the channel until the predicate holds. Success is decided by
       * the condition only; the deadline exists so a broken link fails the
       * test instead of hanging it (a worker subprocess takes longer to
       * spawn than a thread, and neither number is asserted). */
      const until = async (label: string, predicate: () => boolean, deadlineMs = 20000) => {
        const until = Date.now() + deadlineMs;
        for (let steps = 0; ; steps++) {
          channel.step();
          if (predicate()) return steps;
          if (Date.now() > until) throw new Error(`${label}: not reached in ${steps} steps (${channel.stats().native})`);
          await new Promise(resolve => setImmediate(resolve));
        }
      };
      await until("ready", () => relay.connected());
      // The catalog: one document naming the installed source and revision.
      let catalog: MapCatalog | undefined, failure: unknown, catalogIssued = false;
      await until("catalog", () => {
        // requestCatalog answers false while the namespace is still binding;
        // once it is admitted the request is outstanding, not repeated.
        if (!catalogIssued) catalogIssued = relay.requestCatalog(result => { if (result.ok) catalog = result.catalog ?? catalog; else failure = result.error; });
        return !!catalog || !!failure;
      });
      expect(failure).toBeUndefined();
      expect(catalog!.maps.map(m => [m.kind, m.source, m.revision])).toEqual([["osm", source.source, source.revision]]);
      // One tile, chunked into lane-sized records.
      const input = { source: source.source, z: 1, x: 0, y: 0 };
      let tile: ResourceResult<{ ref: { revision?: string }; data: Uint8Array }> | undefined, tileIssued = false;
      await until("tile", () => {
        if (!tileIssued) tileIssued = relay.get(tileRef(input, RENDITION.raster), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, result => { tile = result; }) !== false;
        return !!tile;
      });
      if (!tile!.ok || !("value" in tile!)) throw new Error(`get failed: ${JSON.stringify(tile)}`);
      const object = tile!.value as { data: Uint8Array; ref: { revision?: string } };
      expect(object.data.length).toBe(131072);
      expect(object.ref.revision).toBe(source.revision);
      // A place search is a relay resource on the same stream.
      let places: ResourceResult<{ data: Uint8Array }> | undefined, searchIssued = false;
      const query = { query: "ferry", source: source.source, lat: 37.8, lon: -122.4 };
      await until("search", () => {
        if (!searchIssued) searchIssued = relay.get(searchRef(query), { accept: [RELAY_CODEC.JSON], maxObjectBytes: OBJECT_BYTES.search }, result => { places = result; }) !== false;
        return !!places;
      });
      if (!places!.ok || !("value" in places!)) throw new Error(`search failed: ${JSON.stringify(places)}`);
      // The same bytes the worker module produces when called directly.
      const { MapService } = await import("../host/service.ts");
      const direct = new MapService(data as never, async url => {
        const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(url));
        if (m) return new Response(rasterPng(Number(m[1]), Number(m[2]), Number(m[3])));
        return new Response(JSON.stringify({ features: [{ properties: { osm_type: "N", osm_id: 7, name: "Ferry Building", country: "USA", type: "attraction" }, geometry: { coordinates: [-122.39, 37.79] } }] }));
      });
      try {
        const expected = await direct.methods()["map.tile"](JSON.stringify(input)) as OffloadImage;
        expect(Buffer.compare(Buffer.from(object.data), Buffer.from(expected.pixels))).toBe(0);
        const expectedPlaces = await direct.methods()["map.search"](JSON.stringify(query)) as string;
        expect(JSON.parse(Buffer.from((places!.value as { data: Uint8Array }).data).toString("utf8"))).toEqual(JSON.parse(expectedPlaces));
      } finally { direct.close(); }
      const stats = relay.stats();
      expect(stats.protocolErrors).toBe(0);
      expect(stats.objects).toBe(3); // catalog, tile, search
      expect(channel.stats().oversized).toBe(0);
      // A 131,072-byte tile crosses a 16,384-byte lane as nine records.
      expect(server.authority.stats).toMatchObject({ gets: 3, objects: 3, opens: 2 });
      await until("drained", () => relay.stats().pending === 0);
      expect(choice.relay!.endpoint.inspect()!.sender.ledgerView().inFlight(1)).toEqual({ frames: 0, bytes: 0 });
      // A wrong key never reaches HELLO: the socket is closed by the listener.
      const bad = await new Promise<Socket>((resolve, reject) => { const s = connect(server.port, "127.0.0.1", () => resolve(s)); s.once("error", reject); });
      const closed = new Promise<void>(resolve => bad.once("close", () => resolve()));
      bad.write("ab".repeat(32));
      await closed;
      expect(server.authority.connectionCount()).toBe(1);
    } finally {
      choice?.channel?.close();
      choice?.relay?.disconnect("test over");
      socket?.destroy();
      await server.close(); http.stop(true);
    }
  }, 30000);
}
