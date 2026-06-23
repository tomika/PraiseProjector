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

// ── PPD session HOSTING (the host/leader half of the protocol) ──────────────────
//
// Ports the host side of legacy praiseprojector.ts `handlePpdRequests`/`startPpdSession`
// (offer/view/ack/display). It runs ONLY in the JS-host contexts (Android / a browser
// with a UDP bridge). On the Electron desktop the MAIN process is the PPD host
// (electron/udp.ts), and `window.hostDevice.listenOnUdpPort` returns that shared socket,
// so a JS loop here would double-respond — there we only flip native advertising on/off
// (see startHostDevicePpdHosting). Host ops (scan/view/ack) and watcher ops
// (offer/off/display) are disjoint, so this coexists with the watcher code above.

let hosting = false;
let hostDisplayProvider: (() => Display) | null = null;
let hostTimer: ReturnType<typeof setInterval> | null = null;
let hostName = "";
const hostWatchers = new Map<
  string,
  { address: string; port?: number; lastRequestArrived: number; lastDisplaySent: number; lastDisplayAcked: boolean; lastDisplay?: string }
>();

const isElectronHost = (): boolean => typeof window !== "undefined" && !!(window as Window & { electronAPI?: unknown }).electronAPI;

// Send a host-originated PPD message (offer/display/off), augmenting it with our own
// device id, name and listen port so the receiver can reply (mirrors legacy
// sendPpdMessage). UDP when the target port is known; Nearby otherwise.
const sendHostPpd = async (message: PpdMessage, address: string, port?: number): Promise<void> => {
  const hostDevice = getHostDevice();
  if (!hostDevice) return;
  const selfDevice = await getSelfDeviceId();
  const encoded = encodePacketMessage({
    ...message,
    device: selfDevice,
    name: message.name ?? hostName ?? selfDevice,
    port: listenPort || undefined,
  });
  try {
    if (port != null && hostDevice.sendUdpMessage) {
      await resolvePromise(hostDevice.sendUdpMessage(encoded, address, String(port)));
    } else if (port == null && hostDevice.sendNearbyMessage) {
      await resolvePromise(hostDevice.sendNearbyMessage(address, encoded));
    }
  } catch {
    /* host send failures are non-fatal */
  }
};

const registerHostWatcher = (packet: HostDevicePacket, message: PpdMessage): void => {
  if (!message.device) return;
  const existing = hostWatchers.get(message.device);
  if (existing) {
    existing.lastRequestArrived = now();
    existing.address = packet.from;
    existing.port = message.port ?? packet.port;
  } else {
    hostWatchers.set(message.device, {
      address: packet.from,
      port: message.port ?? packet.port,
      lastRequestArrived: now(),
      lastDisplaySent: 0,
      lastDisplayAcked: false,
    });
  }
};

// Handle an inbound host-side op. Returns true when consumed (so onIncomingPpdMessage
// stops before the watcher switch). Only invoked while `hosting` (the JS loop) is on.
const handleHostMessage = (packet: HostDevicePacket, message: PpdMessage): boolean => {
  switch (message.op) {
    case "scan":
      if (message.id) void sendHostPpd({ op: "offer", id: message.id }, packet.from, message.port ?? packet.port);
      return true;
    case "view":
      if (message.id === deviceId) registerHostWatcher(packet, message);
      return true;
    case "ack":
      if (message.id === deviceId && message.device) {
        const watcher = hostWatchers.get(message.device);
        if (watcher) watcher.lastDisplayAcked = true;
      }
      return true;
    default:
      return false;
  }
};

