import { PPD_HOST_WATCH_TIMEOUT_SECONDS, normalizePpdWatchTimeoutSeconds, type PpdPeer, type PpdWireMessage } from "../../common/ppd-control";
import { readPersistedSettings } from "./settingsStore";

const hostedPpdClientStaleMs = (): number =>
  Math.max(PPD_HOST_WATCH_TIMEOUT_SECONDS, normalizePpdWatchTimeoutSeconds(readPersistedSettings().ppdWatchTimeoutSeconds)) * 1000;

export type HostedPpdClient = PpdPeer & {
  lastSeen: number;
};

type HostedPpdClientsListener = () => void;

const HOSTED_CLIENT_OPERATIONS = new Set(["view", "ack", "access", "command", "get-song"]);

export const isHostedPpdClientActivity = (message: PpdWireMessage, hostDeviceId: string): boolean =>
  !!message.device && message.id === hostDeviceId && HOSTED_CLIENT_OPERATIONS.has(message.op);

/**
 * Recent peers that actively consume or control the locally hosted PPD session.
 * Discovery scans are intentionally excluded: seeing another host on the LAN does
 * not make it one of our clients.
 */
export class HostedPpdClientRegistry {
  private readonly clients = new Map<string, HostedPpdClient>();
  private readonly listeners = new Set<HostedPpdClientsListener>();

  touch(peer: PpdPeer, at = Date.now()): void {
    const previous = this.clients.get(peer.deviceId);
    const next: HostedPpdClient = {
      ...peer,
      name: peer.name || previous?.name,
      lastSeen: at,
    };
    this.clients.set(peer.deviceId, next);

    if (!previous || previous.address !== next.address || previous.transport !== next.transport || previous.name !== next.name) {
      this.notify();
    }
  }

  remove(deviceId: string): void {
    if (this.clients.delete(deviceId)) this.notify();
  }

  clear(): void {
    if (this.clients.size === 0) return;
    this.clients.clear();
    this.notify();
  }

  prune(at = Date.now()): void {
    const staleMs = hostedPpdClientStaleMs();
    let changed = false;
    for (const [deviceId, client] of this.clients) {
      if (at - client.lastSeen > staleMs) {
        this.clients.delete(deviceId);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  getClients(at = Date.now()): HostedPpdClient[] {
    const staleMs = hostedPpdClientStaleMs();
    return [...this.clients.values()].filter((client) => at - client.lastSeen <= staleMs).map((client) => ({ ...client }));
  }

  subscribe(listener: HostedPpdClientsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A settings view must not be able to interrupt PPD packet handling.
      }
    }
  }
}

const hostedPpdClients = new HostedPpdClientRegistry();

export const noteHostedPpdClient = (peer: PpdPeer): void => hostedPpdClients.touch(peer);
export const removeHostedPpdClient = (deviceId: string): void => hostedPpdClients.remove(deviceId);
export const clearHostedPpdClients = (): void => hostedPpdClients.clear();
export const getHostedPpdClients = (): HostedPpdClient[] => {
  hostedPpdClients.prune();
  return hostedPpdClients.getClients();
};
export const onHostedPpdClientsChanged = (listener: HostedPpdClientsListener): (() => void) => hostedPpdClients.subscribe(listener);
