import { P2PSessionInfo } from "../types/electron.d";
import { Display } from "../../common/pp-types";
import { readPersistedSettings } from "./settingsStore";
import { isWebServerRuntimeAvailable } from "./webServerBridge";

type PpdMessage = {
  op?: string;
  id?: string;
  device?: string;
  port?: number;
  name?: string;
  url?: string;
  display?: Display;
  stylesRev?: string;
};

type HostDevicePacket = {
  message: string;
  from: string;
  port?: number;
  /** Which bridge delivered this packet. Nearby packets carry an endpoint ID in
   *  `from` (not an IP) and have no meaningful port, so replies must be routed
   *  back over `sendNearbyMessage` rather than UDP. */
  transport?: "udp" | "nearby";
};

type WatchDetails = {
  address: string;
  port: number;
  hostId: string;
};

/** Every port a PPD host may bind. Used verbatim for LISTENING, and for the
 *  periodic "wide" scan round — a peer only lands on 1975+ when an earlier port was
 *  already taken on its machine, so probing the whole range every round is mostly
 *  wasted broadcast bandwidth (see SCAN_WIDE_EVERY). */
const UDP_PORT_SPEC = "1974-1983";
/** The port a first-instance PPD host binds, and therefore the only one worth
 *  probing on an ordinary scan round. */
const PRIMARY_SCAN_PORT = 1974;
/** Probe the full UDP_PORT_SPEC on every Nth round so a peer parked on a higher
 *  port is still refreshed well inside STALE_UDP_MS. */
const SCAN_WIDE_EVERY = 4;
const GLOBAL_BROADCAST = "255.255.255.255";

/** How long a discovered peer survives without a fresh offer.
 *
 * These are the list's stability budget: at the ~1 Hz scan cadence the UDP window
 * tolerates several consecutive lost/late offers before a row disappears, which is
 * what keeps a busy network (where broadcast frames are routinely dropped) from
 * flickering rows in and out. It deliberately does NOT delay a clean shutdown — an
 * explicit `off` message or a nearby `disappeared` event removes the peer at once.
 *
 * Nearby/BLE gets a far longer window because one discovery→connect→scan→offer
 * round-trip legitimately takes seconds, so a UDP-sized budget would expire a
 * healthy bluetooth peer between rounds. */
const STALE_UDP_MS = 8000;
const STALE_NEARBY_MS = 30000;
/** How long the derived scan-target list (per-NIC broadcasts) is reused before the
 *  host bridge is asked again. Interface enumeration is a native round-trip. */
const SCAN_TARGET_TTL_MS = 30000;
/** Upper bound on the randomised delay before answering a `scan`. Without it every
 *  host on the network answers a broadcast in the same instant, and on Wi-Fi the
 *  resulting burst is exactly what gets dropped. */
const SCAN_REPLY_JITTER_MS = 150;
const DEVICE_ID_PREFERENCE = "ppdDeviceId";

/** Stop Nearby/BLE discovery this long after the last scan request. The sessions
 *  form polls ~1 Hz while it is open, so discovery stays on for as long as the
 *  user is looking at the list and shuts down on its own once polling stops —
 *  BLE scanning and Nearby discovery are both expensive to leave running. */
const NEARBY_DISCOVERY_IDLE_MS = 8000;

const discoveredSessions = new Map<string, P2PSessionInfo>();
let initialized = false;
let listenPort = 0;
let unsubscribeHostDevice: (() => void) | null = null;
let scanId = "";
let deviceId = "";

// ── Nearby (Bluetooth/BLE) transport state ─────────────────────────────────────
// Endpoint IDs seen on the nearby bridge. Membership is what routes a reply to
// sendNearbyMessage instead of sendUdpMessage, so it must outlive discovery
// (a followed session keeps sending `view`/`ack` long after the scan ended).
const nearbyEndpoints = new Set<string>();
const connectedNearbyEndpoints = new Set<string>();
/** Whether native discovery is actually RUNNING. */
let nearbyDiscovering = false;
/** Whether discovery is WANTED. Tracked separately because the two diverge exactly
 *  when it matters: the first attempt is refused while the runtime permission prompt
 *  is still open, so "running" is false even though the caller asked for it. The
 *  permission grant arrives later and has to retry off the intent. */
let nearbyDiscoveryRequested = false;
let nearbyDiscoveryStopTimer: ReturnType<typeof setTimeout> | null = null;
let nearbyPermissionRequested = false;

let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchedSession: { id: string; details: WatchDetails } | null = null;
let watchedDisplayCallback: ((display: Display) => void) | null = null;
let watchedEndedCallback: (() => void) | null = null;

// Optional callback for nearby endpoint change notifications (for UI consumers)
type NearbyChangeCallback = (type: "discovered" | "disappeared", endpointId: string, name?: string) => void;
const nearbyChangeListeners = new Set<NearbyChangeCallback>();

const now = () => Date.now();

const randomId = () => Math.random().toString(36).slice(2);

// ── Discovered-session liveness + change notification ──────────────────────────
//
// The list used to be polled: a caller scanned, then immediately read whatever had
// already arrived, so a freshly-answered offer only surfaced one poll tick later.
// Discovery is inherently event-shaped, so offers/withdrawals are published the
// moment they land and the poll timer only drives the OUTGOING scan.

