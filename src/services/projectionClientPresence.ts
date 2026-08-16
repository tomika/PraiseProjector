import { getHostedPpdClients, onHostedPpdClientsChanged } from "./hostedPpdClients";
import { isHostDevicePpdAvailable } from "./hostDevicePpd";
import { getWebServerInterface } from "./webServerBridge";

const CLIENT_PRESENCE_POLL_MS = 2000;

type PresenceListener = (connected: boolean) => void;

const listeners = new Set<PresenceListener>();
let connectedSnapshot = false;
let ppdConnected = false;
let webConnected = false;
let tracking = false;
let trackingGeneration = 0;
let webRefreshInFlight = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribePpd: (() => void) | null = null;

const publishSnapshot = () => {
  const next = ppdConnected || webConnected;
  if (next === connectedSnapshot) return;
  connectedSnapshot = next;
  for (const listener of listeners) listener(next);
};

const refreshPpd = () => {
  ppdConnected = getHostedPpdClients().length > 0;
  publishSnapshot();
};

const refreshWeb = async (generation: number) => {
  if (webRefreshInFlight) return;
  const webServer = getWebServerInterface();
  if (!webServer) {
    webConnected = false;
    publishSnapshot();
    return;
  }

  webRefreshInFlight = true;
  try {
    const result = await webServer.query({ kind: "clients", projectingOnly: true });
    if (generation !== trackingGeneration) return;
    if (result.kind === "clients") webConnected = result.count > 0;
    publishSnapshot();
  } catch {
    // Keep the last known value across transient bridge/query failures.
  } finally {
    if (generation === trackingGeneration) webRefreshInFlight = false;
  }
};

const startTracking = () => {
  tracking = true;
  const generation = ++trackingGeneration;
  const hasPpdBridge = isHostDevicePpdAvailable();
  const hasWebServerBridge = !!getWebServerInterface();

  ppdConnected = hasPpdBridge && getHostedPpdClients().length > 0;
  webConnected = false;
  connectedSnapshot = ppdConnected;

  if (hasPpdBridge) unsubscribePpd = onHostedPpdClientsChanged(refreshPpd);
  if (hasWebServerBridge) void refreshWeb(generation);

  // Runtime bridges are fixed at boot. In a plain PWA neither source exists, so
  // there is nothing to discover and no reason to keep a wake-up timer running.
  if (hasPpdBridge || hasWebServerBridge) {
    pollTimer = setInterval(() => {
      if (hasPpdBridge) refreshPpd();
      if (hasWebServerBridge) void refreshWeb(generation);
    }, CLIENT_PRESENCE_POLL_MS);
  }
};

const stopTracking = () => {
  tracking = false;
  trackingGeneration++;
  webRefreshInFlight = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  unsubscribePpd?.();
  unsubscribePpd = null;
  ppdConnected = false;
  webConnected = false;
  connectedSnapshot = false;
};

export const getProjectionClientPresenceSnapshot = (): boolean => connectedSnapshot;

/**
 * Subscribe to whether this application currently has at least one projection
 * client. All consumers share one tracker: PPD presence is event-driven and web
 * clients are polled because the webserver exposes them as a query, not an event.
 */
export function subscribeProjectionClientPresence(listener: PresenceListener): () => void {
  if (!tracking) startTracking();
  listeners.add(listener);
  listener(connectedSnapshot);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTracking();
  };
}
