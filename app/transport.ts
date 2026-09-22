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
import { attachRelaySession, relayChannel, relayChannelRxLimits, type RelayChannel } from "@pocketjs/framework/relay/channel";
import { relayRxLimits } from "../shared/relay.ts";
import { createRelayMapClient, type RelayMapClient } from "./relay.ts";
import { createMap, type MapOptions, type MapTransport } from "./model.ts";

export interface MapTransportChoice extends MapOptions {
  transport: MapTransport;
  relay?: RelayMapClient;
  channel?: RelayChannel;
}

/** Build the transport a host supports. The channel drives the session:
 * every change of the attachment generation discards the old relay session
 * and, while the lane is attached, runs one handshake against the new peer;
 * every complete record it delivers goes to the endpoint. The channel's own
 * service pump runs both per frame. */
export function mapTransport(channel: RelayChannel | undefined = relayChannel({ id: "companion", grants: ["pocket-map"] })): MapTransportChoice {
  if (!channel) return { transport: "offload" };
  const relay = createRelayMapClient({
    transport: channel.transport,
    // The lane carries one record per slot, so the advertised receiver
    // guarantees shrink to what the host reserved (draft §3.2).
    rxLimits: relayRxLimits(relayChannelRxLimits()),
  });
  attachRelaySession(channel, relay);
  return { transport: "relay", relay, channel };
}

/** The model both device entries mount. */
export function createMapForHost(viewport?: { width: number; height: number }, tileEntries?: number, choice = mapTransport()) {
  return createMap(undefined, viewport, tileEntries, choice);
}
