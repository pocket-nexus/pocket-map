/** The transport the shipped guests select.
 *
 * A host that opened the relay L0 lane (contracts/spec/relay-channel.ts)
 * exposes `globalThis.relayChannel`; the guest then runs the map catalog,
 * tiles, meshes, markers, labels and place search as relay resources. A
 * host without the lane keeps the offload method table, which is the same
 * code path pocket-map shipped before the migration. Both 3DS and PSP
 * entries choose here, so neither can ship a relay build that never
 * constructs a client.
 */
import { relayChannel, relayChannelRxLimits, type RelayChannel } from "@pocketjs/framework/relay/channel";
import { relayRxLimits } from "../shared/relay.ts";
import { createRelayMapClient, type RelayMapClient } from "./relay.ts";
import { createMap, type MapOptions, type MapTransport } from "./model.ts";

export interface MapTransportChoice extends MapOptions {
  transport: MapTransport;
  relay?: RelayMapClient;
  channel?: RelayChannel;
}

/** Build the transport a host supports. The channel drives the session:
 * a new attachment generation starts a relay session, a lost one discards
 * it, and every complete record it delivers goes to the endpoint. The
 * channel's own service pump runs both per frame. */
export function mapTransport(channel: RelayChannel | undefined = relayChannel({ id: "companion", grants: ["pocket-map"] })): MapTransportChoice {
  if (!channel) return { transport: "offload" };
  const relay = createRelayMapClient({
    transport: channel.transport,
    // The lane carries one record per slot, so the advertised receiver
    // guarantees shrink to what the host reserved (draft §3.2).
    rxLimits: relayRxLimits(relayChannelRxLimits()),
  });
  channel.onSession(session => { if (session > 0) relay.connect(); else relay.disconnect("relay channel detached"); });
  channel.onRecord(record => relay.handleRecord(record));
  channel.onStep(() => relay.step());
  // One step now, so an attachment that is already up starts its handshake
  // here rather than a frame later, and the channel holds the generation
  // every later step compares against.
  channel.step();
  return { transport: "relay", relay, channel };
}

/** The model both device entries mount. */
export function createMapForHost(viewport?: { width: number; height: number }, tileEntries?: number, choice = mapTransport()) {
  return createMap(undefined, viewport, tileEntries, choice);
}