type SessionsChangeCallback = () => void;
const sessionsChangeListeners = new Set<SessionsChangeCallback>();
let sessionSweepTimer: ReturnType<typeof setInterval> | null = null;

const staleWindowFor = (session: P2PSessionInfo): number => (session.transport === "bluetooth" ? STALE_NEARBY_MS : STALE_UDP_MS);

const isSessionFresh = (session: P2PSessionInfo, at = now()): boolean => at - session.detected <= staleWindowFor(session);

/** Everything a consumer renders. Liveness (`detected`) is deliberately excluded so
 *  a peer that keeps answering does not re-notify — and re-render — every round. */
const sessionSignature = (session: P2PSessionInfo): string =>
  [session.name, session.url, session.transport, session.address ?? "", session.port ?? ""].join("|");

const notifySessionsChanged = (): void => {
  for (const callback of sessionsChangeListeners) {
    try {
      callback();
    } catch {
      /* listener errors are intentionally ignored */
    }
  }
};

/** Drop every peer past its transport's liveness window. Returns whether anything went. */
const sweepStaleSessions = (): boolean => {
  const at = now();
  let removed = false;
  for (const [id, session] of discoveredSessions) {
    if (!isSessionFresh(session, at)) {
      discoveredSessions.delete(id);
      removed = true;
    }
  }
  return removed;
};

/**
 * Subscribe to discovered-session changes (a peer appearing, changing, or expiring).
 * The sweep timer that ages peers out runs only while someone is listening, so an
 * app with no sessions UI open pays nothing.
 */
export const onHostDeviceSessionsChanged = (callback: SessionsChangeCallback): (() => void) => {
  sessionsChangeListeners.add(callback);
  if (!sessionSweepTimer) {
    sessionSweepTimer = setInterval(() => {
      if (sweepStaleSessions()) notifySessionsChanged();
    }, 1000);
  }
  return () => {
    sessionsChangeListeners.delete(callback);
    if (sessionsChangeListeners.size === 0 && sessionSweepTimer) {
      clearInterval(sessionSweepTimer);
      sessionSweepTimer = null;
    }
  };
};

const resolvePromise = async <T>(value: T | Promise<T>) => value;

const getHostDevice = () => window.hostDevice;
const isElectronHost = (): boolean => typeof window !== "undefined" && !!(window as Window & { electronAPI?: unknown }).electronAPI;

const getSelfDeviceName = async () => {
  const hostDevice = getHostDevice();
  const name = hostDevice?.getName ? await resolvePromise(hostDevice.getName()) : "";
  if (name && name.trim()) return name.trim();
  const model = hostDevice?.getModel ? await resolvePromise(hostDevice.getModel()) : "";
  return model?.trim() || "";
};

