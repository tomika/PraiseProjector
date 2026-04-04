import { P2PSessionInfo } from "../types/electron.d";
import { Display } from "../../common/pp-types";

type PpdMessage = {
  op?: string;
  id?: string;
  device?: string;
  port?: number;
  name?: string;
  url?: string;
  display?: Display;
};

type HostDevicePacket = {
  message: string;
  from: string;
  port?: number;
};

type WatchDetails = {
  address: string;
  port: number;
  hostId: string;
};

const UDP_PORT_SPEC = "1974-1983";
const STALE_MS = 3000;

const discoveredSessions = new Map<string, P2PSessionInfo>();
let initialized = false;
let listenPort = 0;
let unsubscribeHostDevice: (() => void) | null = null;
let scanId = "";
let deviceId = "";

let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchedSession: { id: string; details: WatchDetails } | null = null;
let watchedDisplayCallback: ((display: Display) => void) | null = null;
let watchedEndedCallback: (() => void) | null = null;

// Optional callback for nearby endpoint change notifications (for UI consumers)
type NearbyChangeCallback = (type: "discovered" | "disappeared", endpointId: string, name?: string) => void;
const nearbyChangeListeners = new Set<NearbyChangeCallback>();

const now = () => Date.now();

const randomId = () => Math.random().toString(36).slice(2);

const resolvePromise = async <T>(value: T | Promise<T>) => value;

const getHostDevice = () => window.hostDevice;

const getSelfDeviceId = async () => {
  if (deviceId) return deviceId;
  const hostDevice = getHostDevice();
  const name = hostDevice?.getName ? await resolvePromise(hostDevice.getName()) : "";
  if (name && name.trim()) {
    deviceId = name.trim();
    return deviceId;
  }
  const model = hostDevice?.getModel ? await resolvePromise(hostDevice.getModel()) : "";
  if (model && model.trim()) {
    deviceId = model.trim();
    return deviceId;
  }
  deviceId = `pp-electron-${randomId()}`;
  return deviceId;
};

const decodePacketMessage = (packetMessage: string): PpdMessage | null => {
  try {
    const bin = atob(packetMessage);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as PpdMessage;
  } catch {
    return null;
  }
};

const encodePacketMessage = (message: PpdMessage): string => {
  const json = JSON.stringify(message);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
};

const sendPpd = async (message: PpdMessage, host: string, portSpec: string) => {
  const hostDevice = getHostDevice();
  if (!hostDevice?.sendUdpMessage) return "";
  const encoded = encodePacketMessage(message);
  return await resolvePromise(hostDevice.sendUdpMessage(encoded, host, portSpec));
};

const sendViewRequest = async () => {
  if (!watchedSession) return;
  const selfDevice = await getSelfDeviceId();
  await sendPpd(
    {
      op: "view",
      id: watchedSession.id,
      device: selfDevice,
      port: listenPort || undefined,
    },
    watchedSession.details.address,
    String(watchedSession.details.port)
  );
};

const stopWatchingInternal = () => {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  watchedSession = null;
  watchedDisplayCallback = null;
  watchedEndedCallback = null;
};

const upsertOffer = (packet: HostDevicePacket, message: PpdMessage) => {
  const sessionDeviceId = message.device || "";
  if (!sessionDeviceId) return;
  const sessionId = `udp_${sessionDeviceId}`;
  const session: P2PSessionInfo = {
    id: sessionId,
    name: message.name || sessionDeviceId,
    deviceId: sessionDeviceId,
    hostId: message.id || sessionDeviceId,
    url: message.url || `http://${packet.from}:${message.port || packet.port || 80}/`,
    transport: "udp",
    address: packet.from,
    port: message.port || packet.port,
    detected: now(),
  };
  discoveredSessions.set(sessionId, session);
};

const onIncomingPpdMessage = async (packet: HostDevicePacket, message: PpdMessage) => {
  switch (message.op) {
    case "offer":
      upsertOffer(packet, message);
      return;
    case "off":
      if (message.device) {
        discoveredSessions.delete(`udp_${message.device}`);
      }
      if (watchedSession && message.device === watchedSession.id) {
        const ended = watchedEndedCallback;
        stopWatchingInternal();
        ended?.();
      }
      return;
    case "display": {
      if (!watchedSession || !watchedDisplayCallback || !message.device || message.device !== watchedSession.id || !message.display) return;
      watchedDisplayCallback(message.display);
      const selfDevice = await getSelfDeviceId();
      await sendPpd(
        {
          op: "ack",
          id: message.device,
          device: selfDevice,
          port: listenPort || undefined,
        },
        watchedSession.details.address,
        String(watchedSession.details.port)
      );
      return;
    }
  }
};

const onDeviceMessage = async (payload: { op: string; param: unknown }) => {
  if (payload.op === "udp") {
    const packet = payload.param as HostDevicePacket;
    if (!packet || typeof packet.message !== "string" || typeof packet.from !== "string") return;
    const message = decodePacketMessage(packet.message);
    if (!message) return;
    await onIncomingPpdMessage(packet, message);
    return;
  }

  if (payload.op === "nearby") {
    // Nearby discovery events from Electron (UDP offer/off reflected as nearby events)
    // or from Android (NearbyConnections endpoint events)
    const data = payload.param as { id?: string; name?: string; event?: string };
    if (!data || !data.id || !data.event) return;
    if (data.event === "discovered") {
      // Add to discovered sessions if not already tracked via UDP offer
      if (!discoveredSessions.has(data.id)) {
        discoveredSessions.set(data.id, {
          id: data.id,
          name: data.name || data.id,
          deviceId: data.id,
          hostId: data.id,
          url: "",
          transport: data.id.startsWith("udp_") ? "udp" : "bluetooth",
          detected: Date.now(),
        });
      }
      for (const cb of nearbyChangeListeners) {
        try {
          cb("discovered", data.id, data.name);
        } catch {}
      }
    } else if (data.event === "disappeared") {
      discoveredSessions.delete(data.id);
      for (const cb of nearbyChangeListeners) {
        try {
          cb("disappeared", data.id, data.name);
        } catch {}
      }
    }
    return;
  }
};