// Push the current display to every watcher whose state is stale or unacked (legacy
// handlePpdRequests' 200 ms-throttled per-watcher send), dropping watchers idle >120 s.
const pushDisplayToWatchers = async (): Promise<void> => {
  if (!hosting || !hostDisplayProvider) return;
  const nowMs = now();
  const display = hostDisplayProvider();
  const serialized = JSON.stringify(display);
  for (const [key, watcher] of [...hostWatchers]) {
    if (watcher.lastRequestArrived < nowMs - 120000) {
      hostWatchers.delete(key);
      continue;
    }
    if (watcher.lastDisplaySent < nowMs - 200 && (!watcher.lastDisplayAcked || serialized !== watcher.lastDisplay)) {
      watcher.lastDisplaySent = nowMs;
      watcher.lastDisplay = serialized;
      void sendHostPpd({ op: "display", display }, watcher.address, watcher.port);
    }
  }
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
  const offerPort = message.port ?? packet.port;
  // A PPD host that runs no webserver sends an offer with NO url; it is a UDP/Nearby
  // session to FOLLOW, not a web endpoint to open. Synthesize a udp:// (or nrb://)
  // url so it classifies as PPD, mirroring the legacy `offer` handler — NOT http://,
  // which made url-less PPD offers look like a (broken) LAN webserver.
  const url = message.url
    ? message.url
    : offerPort != null
      ? `udp://${packet.from}:${offerPort}/${sessionDeviceId}`
      : `nrb://${packet.from}/${sessionDeviceId}`;
  const session: P2PSessionInfo = {
    id: sessionId,
    name: message.name || sessionDeviceId,
    deviceId: sessionDeviceId,
    hostId: message.id || sessionDeviceId,
    url,
    transport: "udp",
    address: packet.from,
    port: offerPort,
    detected: now(),
  };
  discoveredSessions.set(sessionId, session);
};

const onIncomingPpdMessage = async (packet: HostDevicePacket, message: PpdMessage) => {
  // While hosting a JS-loop PPD session, consume the host-side ops (scan/view/ack)
  // here; the watcher-side ops (offer/off/display) fall through to the switch below.
  if (hosting && handleHostMessage(packet, message)) return;
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
        } catch {
          /* listener errors are intentionally ignored */
        }
      }
    } else if (data.event === "disappeared") {
      discoveredSessions.delete(data.id);
      for (const cb of nearbyChangeListeners) {
        try {
          cb("disappeared", data.id, data.name);
        } catch {
          /* listener errors are intentionally ignored */
        }
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
    } catch {
      /* malformed payloads are intentionally ignored */
    }
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
  hosting = false;
  hostDisplayProvider = null;
  hostWatchers.clear();
  if (hostTimer) {
    clearInterval(hostTimer);
    hostTimer = null;
  }
  void getHostDevice()?.advertiseNearby?.(false);
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

/** Whether a JS-loop PPD session is currently being hosted (Android/web). */
export const isHostDevicePpdHosting = (): boolean => hosting;

/**
 * Begin hosting a local PPD session so nearby devices can discover and follow us.
 * Platform-routed: on the Electron desktop the MAIN process is the host, so we only
 * enable native advertising (which also flips the udp.ts hosting gate); on Android /
 * a browser with a UDP bridge we run the JS host loop (offer/view/ack/display).
 * `getDisplay` supplies the current projected display pushed to watchers. Returns
 * false when no host bridge is available (a plain browser).
 */
export const startHostDevicePpdHosting = async (getDisplay: () => Display): Promise<boolean> => {
  if (!isHostDevicePpdAvailable()) return false;
  await initHostDevicePpd();
  await ensureListening();
  hostName = await getSelfDeviceId();
  const hostDevice = getHostDevice();
  if (isElectronHost()) {
    // Desktop: enabling advertising is all that's needed; the main process answers
    // scans/views/displays itself. Running the JS loop would double-respond.
    await resolvePromise(hostDevice?.advertiseNearby?.(true) ?? false);
    return true;
  }
  hostDisplayProvider = getDisplay;
  hosting = true;
  hostWatchers.clear();
  await resolvePromise(hostDevice?.advertiseNearby?.(true) ?? false);
  if (!hostTimer) hostTimer = setInterval(() => void pushDisplayToWatchers(), 150);
  return true;
};

/** Stop hosting the local PPD session (legacy stopPpdSession): tell every watcher
 *  we're gone, stop the loop, and disable native advertising. */
export const stopHostDevicePpdHosting = async (): Promise<void> => {
  const hostDevice = getHostDevice();
  if (hosting) for (const watcher of hostWatchers.values()) void sendHostPpd({ op: "off" }, watcher.address, watcher.port);
  hosting = false;
  hostDisplayProvider = null;
  hostWatchers.clear();
  if (hostTimer) {
    clearInterval(hostTimer);
    hostTimer = null;
  }
  await resolvePromise(hostDevice?.advertiseNearby?.(false) ?? false);
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
