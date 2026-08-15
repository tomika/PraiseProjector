import type { PpdPeer } from "../../common/ppd-control";
import { isPpdPeerAllowlisted } from "../../common/ppd-control";
import type { WebServerConnectedClient } from "../../common/webserver-interface";
import type { HostedPpdClient } from "./hostedPpdClients";

export type ManagedClientProtocol = "web" | "ppd-udp" | "ppd-nearby";

export type ManagedClient = {
  key: string;
  id: string;
  identifier: string;
  deviceName: string;
  address?: string;
  protocols: ManagedClientProtocol[];
  isConnected: boolean;
  isLeaderModeClient: boolean;
  ppdPeers: PpdPeer[];
};

export const getClientIdentifier = (id: string): string => {
  const parts = id.split("@");
  return parts[parts.length - 1] || id;
};

export const getClientDeviceName = (id: string): string => {
  const separator = id.lastIndexOf("@");
  return separator >= 0 ? id.slice(0, separator) : "";
};

const normalizeIdentifier = (value: string): string => value.trim().toLocaleLowerCase();

const makeSavedId = (deviceName: string | undefined, identifier: string): string =>
  deviceName?.trim() ? `${deviceName.trim()}@${identifier}` : identifier;

const addProtocol = (client: ManagedClient, protocol: ManagedClientProtocol): void => {
  if (!client.protocols.includes(protocol)) client.protocols.push(protocol);
};

export function buildManagedClients(
  savedLeaderClients: readonly string[],
  webClients: readonly WebServerConnectedClient[],
  ppdClients: readonly HostedPpdClient[],
  allClientsCanUseLeaderMode: boolean
): ManagedClient[] {
  const clients = new Map<string, ManagedClient>();

  for (const savedId of savedLeaderClients) {
    const identifier = getClientIdentifier(savedId);
    const key = normalizeIdentifier(identifier);
    clients.set(key, {
      key,
      id: savedId,
      identifier,
      deviceName: getClientDeviceName(savedId),
      protocols: [],
      isConnected: false,
      isLeaderModeClient: true,
      ppdPeers: [],
    });
  }

  for (const webClient of webClients) {
    const identifier = getClientIdentifier(webClient.id);
    const key = normalizeIdentifier(identifier);
    const existing = clients.get(key);
    const client =
      existing ??
      ({
        key,
        id: webClient.id,
        identifier,
        deviceName: webClient.deviceName,
        protocols: [],
        isConnected: false,
        isLeaderModeClient: false,
        ppdPeers: [],
      } satisfies ManagedClient);
    client.id = webClient.id;
    client.deviceName = webClient.deviceName || client.deviceName;
    // Some native bridges include saved leader rows in this result. Those rows
    // are not proof of a live HTTP connection; ordinary rows are.
    client.isConnected ||= webClient.isConnected ?? !webClient.isLeaderModeClient;
    addProtocol(client, "web");
    clients.set(key, client);
  }

  for (const ppdClient of ppdClients) {
    const identifier = ppdClient.deviceId;
    const matchingSavedId = savedLeaderClients.find((entry) => isPpdPeerAllowlisted(ppdClient, [entry]));
    const key = normalizeIdentifier(matchingSavedId ? getClientIdentifier(matchingSavedId) : identifier);
    const existing = clients.get(key);
    const client =
      existing ??
      ({
        key,
        id: makeSavedId(ppdClient.name, identifier),
        identifier,
        deviceName: ppdClient.name ?? "",
        protocols: [],
        isConnected: false,
        isLeaderModeClient: false,
        ppdPeers: [],
      } satisfies ManagedClient);
    client.deviceName = ppdClient.name || client.deviceName;
    client.address = ppdClient.address;
    client.isConnected = true;
    client.ppdPeers.push(ppdClient);
    addProtocol(client, ppdClient.transport === "nearby" ? "ppd-nearby" : "ppd-udp");
    clients.set(key, client);
  }

  for (const client of clients.values()) {
    const exactIdentifierAllowed = savedLeaderClients.some(
      (entry) => normalizeIdentifier(getClientIdentifier(entry)) === normalizeIdentifier(client.identifier)
    );
    const ppdAllowed = client.ppdPeers.some((peer) => isPpdPeerAllowlisted(peer, savedLeaderClients));
    client.isLeaderModeClient = allClientsCanUseLeaderMode || exactIdentifierAllowed || ppdAllowed;
  }

  return [...clients.values()].sort((a, b) => {
    if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
    const aLabel = a.deviceName || a.identifier;
    const bLabel = b.deviceName || b.identifier;
    return aLabel.localeCompare(bLabel);
  });
}

export function getMatchingLeaderEntries(client: ManagedClient, entries: readonly string[]): string[] {
  return entries.filter((entry) => {
    if (normalizeIdentifier(getClientIdentifier(entry)) === normalizeIdentifier(client.identifier)) return true;
    return client.ppdPeers.some((peer) => isPpdPeerAllowlisted(peer, [entry]));
  });
}