const getSelfDeviceId = async () => {
  if (deviceId) return deviceId;
  const hostDevice = getHostDevice();

  // Electron's native UDP host identifies itself with os.hostname(). The
  // renderer must use that same ID for scans, otherwise the main process treats
  // its own broadcast as a foreign request and offers itself back to the UI.
  if (isElectronHost()) {
    const nativeHostId = await getSelfDeviceName();
    if (nativeHostId) {
      deviceId = nativeHostId;
      return deviceId;
    }
  }

  // Android hosts PPD in this JS runtime, so give it a stable ID independent of
  // the user-visible device name (two phones may legitimately have the same name).
  try {
    const stored = hostDevice?.retrievePreference
      ? await resolvePromise(hostDevice.retrievePreference(DEVICE_ID_PREFERENCE))
      : window.localStorage?.getItem(DEVICE_ID_PREFERENCE);
    if (stored?.trim()) {
      deviceId = stored.trim();
      return deviceId;
    }
  } catch {
    /* preference access is optional */
  }

  deviceId = `pp-${randomId()}${randomId()}`;
  try {
    if (hostDevice?.storePreference) {
      await resolvePromise(hostDevice.storePreference(DEVICE_ID_PREFERENCE, deviceId));
    } else {
      window.localStorage?.setItem(DEVICE_ID_PREFERENCE, deviceId);
    }
  } catch {
    /* the in-memory id is still valid for this runtime */
  }
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

/** Endpoint-ID prefixes that denote a real nearby link. `nb_`/`ble_` come from
 *  Android's P2PTransport, `bt_` from Electron's. `udp_` is deliberately absent:
 *  Electron mirrors its UDP discoveries onto the same "nearby" event channel, and
 *  those must keep using the UDP path. */
const NEARBY_ID_PREFIXES = ["nb_", "ble_", "bt_"];

const hasNearbyPrefix = (id: string): boolean => NEARBY_ID_PREFIXES.some((prefix) => id.startsWith(prefix));

/** Whether `target` addresses a Nearby/BLE endpoint rather than an IP host. Known
 *  endpoints are tracked from the bridge's own discovery events; the prefix test is
 *  the fallback for an endpoint we were told to talk to before discovering it. */
const isNearbyEndpoint = (target: string): boolean => !!target && (nearbyEndpoints.has(target) || hasNearbyPrefix(target));

const sendPpd = async (message: PpdMessage, host: string, portSpec: string) => {
  const hostDevice = getHostDevice();
  // A nearby endpoint has no IP/port — the payload goes over the Nearby/BLE link.
  // Checked before the UDP branch so a followed bluetooth session's view/ack pings
  // are not silently dropped into sendUdpMessage with a meaningless port.
  if (isNearbyEndpoint(host)) {
    if (!hostDevice?.sendNearbyMessage) return "";
    // Our UDP listen port MUST NOT travel over a nearby link: the peer would answer
    // it with sendUdpMessage(endpointId, port), and an endpoint ID is not routable.
    // Omitting it is what makes the far side reply over the same nearby endpoint.
    const encoded = encodePacketMessage({ ...message, port: undefined });
    return (await resolvePromise(hostDevice.sendNearbyMessage(host, encoded))) ? host : "";
  }
  if (!hostDevice?.sendUdpMessage) return "";
  return await resolvePromise(hostDevice.sendUdpMessage(encodePacketMessage(message), host, portSpec));
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
// Refreshed by scan/view requests. A viewer repeats view every 10 seconds, so
// webserver toggles have a bounded staleness window rather than permanent state.
let hostAdvertisedWebServerUrl: string | undefined;
const hostWatchers = new Map<
  string,
  {
    address: string;
    port?: number;
    lastRequestArrived: number;
    lastDisplaySent: number;
    lastDisplayAcked: boolean;
    lastDisplay?: string;
    lastSentStylesRev?: string;
    acknowledgedStylesRev?: string;
    pendingStylesRev?: string;
    blockedInlineStylesRev?: string;
    inlineStylesRetransmits?: number;
  }
>();

// Send a host-originated PPD message (offer/display/off), augmenting it with our own
// device id, name and listen port so the receiver can reply (mirrors legacy
// sendPpdMessage). UDP when the target port is known; Nearby otherwise.
const sendHostPpd = async (message: PpdMessage, address: string, port?: number): Promise<void> => {
  const hostDevice = getHostDevice();
  if (!hostDevice) return;
  const selfDevice = await getSelfDeviceId();
  // Reply over the same transport the request came in on. A watcher reached over a
  // nearby link gets no port: advertising our UDP port to a peer with no IP route to
  // us would make it answer into the void (and it is what keeps its own replies on
  // the nearby endpoint).
  const nearby = isNearbyEndpoint(address);
  const encoded = encodePacketMessage({
    ...message,
    device: selfDevice,
    name: message.name ?? hostName ?? selfDevice,
    port: nearby ? undefined : listenPort || undefined,
  });
  try {
    if (!nearby && port != null && hostDevice.sendUdpMessage) {
      await resolvePromise(hostDevice.sendUdpMessage(encoded, address, String(port)));
    } else if ((nearby || port == null) && hostDevice.sendNearbyMessage) {
      await resolvePromise(hostDevice.sendNearbyMessage(address, encoded));
    }
  } catch {
    /* host send failures are non-fatal */
  }
};

/** Build the LAN URL advertised by the JS-hosted PPD responder (Android). Read the
 * persisted settings for every scan so changing the webserver toggle/address does
 * not require restarting the PPD host loop. A loopback fallback must never be
 * advertised to another device; when no explicit host is configured, prefer the
 * first non-loopback address exposed by the native host bridge. */
const getAdvertisedWebServerUrl = async (): Promise<string | undefined> => {
  if (!isWebServerRuntimeAvailable()) return undefined;

  const settings = readPersistedSettings();
  if (settings.iWebEnabled === false) return undefined;

  const configuredHost = settings.webServerDomainName?.trim();
  const usableConfiguredHost = configuredHost && configuredHost !== "localhost" && configuredHost !== "127.0.0.1" ? configuredHost : undefined;
  const host = usableConfiguredHost ?? (await getLocalNetworkAddresses())[0];
  if (!host) return undefined;

  const port = settings.webServerPort && settings.webServerPort > 0 ? settings.webServerPort : 19740;
  const rawPath = settings.webServerPath?.trim() || "/";
  const path = `${rawPath.startsWith("/") ? "" : "/"}${rawPath}${rawPath.endsWith("/") ? "" : "/"}`;
  return `http://${host}:${port}${path}`;
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
      if (message.id) {
        // Stagger the answer: a broadcast scan reaches every host at once, and
        // synchronised replies are what overwhelms a Wi-Fi cell's broadcast budget
        // once more than a handful of devices are present.
        setTimeout(() => {
          void (async () => {
            // Re-check at SEND time. Hosting can be stopped inside the delay window,
            // and the advertised url has to describe the state now — otherwise a
            // just-stopped session still answers and scanners list a dead endpoint
            // until it ages out.
            if (!hosting) return;
            const url = await getAdvertisedWebServerUrl().catch(() => undefined);
            hostAdvertisedWebServerUrl = url;
            await sendHostPpd({ op: "offer", id: message.id, url }, packet.from, message.port ?? packet.port);
          })();
        }, Math.random() * SCAN_REPLY_JITTER_MS);
      }
      return true;
    case "view":
      if (message.id === deviceId) {
        void getAdvertisedWebServerUrl()
          .catch(() => undefined)
          .then((url) => {
            hostAdvertisedWebServerUrl = url;
            registerHostWatcher(packet, message);
          });
      }
      return true;
    case "ack":
      if (message.id === deviceId && message.device) {
        const watcher = hostWatchers.get(message.device);
        if (watcher) {
          if (message.stylesRev !== undefined && message.stylesRev !== watcher.lastSentStylesRev) return true;
          watcher.lastDisplayAcked = true;
          // Viewers predating stylesRev still get the previous one-shot behavior.
          // Revision-aware viewers remain protected by the stale-ACK check above.
          const acknowledgedStylesRev = message.stylesRev ?? watcher.pendingStylesRev;
          if (watcher.pendingStylesRev !== undefined && watcher.pendingStylesRev === acknowledgedStylesRev) {
            watcher.acknowledgedStylesRev = watcher.pendingStylesRev;
            watcher.pendingStylesRev = undefined;
            watcher.blockedInlineStylesRev = undefined;
          }
        }
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
  const providedDisplay = hostDisplayProvider();
  const chordProStyles = providedDisplay.chordProStyles;
  const chordProStylesRev = providedDisplay.chordProStylesRev;
  const display = { ...providedDisplay, chordProStyles: undefined };
  const serializedDisplay = JSON.stringify(display);
  for (const [key, watcher] of [...hostWatchers]) {
    if (watcher.lastRequestArrived < nowMs - 120000) {
      hostWatchers.delete(key);
      continue;
    }
    if (!watcher.lastDisplayAcked && watcher.pendingStylesRev && watcher.lastDisplay) {
      if (watcher.lastDisplaySent < nowMs - 2000) {
        if ((watcher.inlineStylesRetransmits ?? 0) >= 3) {
          // Do not let one fragmented styles packet freeze all later display
          // updates. Send the newest state without the bulky inline payload and
          // keep this revision blocked until the host styles change.
          watcher.blockedInlineStylesRev = watcher.pendingStylesRev;
          watcher.pendingStylesRev = undefined;
          watcher.inlineStylesRetransmits = 0;
          watcher.lastDisplaySent = nowMs;
          watcher.lastDisplay = serializedDisplay;
          watcher.lastSentStylesRev = chordProStylesRev ?? "";
          watcher.lastDisplayAcked = false;
          void sendHostPpd({ op: "display", display }, watcher.address, watcher.port);
        } else {
          watcher.lastDisplaySent = nowMs;
          watcher.inlineStylesRetransmits = (watcher.inlineStylesRetransmits ?? 0) + 1;
          void sendHostPpd({ op: "display", display: JSON.parse(watcher.lastDisplay) as Display }, watcher.address, watcher.port);
        }
      }
      continue;
    }
    const canFetchStyles = !!hostAdvertisedWebServerUrl && !isNearbyEndpoint(watcher.address);
    const includeStyles =
      !canFetchStyles &&
      !!chordProStyles &&
      !!chordProStylesRev &&
      watcher.acknowledgedStylesRev !== chordProStylesRev &&
      watcher.blockedInlineStylesRev !== chordProStylesRev;
    const displayToSend = includeStyles ? { ...display, chordProStyles } : display;
    const serialized = includeStyles ? JSON.stringify(displayToSend) : serializedDisplay;
    const displayChanged = serialized !== watcher.lastDisplay;
    if (watcher.lastDisplaySent < nowMs - 200 && (!watcher.lastDisplayAcked || displayChanged)) {
      watcher.lastDisplaySent = nowMs;
      watcher.lastDisplay = serialized;
      watcher.lastSentStylesRev = displayToSend.chordProStylesRev ?? "";
      watcher.pendingStylesRev = includeStyles ? chordProStylesRev : !chordProStylesRev ? "" : undefined;
      watcher.inlineStylesRetransmits = 0;
      watcher.lastDisplayAcked = false;
      void sendHostPpd({ op: "display", display: displayToSend }, watcher.address, watcher.port);
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
  const nearby = packet.transport === "nearby";
  const sessionDeviceId = message.device || "";
  // A nearby offer with no device id carries nothing we could follow: its `url` is
  // the host's LAN webserver, which is exactly what is unreachable when the peer
  // was only found over Bluetooth.
  if (!sessionDeviceId && (nearby || !message.url)) return;
  if (sessionDeviceId && sessionDeviceId === deviceId) {
    if (discoveredSessions.delete(`udp_${sessionDeviceId}`)) notifySessionsChanged();
    return;
  }
  const sessionId = sessionDeviceId ? `udp_${sessionDeviceId}` : `web_${message.url}`;
  // Same host reachable both ways: UDP wins (higher bandwidth, and the legacy client
  // filtered nrb: rows whose deviceId also appeared over UDP). Only refresh liveness.
  const existing = discoveredSessions.get(sessionId);
  if (nearby && existing && existing.transport === "udp") {
    existing.detected = now();
    return;
  }
  // Over a nearby link the host's own UDP listen port is not routable to us, so the
  // reply address stays the endpoint ID and the session classifies as a PPD peer.
  const offerPort = nearby ? undefined : (message.port ?? (sessionDeviceId ? packet.port : undefined));
  // A PPD host that runs no webserver sends an offer with NO url; it is a UDP/Nearby
  // session to FOLLOW, not a web endpoint to open. Synthesize a udp:// (or nrb://)
  // url so it classifies as PPD, mirroring the legacy `offer` handler — NOT http://,
  // which made url-less PPD offers look like a (broken) LAN webserver.
  const url =
    message.url && !nearby
      ? message.url
      : offerPort != null && sessionDeviceId
        ? `udp://${packet.from}:${offerPort}/${sessionDeviceId}`
        : `nrb://${packet.from}/${sessionDeviceId}`;
  const session: P2PSessionInfo = {
    id: sessionId,
    name: message.name || sessionDeviceId || message.url || sessionId,
    deviceId: sessionDeviceId || sessionId,
    hostId: message.id || sessionDeviceId || packet.from,
    url,
    transport: nearby ? "bluetooth" : "udp",
    address: packet.from,
    port: offerPort,
    detected: now(),
  };
  discoveredSessions.set(sessionId, session);
  // Publish only a genuine appearance/change — a peer that simply keeps answering
  // must not re-render the list once per scan round.
  if (!existing || sessionSignature(existing) !== sessionSignature(session)) notifySessionsChanged();
};

// ── Nearby discovery lifecycle ─────────────────────────────────────────────────
//
// Ports the legacy client's verifyNearby/scanForLocalServers pair: acquire the
// runtime permissions, flip discovery on for the duration of the scan, connect to
// every endpoint found, and send a PPD `scan` once each link is up. Without this
// the sessions list is UDP-only — which is exactly nothing when the two devices
// are not on a shared WiFi.

/** Send a PPD `scan` over an established nearby link. The peer answers with an
 *  `offer` on the same endpoint, which upsertOffer turns into a bluetooth session. */
const sendNearbyScan = async (endpointId: string): Promise<void> => {
  if (!scanId) return;
  const selfDevice = await getSelfDeviceId();
  const selfName = await getSelfDeviceName();
  await sendPpd({ op: "scan", id: scanId, device: selfDevice, name: selfName || selfDevice }, endpointId, UDP_PORT_SPEC);
};

/**
 * Make sure the Bluetooth/location runtime permissions are granted, prompting once.
 * Android's advertiseNearby/discoverNearby only *check* permissions (never request
 * them) and return false when any is missing, so nothing works until someone calls
 * the acquire path — this is it. The prompt is asynchronous: the call returns false
 * immediately and the grant arrives later as a `nearby` {granted} event.
 */
const ensureNearbyPermissions = async (): Promise<boolean> => {
  const hostDevice = getHostDevice();
  if (!hostDevice?.checkNearbyPermissions) return true;
  if (await resolvePromise(hostDevice.checkNearbyPermissions(false))) return true;
  // Ask once per runtime — re-prompting on every 1 Hz scan tick would be abusive
  // and, once the user has denied it, pointless.
  if (nearbyPermissionRequested) return false;
  nearbyPermissionRequested = true;
  await resolvePromise(hostDevice.checkNearbyPermissions(true));
  return false;
};

/** Flip native discovery once the permissions are in place. */
const applyNearbyDiscovery = async (enabled: boolean): Promise<boolean> => {
  const hostDevice = getHostDevice();
  if (!hostDevice?.discoverNearby) return false;
  if (enabled && !(await ensureNearbyPermissions())) return false;
  return await resolvePromise(hostDevice.discoverNearby(enabled));
};

/**
 * Turn Nearby/BLE discovery off. Established links are deliberately left up:
 * discovery is only how endpoints are *found*, and a session we are already
 * following keeps talking over its endpoint long after the scan ended.
 */
export const stopHostDeviceNearbyDiscovery = (): void => {
  if (nearbyDiscoveryStopTimer) {
    clearTimeout(nearbyDiscoveryStopTimer);
    nearbyDiscoveryStopTimer = null;
  }
  // Drop the intent first, so a permission grant still in flight does not start
  // discovery we have just asked to stop.
  nearbyDiscoveryRequested = false;
  if (!nearbyDiscovering) return;
  nearbyDiscovering = false;
  void applyNearbyDiscovery(false);
};

/** Start (or extend) Nearby/BLE discovery for one scan round. Idempotent — the
 *  sessions form calls it on every poll tick and each call pushes the idle
 *  auto-stop further out. */
const startHostDeviceNearbyDiscovery = async (): Promise<void> => {
  if (nearbyDiscoveryStopTimer) clearTimeout(nearbyDiscoveryStopTimer);
  nearbyDiscoveryStopTimer = setTimeout(stopHostDeviceNearbyDiscovery, NEARBY_DISCOVERY_IDLE_MS);
  // Re-scan links that are already up. Their offers expire after STALE_MS, so a peer
  // connected in an earlier round would drop out of the list without this ping — and
  // a live connection is never re-announced by onEndpointFound.
  nearbyDiscoveryRequested = true;
  for (const endpointId of connectedNearbyEndpoints) void sendNearbyScan(endpointId);
  if (nearbyDiscovering) return;
  // Latch on the ACTUAL result. Setting the flag first meant a discovery refused for
  // a missing runtime permission (the prompt resolves asynchronously, so the first
  // call always returns false) latched "discovering" without ever having started —
  // and every later round then short-circuited on the flag, leaving Nearby dead for
  // the rest of the runtime. The intent is carried by nearbyDiscoveryRequested above,
  // which is what the permission-grant handler retries from.
  nearbyDiscovering = await applyNearbyDiscovery(true);
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
        if (discoveredSessions.delete(`udp_${message.device}`)) notifySessionsChanged();
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
          stylesRev: message.display.chordProStylesRev ?? "",
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
    // Nearby events from Electron (UDP offer/off mirrored here, plus bt_ endpoints)
    // or from Android (Nearby Connections / BLE endpoint events and payloads).
    const data = payload.param as {
      id?: string;
      name?: string;
      event?: string;
      /** Android delivers an inbound PPD payload as `msg`… */
      msg?: string;
      /** …Electron as event:"message" + `payload`. */
      payload?: string;
      /** Android's async answer to checkNearbyPermissions(true). */
      granted?: boolean;
    };
    if (!data) return;

    // Runtime-permission result: the user just answered the Nearby prompt. Whichever
    // call triggered it returned false at the time, so redo it now that we may.
    if (typeof data.granted === "boolean") {
      if (data.granted) {
        // Retry off the INTENT, not off "is running": the call that triggered this
        // prompt was refused for the very permission just granted, so it never
        // latched nearbyDiscovering. A continuously-open dialog would paper over the
        // miss on its next round, but a one-shot API scan has no next round and would
        // simply never report its Nearby peers.
        if (nearbyDiscoveryRequested && !nearbyDiscovering) {
          void applyNearbyDiscovery(true).then((started) => {
            // Honour a stop that landed while this was in flight.
            if (nearbyDiscoveryRequested) nearbyDiscovering = started;
            else if (started) void applyNearbyDiscovery(false);
          });
        }
        if (hosting) void resolvePromise(getHostDevice()?.advertiseNearby?.(true) ?? false);
      }
      return;
    }

    if (!data.id) return;

    // An inbound PPD message over the nearby link (offer/display/off …). Without
    // this the whole bluetooth leg is write-only: the host answers our scan and
    // the reply is dropped on the floor.
    const rawMessage = data.msg ?? (data.event === "message" ? data.payload : undefined);
    if (rawMessage) {
      nearbyEndpoints.add(data.id);
      const message = decodePacketMessage(rawMessage);
      if (message) await onIncomingPpdMessage({ message: rawMessage, from: data.id, transport: "nearby" }, message);
      return;
    }

    if (!data.event) return;
    const nearbyTransport = hasNearbyPrefix(data.id);

    if (data.event === "discovered") {
      if (nearbyTransport) {
        nearbyEndpoints.add(data.id);
        // Nearby Connections requires an accepted connection before any payload can
        // be sent, so a discovery is only the first half of the handshake. Ask for
        // the connection; the PPD `scan` goes out once it is established.
        if (nearbyDiscovering && !connectedNearbyEndpoints.has(data.id)) {
          void resolvePromise(getHostDevice()?.connectNearby?.(data.id) ?? false);
        }
      } else if (!discoveredSessions.has(data.id)) {
        // Electron's mirror of its own UDP discoveries — no handshake, no payload;
        // it only exists so the list can show a peer before its offer arrives.
        discoveredSessions.set(data.id, {
          id: data.id,
          name: data.name || data.id,
          deviceId: data.id,
          hostId: data.id,
          url: "",
          transport: "udp",
          detected: Date.now(),
        });
        notifySessionsChanged();
      }
      for (const cb of nearbyChangeListeners) {
        try {
          cb("discovered", data.id, data.name);
        } catch {
          /* listener errors are intentionally ignored */
        }
      }
      return;
    }

    if (data.event === "connected") {
      nearbyEndpoints.add(data.id);
      connectedNearbyEndpoints.add(data.id);
      // The link is up: ask who is there. The answering `offer` arrives back over
      // the same endpoint and lands in upsertOffer as a bluetooth session.
      if (scanId) void sendNearbyScan(data.id);
      return;
    }

    if (data.event === "disconnected" || data.event === "connection failed") {
      connectedNearbyEndpoints.delete(data.id);
      return;
    }

    if (data.event === "disappeared") {
      connectedNearbyEndpoints.delete(data.id);
      // Keep the endpoint in nearbyEndpoints: a session we are already following
      // still has to route its view/ack over the nearby link, and Nearby drops
      // discovery entries as soon as scanning stops.
      let removed = discoveredSessions.delete(data.id);
      for (const [id, session] of discoveredSessions) {
        if (session.transport === "bluetooth" && session.address === data.id) removed = discoveredSessions.delete(id) || removed;
      }
      if (removed) notifySessionsChanged();
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
  hostAdvertisedWebServerUrl = undefined;
  hostWatchers.clear();
  if (hostTimer) {
    clearInterval(hostTimer);
    hostTimer = null;
  }
  stopHostDeviceNearbyDiscovery();
  nearbyEndpoints.clear();
  connectedNearbyEndpoints.clear();
  void getHostDevice()?.closeNearby?.("");
  void getHostDevice()?.advertiseNearby?.(false);
  unsubscribeHostDevice?.();
  unsubscribeHostDevice = null;
  initialized = false;
};

// ── Scan targeting ─────────────────────────────────────────────────────────────
//
// Scanning a single directed subnet broadcast is not enough in practice: a
// multi-homed host (Wi-Fi + Ethernet + VPN, or Android's Wi-Fi + p2p interface) only
// ever probed one of its subnets, and plenty of access points drop directed
// broadcasts outright while still passing 255.255.255.255. The chosen address is
// therefore the *primary* target rather than the only one.

let scanRound = 0;
let scanTargetsCache: { at: number; targets: string[] } | null = null;

/** Primary (user-chosen) target first, then every other NIC's broadcast, then the
 *  global broadcast as the AP-drops-directed-broadcasts fallback. */
const buildScanTargets = async (address?: string): Promise<string[]> => {
  const preferred = address?.trim();
  // "*" delegates target selection to the native bridge (its own no-interface-info
  // fallback); widening it here would second-guess that.
  if (preferred === "*") return ["*"];

  if (!scanTargetsCache || now() - scanTargetsCache.at > SCAN_TARGET_TTL_MS) {
    const { options } = await getLocalBroadcastAddresses();
    scanTargetsCache = { at: now(), targets: options.map((option) => option.value) };
  }

  // Nothing to widen from and no explicit choice: let the native bridge resolve a
  // broadcast itself, which is better informed than a blind global broadcast.
  if (!preferred && scanTargetsCache.targets.length === 0) return ["*"];

  const seen = new Set<string>();
  return [preferred ?? "", ...scanTargetsCache.targets, GLOBAL_BROADCAST].filter((target) => target && !seen.has(target) && seen.add(target));
};

/** Ports probed this round. See PRIMARY_SCAN_PORT / SCAN_WIDE_EVERY. */
const scanPortSpec = (wide: boolean): string => {
  if (wide) return UDP_PORT_SPEC;
  const ports = new Set<number>([PRIMARY_SCAN_PORT]);
  if (listenPort) ports.add(listenPort);
  return [...ports].join(",");
};

/**
 * Broadcast one PPD `scan` round and start/extend Nearby discovery.
 *
 * `broad` sends to every candidate target on every port — use it for the opening
 * burst when a dialog is first shown, where finding peers fast matters more than
 * bandwidth. An ordinary round probes the primary target plus one rotating
 * secondary on the primary port only, so steady-state traffic stays roughly flat
 * while coverage still cycles through every subnet within a few seconds.
 */
export const scanHostDeviceSessions = async (
  address?: string,
  options?: { broad?: boolean }
): Promise<{ success: boolean; address?: string; error?: string }> => {
  if (!isHostDevicePpdAvailable()) {
    return { success: false, error: "HostDevice unavailable" };
  }
  await initHostDevicePpd();
  scanId = randomId();

  // Nearby/BLE runs alongside UDP and is started FIRST: it is the only leg that can
  // find a peer when the two devices share no network (different WiFi, or WiFi off
  // entirely), so a failure to bind the UDP socket must not skip it.
  void startHostDeviceNearbyDiscovery();

  const port = await ensureListening();
  if (!port) {
    return { success: false, error: "UDP listen unavailable" };
  }
  const selfDevice = await getSelfDeviceId();
  const selfName = await getSelfDeviceName();

  const round = scanRound++;
  const broad = options?.broad === true;
  const targets = await buildScanTargets(address);
  // Rotate through the secondaries so every subnet is covered within a few rounds
  // without multiplying per-round broadcast traffic by the interface count.
  const roundTargets = broad || targets.length <= 1 ? targets : [...new Set([targets[0], targets[1 + (round % (targets.length - 1))]])];
  const portSpec = scanPortSpec(broad || round % SCAN_WIDE_EVERY === 0);

  const request: PpdMessage = {
    op: "scan",
    id: scanId,
    port,
    device: selfDevice,
    name: selfName || selfDevice,
  };

  // Only the PRIMARY target decides the reported address / success: it is the one the
  // user picked, and the widened fallbacks succeeding must not mask a bad choice.
  let sentAddress = "";
  for (const [index, target] of roundTargets.entries()) {
    const result = await sendPpd(request, target, portSpec);
    if (index === 0) sentAddress = result;
  }

  if (sweepStaleSessions()) notifySessionsChanged();

  return { success: !!sentAddress, address: sentAddress || undefined };
};

/** One active IPv4 interface as reported by the host bridge (Electron / Android). */
export type NetworkInterfaceDetail = { name: string; address: string; netmask: string };

/** A selectable scan-address for the sessions form's picker: the broadcast `value`
 *  used for scanning, plus a human `label` (interface name + broadcast). */
export type ScanAddressOption = { value: string; label: string };

/**
 * All active IPv4 interfaces (name/address/netmask) from the host bridge's
 * getNetworkInterfaces() — Electron's os.networkInterfaces() or Android's
 * NetworkInterface enumeration. Empty in a plain browser (no bridge).
 */
export const getNetworkInterfaces = async (): Promise<NetworkInterfaceDetail[]> => {
  const hostDevice = getHostDevice();
  if (!hostDevice?.getNetworkInterfaces) return [];
  try {
    const raw = await resolvePromise(hostDevice.getNetworkInterfaces());
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is NetworkInterfaceDetail =>
        !!i && typeof (i as NetworkInterfaceDetail).address === "string" && typeof (i as NetworkInterfaceDetail).netmask === "string"
    );
  } catch {
    return [];
  }
};

/** The subnet broadcast for an ip + dotted-quad netmask, e.g. (192.168.1.7,
 *  255.255.255.0) -> 192.168.1.255. Null when either is malformed. */
function broadcastFor(address: string, netmask: string): string | null {
  const ip = address.split(".").map(Number);
  const mask = netmask.split(".").map(Number);
  if (ip.length !== 4 || mask.length !== 4 || [...ip, ...mask].some((n) => Number.isNaN(n))) return null;
  return ip.map((octet, i) => octet | (mask[i] ^ 255)).join(".");
}

/** Adapters unlikely to carry real LAN sessions (VM host-only / virtual / tunnel
 *  NICs). They stay in the picker but sort LAST so the default targets a real LAN. */
const VIRTUAL_IFACE = /virtualbox|virtual|vmware|vmnet|hyper-?v|vethernet|host-only|docker|wsl|\btap\b|\btun\b|loopback|bluetooth/i;
const HOST_ONLY_SUBNETS = [/^192\.168\.56\./]; // VirtualBox default

function ifaceRank(iface: NetworkInterfaceDetail): number {
  if (iface.address.startsWith("169.254.")) return 30;
  if (HOST_ONLY_SUBNETS.some((pattern) => pattern.test(iface.address))) return 20;
  if (VIRTUAL_IFACE.test(iface.name)) return 20;

  if (iface.address.startsWith("192.168.")) return 0;
  if (iface.address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) return 1;

  return 5;
}

/** Local IPv4 addresses suitable for advertising the embedded webserver,
 *  using the same LAN-first interface ordering as session discovery. */
export const getLocalNetworkAddresses = async (): Promise<string[]> => {
  const interfaces = (await getNetworkInterfaces()).slice().sort((a, b) => ifaceRank(a) - ifaceRank(b));
  const addresses = interfaces.map((iface) => iface.address);

  const seen = new Set<string>();
  return addresses.filter((address) => address && address !== "0.0.0.0" && !seen.has(address) && seen.add(address));
};

/**
 * Candidate local-scan broadcast addresses + the preferred default, derived from
 * the host bridge's full interface list (getNetworkInterfaces → broadcast per NIC),
 * so a multi-homed Electron desktop AND Android both offer every subnet. Falls back
 * to the older single-address info(2) bridge. Empty in a plain browser (callers
 * then default to 255.255.255.255).
 */
export const getLocalBroadcastAddresses = async (): Promise<{ options: ScanAddressOption[]; default?: string }> => {
  // Real LAN adapters first, virtual/host-only/link-local last, so the default
  // (options[0]) targets a usable subnet — all stay selectable in the combo. Each
  // option is labelled with its interface name so the user can tell NICs apart.
  const interfaces = (await getNetworkInterfaces()).slice().sort((a, b) => ifaceRank(a) - ifaceRank(b));
  let options: ScanAddressOption[] = [];
  for (const iface of interfaces) {
    const broadcast = broadcastFor(iface.address, iface.netmask);
    if (broadcast) options.push({ value: broadcast, label: iface.name ? `${iface.name} — ${broadcast}` : broadcast });
  }

  // Fallback for bridges without getNetworkInterfaces() (plain broadcast, no name).
  const toOptions = (addresses: string[]) => addresses.map((value) => ({ value, label: value }));
  if (!options.length && getHostDevice()?.info) {
    try {
      const raw = await resolvePromise(getHostDevice()!.info!(2));
      const info = typeof raw === "string" ? (JSON.parse(raw) as { broadcast?: string }) : undefined;
      if (info?.broadcast) options = toOptions([info.broadcast]);
    } catch {
      /* fall through */
    }
  }

  // Drop blanks / the global broadcast and de-duplicate by value (preserve order).
  const seen = new Set<string>();
  options = options.filter((o) => o.value && o.value !== "0.0.0.0" && !seen.has(o.value) && seen.add(o.value));
  return { options, default: options[0]?.value };
};

export const getHostDeviceDiscoveredSessions = (): P2PSessionInfo[] => {
  const at = now();
  const sessions: P2PSessionInfo[] = [];
  for (const session of discoveredSessions.values()) {
    if (isSessionFresh(session, at)) sessions.push(session);
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
  // Following over a nearby link needs no UDP socket of our own — the host answers
  // on the same endpoint. Only a UDP follow is dead without a listen port.
  if (!port && !isNearbyEndpoint(details.address)) return false;

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
  const selfDevice = await getSelfDeviceId();
  hostName = (await getSelfDeviceName()) || selfDevice;
  const hostDevice = getHostDevice();
  // Android gates advertiseNearby behind the very permissions it will not ask for on
  // its own, so it silently no-ops until they are granted. Prompt here, before the
  // call that needs them, instead of leaving the host undiscoverable over Bluetooth.
  await ensureNearbyPermissions();
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
  hostAdvertisedWebServerUrl = undefined;
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