const ensureListening = async () => {
  const hostDevice = getHostDevice();
  if (!hostDevice?.listenOnUdpPort) return 0;
  if (listenPort > 0) return listenPort;
  listenPort = await resolvePromise(hostDevice.listenOnUdpPort(UDP_PORT_SPEC));
  return listenPort;
};

type GlobalWindowWithHandler = { handleDeviceMessage?: (raw: string) => void };

export const isHostDevicePpdAvailable = () => {
  const hostDevice = getHostDevice();
  return !!(hostDevice?.sendUdpMessage && hostDevice?.listenOnUdpPort);
};

export const initHostDevicePpd = async () => {
  if (initialized || !isHostDevicePpdAvailable()) return;
  initialized = true;
  await ensureListening();

  const handleRaw = (raw: string) => {
    try {
      const payload = JSON.parse(raw) as { op: string; param: unknown };
      void onDeviceMessage(payload);
    } catch {}
  };

  // Electron (contextIsolation): preload dispatches a CustomEvent on the shared DOM.
  const domEventListener = (e: Event) => {
    const detail = (e as CustomEvent<{ op: string; param: unknown }>).detail;
    if (detail && typeof detail.op === "string") void onDeviceMessage(detail);
  };
  window.addEventListener("pp-hostdevice-message", domEventListener);

  // Android: evaluateJavascript calls window.handleDeviceMessage directly in main world.
  const globalWin = window as unknown as GlobalWindowWithHandler;
  const previous = globalWin.handleDeviceMessage;
  const ourHandler = (raw: string) => {
    previous?.(raw);
    handleRaw(raw);
  };
  globalWin.handleDeviceMessage = ourHandler;

  unsubscribeHostDevice = () => {
    window.removeEventListener("pp-hostdevice-message", domEventListener);
    if ((window as unknown as GlobalWindowWithHandler).handleDeviceMessage === ourHandler) {
      (window as unknown as GlobalWindowWithHandler).handleDeviceMessage = previous;
    }
  };
};

export const disposeHostDevicePpd = () => {
  stopWatchingInternal();
  unsubscribeHostDevice?.();
  unsubscribeHostDevice = null;
  initialized = false;
};

export const scanHostDeviceSessions = async (address?: string): Promise<{ success: boolean; address?: string; error?: string }> => {
  if (!isHostDevicePpdAvailable()) {
    return { success: false, error: "HostDevice unavailable" };
  }
  await initHostDevicePpd();
  const port = await ensureListening();
  if (!port) {
    return { success: false, error: "UDP listen unavailable" };
  }
  scanId = randomId();
  const selfDevice = await getSelfDeviceId();
  const host = address && address.trim() ? address.trim() : "*";
  const sentAddress = await sendPpd(
    {
      op: "scan",
      id: scanId,
      port,
      device: selfDevice,
      name: selfDevice,
    },
    host,
    UDP_PORT_SPEC
  );

  const cutoff = now() - STALE_MS;
  for (const [id, session] of discoveredSessions) {
    if (session.detected < cutoff) {
      discoveredSessions.delete(id);
    }
  }

  return { success: !!sentAddress, address: sentAddress || undefined };
};

export const getHostDeviceDiscoveredSessions = (): P2PSessionInfo[] => {
  const cutoff = now() - STALE_MS;
  const sessions: P2PSessionInfo[] = [];
  for (const session of discoveredSessions.values()) {
    if (session.detected >= cutoff) sessions.push(session);
  }
  return sessions;
};

export const startHostDeviceWatching = async (
  sessionId: string,
  details: WatchDetails,
  onDisplayUpdate: (display: Display) => void,
  onSessionEnded: () => void
): Promise<boolean> => {
  if (!isHostDevicePpdAvailable()) return false;
  await initHostDevicePpd();
  const port = await ensureListening();
  if (!port) return false;

  const normalizedId = sessionId.startsWith("udp_") ? sessionId.slice(4) : sessionId;
  stopWatchingInternal();
  watchedSession = { id: normalizedId, details };
  watchedDisplayCallback = onDisplayUpdate;
  watchedEndedCallback = onSessionEnded;

  await sendViewRequest();
  watchTimer = setInterval(() => {
    void sendViewRequest();
  }, 10000);

  return true;
};

export const stopHostDeviceWatching = () => {
  stopWatchingInternal();
};

/**
 * Subscribe to nearby session discovered/disappeared events.
 * Receives both UDP-backed and Bluetooth-backed endpoint changes.
 * Returns an unsubscribe function.
 */
export const onHostDeviceNearbyChange = (callback: NearbyChangeCallback): (() => void) => {
  nearbyChangeListeners.add(callback);
  return () => {
    nearbyChangeListeners.delete(callback);
  };
};
