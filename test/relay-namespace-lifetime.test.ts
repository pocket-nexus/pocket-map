import { expect, test } from "bun:test";
import { decodeFrame } from "@pocketjs/framework/relay/frame";
import { RELAY_OP } from "@pocketjs/framework/relay/spec";
import { CATALOG_NS, namespaceFor } from "../shared/relay.ts";
import { createRig, rasterService } from "./relay-rig.ts";

// Task 1212's counterexample reached 304 OPEN attempts and four pending
// tiles on replacement seven. Keep the same delayed transport, go beyond
// ten replacements, and observe the wire as well as the rendered pixels.
test("twelve consecutive namespace replacements each use one OPEN and land every tile with bounded accounting", async () => {
  const r = await createRig({ transport: "relay", fixture: "raster", latency: 2 });
  const retired: number[] = [];
  const rows: unknown[] = [];
  const openErrors: string[] = [];
  const delivered = r.client!.handleRecord;
  r.client!.handleRecord = bytes => {
    const decoded = decodeFrame(bytes);
    if (decoded.ok && decoded.frame.metadata.op === RELAY_OP.OPEN && decoded.frame.metadata.error) {
      openErrors.push(String((decoded.frame.metadata.error as { code: string }).code));
    }
    delivered(bytes);
  };
  try {
    await r.until(() => !!r.model.info(), 120);
    await r.until(r.screenReady, 900);
    await r.frames(20);
    const session = r.client!.endpoint.session.sessionId;
    const initialOpens = r.relayStats()!.opens;
    const ceiling = [...r.providerEndpoint!.inspect()!.allocations.values()].reduce((sum, row) => sum + row.bytes, 0);
    expect(initialOpens).toBe(2);
    expect(ceiling).toBe(249856);
    for (let replacement = 1; replacement <= 12; replacement++) {
      const guest = r.client!.endpoint;
      const oldNs = namespaceFor(r.model.info()!.source);
      const old = guest.session.streamIds().find(id => guest.session.streamInfo(id)?.namespace === oldNs)!;
      retired.push(old);
      const opens = r.relayStats()!.opens;
      const epoch = String(replacement + 1);
      const url = `https://replacement-${replacement}.example.test/{z}/{x}/{y}.png`;
      const reload = await r.reload(epoch, e => rasterService(e, url));
      const source = reload.sources[0].source;
      const catalogFrames = await r.until(() => r.model.info()?.source === source, 300);
      const screenFrames = await r.until(r.screenReady, 900);
      await r.frames(10);
      const stats = r.relayStats()!;
      const tiles = r.model.front()!.tiles.map(({ input }) => input);
      const pendingTiles = tiles.filter(t => r.model.frontView.state(t).status === "pending").length;
      const ids = guest.session.streamIds();
      const opensDelta = stats.opens - opens;
      rows.push({ replacement, catalogFrames, screenFrames, opens: stats.opens, opensDelta, pendingTiles, ids, gets: stats.gets, objects: stats.objects });
      expect(opensDelta).toBe(1);
      expect(stats.opens).toBe(initialOpens + replacement);
      expect(stats.sessions).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.staged).toBe(0);
      expect(stats.invalidates).toBe(0);
      expect(r.authorityStats()!.invalidates).toBe(0);
      expect(stats.bindRefusals).toEqual({});
      expect(pendingTiles).toBe(0);
      expect(tiles.length).toBe(4);
      expect(tiles.every(t => t.source === source)).toBe(true);
      expect(guest.inspect()!.client!.stats().subscriptions).toBe(2);
      for (const endpoint of [guest, r.providerEndpoint!]) {
        const b = endpoint.inspect()!;
        expect(endpoint.session.sessionId).toBe(session);
        expect(endpoint.session.streamIds().map(id => endpoint.session.streamInfo(id)!.namespace)).toEqual([CATALOG_NS, namespaceFor(source)]);
        expect([...b.allocations.keys()]).toEqual([0, ...ids]);
        expect(b.sender.ledgerView().streamIds()).toEqual([0, ...ids]);
        expect(b.creditTable.size).toBeLessThanOrEqual(3);
        expect([...b.allocations.values()].reduce((sum, row) => sum + row.bytes, 0)).toBe(ceiling);
        expect(endpoint.protocolErrors).toBe(0);
        for (const id of retired) {
          expect(b.allocations.has(id)).toBe(false);
          expect(b.sender.ledgerView().sliceOf(id)).toBeUndefined();
          expect(b.creditTable.counters(id)).toBeUndefined();
          expect(b.authority?.subscriptionsOn(id) ?? []).toEqual([]);
        }
      }
      expect(ids.reduce((sum, id) => sum + r.providerEndpoint!.authority!.subscriptionsOn(id).length, 0)).toBe(2);
      const fresh = rasterService(epoch, url);
      try {
        for (const tile of tiles) {
          const expected = (await fresh.methods()["map.tile"](JSON.stringify(tile)) as { pixels: Uint8Array }).pixels;
          const actual = r.tileBytes(tile)!;
          expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
        }
      } finally { fresh.close(); }
    }
    const quiet: number[] = [];
    for (let interval = 0; interval < 3; interval++) {
      const opens = r.relayStats()!.opens;
      await r.frames(300);
      quiet.push(r.relayStats()!.opens - opens);
    }
    expect(quiet).toEqual([0, 0, 0]);
    expect(openErrors).toEqual([]);
    expect(r.screenReady()).toBe(true);
    console.log(`RECEIPT namespace-lifetime ${JSON.stringify({ initialOpens, ceiling, rows, quiet, openErrors })}`);
  } finally { r.dispose(); }
}, 60000);
