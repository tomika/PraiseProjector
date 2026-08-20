import dgram from "dgram";
import { networkInterfaces, hostname } from "os";
import { WebServer } from "./webserver";
import { getMachineIpAddress } from "./utils";
import * as t from "io-ts";
import { PpdProtocolHandler, PpdSendFn, PpdHostInfo } from "./ppd-protocol";
import type { Display } from "../common/pp-types";
import {
  PPD_CONTROL_CAPABILITIES,
  PPD_DEFAULT_WATCH_TIMEOUT_SECONDS,
  PPD_PROTOCOL_VERSION,
  getPpdWatchHeartbeatMs,
  normalizePpdWatchTimeoutSeconds,
} from "../common/ppd-control";

// Display codec for UDP messages - matches C# Display class
const displayCodec = t.partial({
  song: t.string,
  system: t.string,
  songId: t.string,
  from: t.number,
  to: t.number,
  transpose: t.number,
  capo: t.number,
  playlist_id: t.string,
  version: t.number,
  instructions: t.string,
  section: t.number,
  message: t.string,
});

const udpMessageCodec = t.intersection([
  t.type({
    op: t.union([
      t.literal("scan"),
      t.literal("scan-reply"),
      t.literal("present"),
      t.literal("display"),
      t.literal("get-song"),
      t.literal("song"),
      t.literal("offer"),
      t.literal("view"),
      t.literal("ack"),
      t.literal("off"),
      t.literal("goodbye"),
      t.literal("session"),
      t.literal("access"),
      t.literal("command"),
      t.literal("result"),
    ]),
  }),
  t.partial({
    device: t.string,
    id: t.string,
    port: t.number,
    name: t.string,
    url: t.string,
    display: displayCodec,
    songId: t.string,
    songData: t.unknown,
    stylesRev: t.string,
    version: t.number,
    requestId: t.string,
    watchId: t.string,
    reason: t.string,
    token: t.string,
    capabilities: t.array(t.string),
    leaderModeAvailable: t.boolean,
    access: t.string,
    mode: t.string,
    granted: t.boolean,
    status: t.string,
    error: t.string,
    command: t.string,
    update: t.unknown,
    highlight: t.unknown,
  }),
]);

type UdpMessage = t.TypeOf<typeof udpMessageCodec>;

/** Upper bound on the randomised delay before answering a broadcast `scan`, so a
 *  roomful of hosts does not reply in lockstep. Mirrors the web-side PPD host in
 *  src/services/hostDevicePpd.ts. */
const SCAN_REPLY_JITTER_MS = 150;

/** How long a discovered peer survives without a fresh offer. Matches STALE_UDP_MS
 *  in src/services/hostDevicePpd.ts — both maps feed the same session list. */
const STALE_SESSION_MS = 8000;

// Discovered local session info (from UDP scan)
export interface LocalSessionInfo {
  id: string;
  name: string;
  deviceId: string;
  hostId: string; // hostname from offer's "id" field
  url: string;
  address: string;
  port?: number;
  detected: number; // timestamp
  protocolVersion?: number;
  capabilities?: string[];
}

export interface RawUdpPacket {
  message: string;
  from: string;
  port: number;
}

// Module-level instance for singleton access
let udpServerInstance: UdpServer | null = null;

export function getUdpServerInstance(): UdpServer | null {
  return udpServerInstance;
}

export type SessionChangeCallback = (type: "discovered" | "disappeared", sessionId: string, name?: string) => void;

export class UdpServer {
  private socket: dgram.Socket;
  private address?: string;
  private port?: number;
  private readonly rawPacketListeners = new Set<(packet: RawUdpPacket) => void>();
  private readonly sessionChangeListeners = new Set<SessionChangeCallback>();
  private discoveredSessions: Map<string, LocalSessionInfo> = new Map();
  private defaultPorts = [1974, 1975, 1976, 1977, 1978, 1979, 1980, 1981, 1982, 1983];

  // Watch mode transport state (protocol state is in protocolHandler)
  private watchedDeviceAddress: string | null = null;
  private watchedDevicePort: number | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchDeadlineTimer: NodeJS.Timeout | null = null;
  private watchedLastResponseAt = 0;
  private watchedLivenessConfirmed = false;
  private watchTimeoutSeconds = PPD_DEFAULT_WATCH_TIMEOUT_SECONDS;
  private readonly pendingSends = new Set<Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;

  // Shared protocol handler (handles view/ack/display/off logic for both UDP and BT)
  private protocolHandler: PpdProtocolHandler;

  // Whether we host a PPD session (answer scans with an offer + accept watchers).
  // Default true preserves the legacy "electron always hosts" behavior; the renderer
  // can toggle it via advertiseNearby (→ setHostingEnabled) for an explicit start/stop.
  private ppdSessionEnabled = true;

  private constructor(private readonly webServer: WebServer) {
    this.socket = dgram.createSocket("udp4");

    const hostInfo: PpdHostInfo = {
      getHostId: () => this.getHostId(),
      getHostName: () => this.webServer.getSettings().currentLeader || hostname(),
      shouldAdvertiseStyles: () => this.webServer.getSettings().stylesToClients,
      getChordProStylesRev: () => this.webServer.getChordProStylesRev(),
      getInlineChordProStyles: () => {
        if (this.webServer.isRunning()) return undefined;
        const styles = this.webServer.getSettings().chordProStyles;
        return styles ? (styles as unknown as Display["chordProStyles"]) : undefined;
      },
    };
    this.protocolHandler = new PpdProtocolHandler(hostInfo);
    // Start in leader mode by default (electron always hosts a session)
    this.protocolHandler.startLeading();
  }

  public handleUdpMessage(message: UdpMessage, rinfo: dgram.RemoteInfo): void {
    // Ignore messages from self (matching C# if (req.device != Program.ClientId))
    if (message.device === this.getHostId()) {
      return;
    }

    console.debug(`[UDP] Received: op=${message.op} device=${message.device} from=${rinfo.address}:${rinfo.port}`);

    if (
      message.device === this.protocolHandler.watchedDeviceId &&
      (!message.watchId || message.watchId === this.protocolHandler.watchedWatchId) &&
      (message.op === "display" || message.op === "session" || message.op === "result")
    ) {
      this.watchedLastResponseAt = Date.now();
      if ((message.op === "session" || message.op === "display") && message.version === PPD_PROTOCOL_VERSION) {
        this.watchedLivenessConfirmed = true;
      }
    }

    // Build a transport-specific send callback that includes our UDP listen port
    // so the receiver can send replies back to us.
    const sendResponse: PpdSendFn = (msg) => {
      const augmented = { ...msg, port: this.port };
      const targetPort = message.port || rinfo.port;
      console.debug(`[UDP] Sending ${msg.op} to ${rinfo.address}:${targetPort} (msg.port=${message.port}, rinfo.port=${rinfo.port})`);
      this.sendMessage(JSON.stringify(augmented), targetPort, rinfo.address);
    };

    // The protocol handler serves the leading/following ops (view/ack/display/off),
    // which always carry a `device`. Only url-only discovery offers omit it — those
    // are handled purely as discovery data in the switch below, not routed here.
    if (message.device) {
      this.protocolHandler.handleMessage(message as import("./ppd-protocol").PpdMessage, sendResponse);
    }

    // Transport-specific handling
    switch (message.op) {
      case "scan":
        this.handleScanRequest(message, rinfo);
        break;
      case "offer":
        this.handleOfferMessage(message, rinfo);
        break;
      case "off":
        // Also remove from discovered sessions
        this.handleOffMessage(message, rinfo);
        break;
    }
  }

  private handleOfferMessage(message: UdpMessage, rinfo: dgram.RemoteInfo): void {
    if (!message.device && !message.url) return;

    const sessionId = message.device || `web_${message.url}`;
    const offerPort = message.port ?? (message.device ? rinfo.port : undefined);

    const session: LocalSessionInfo = {
      id: sessionId,
      name: message.name || message.device || message.url || sessionId,
      deviceId: message.device || sessionId,
      hostId: message.id || message.device || rinfo.address, // Store hostname from offer's id field
      url: message.url || (message.device && offerPort != null ? `udp://${rinfo.address}:${offerPort}/${message.device}` : ""),
      address: rinfo.address,
      port: offerPort,
      detected: Date.now(),
      protocolVersion: message.version,
      capabilities: message.capabilities,
    };

    this.discoveredSessions.set(sessionId, session);
    for (const listener of this.sessionChangeListeners) {
      try {
        listener("discovered", session.id, session.name);
      } catch {
        /* listener errors are intentionally ignored */
      }
    }
  }

  private handleOffMessage(message: UdpMessage, _rinfo: dgram.RemoteInfo): void {
    if (message.device) {
      const name = this.discoveredSessions.get(message.device)?.name;
      this.discoveredSessions.delete(message.device);
      for (const listener of this.sessionChangeListeners) {
        try {
          listener("disappeared", message.device, name);
        } catch {
          /* listener errors are intentionally ignored */
        }
      }
    }
  }

  public onSessionChanged(listener: SessionChangeCallback): () => void {
    this.sessionChangeListeners.add(listener);
    return () => {
      this.sessionChangeListeners.delete(listener);
    };
  }

  /**
   * Enable/disable hosting a PPD session. When disabled we stop answering scans with
   * an offer (so we become undiscoverable) and stop leading (which notifies current
   * watchers and halts display retransmits). Toggled from the renderer via the
   * advertiseNearby bridge so the new session UI's Start/Stop works on the desktop.
   */
  public setPpdSessionEnabled(enabled: boolean): void {
    this.ppdSessionEnabled = enabled;
    if (enabled) this.protocolHandler.startLeading();
    else this.protocolHandler.stopLeading();
  }

  public setHostingEnabled(enabled: boolean): void {
    this.setPpdSessionEnabled(enabled);
  }

  private handleScanRequest(message: UdpMessage, rinfo: dgram.RemoteInfo): void {
    const targetPort = message.port || rinfo.port;
    // Stagger the reply. A broadcast scan lands on every host at the same instant, so
    // answering immediately makes N hosts emit N offers in the same millisecond —
    // precisely the burst a Wi-Fi cell drops once more than a few devices are around,
    // which then reads at the scanner as a peer that keeps vanishing from the list.
    setTimeout(() => {
      // Everything advertised is resolved HERE rather than when the scan arrived.
      // The reply is deferred, and the session can be stopped inside that window —
      // a pre-built offer would then advertise a dead PPD endpoint that the scanner
      // keeps listed for a full liveness window before ageing it out.
      const settings = this.webServer.getSettings();
      const webUrl = this.webServer.isRunning()
        ? `http://${settings.webServerDomainName || this.webServer.getAddress()}:${this.webServer.getPort()}${settings.webServerPath}`
        : undefined;
      if (!this.ppdSessionEnabled && !webUrl) return;

      const response: UdpMessage = {
        id: message.id,
        op: "offer",
        name: settings.currentLeader,
        // Only advertise an http url when the webserver is actually listening; with it
        // down this is a pure PPD (UDP) session — sending a dead url makes scanners try
        // to open a broken endpoint instead of following over UDP.
        url: webUrl,
        port: this.ppdSessionEnabled ? this.getPort() : undefined,
        device: this.ppdSessionEnabled ? this.getHostId() : undefined,
        version: this.ppdSessionEnabled ? PPD_PROTOCOL_VERSION : undefined,
        capabilities: this.ppdSessionEnabled ? [...PPD_CONTROL_CAPABILITIES] : undefined,
      };

      this.sendMessage(JSON.stringify(response), targetPort, rinfo.address);
    }, Math.random() * SCAN_REPLY_JITTER_MS);
  }

  public sendMessage(message: string, port: number, address: string): void {
    const encodedMsg = Buffer.from(message, "utf8").toString("base64");
    this.trackSend(this.sendDatagram(encodedMsg, port, address));
  }

  /**
   * Send an already-encoded UDP payload as-is.
   * HostDevice callers (Android-compatible flow) provide base64 payloads already,
   * so re-encoding them would break PPD parsing on receivers.
   */
  public sendRawMessage(rawMessage: string, port: number, address: string): void {
    this.trackSend(this.sendDatagram(rawMessage, port, address));
  }

  private sendDatagram(message: string, port: number, address: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket.send(message, port, address, (err) => {
          if (err) console.error(`[UDP] Send error: ${err.stack}`);
          resolve();
        });
      } catch (error) {
        console.error("[UDP] Send failed:", error);
        resolve();
      }
    });
  }

  private trackSend(pending: Promise<void>): void {
    this.pendingSends.add(pending);
    void pending.finally(() => this.pendingSends.delete(pending));
  }

  private async flushPendingSends(): Promise<void> {
    while (this.pendingSends.size > 0) {
      await Promise.all([...this.pendingSends]);
    }
  }

  // First non-internal IPv4 subnet broadcast address (the default scan target). The
  // multi-NIC picker is sourced separately from the renderer via the
  // hostdevice-get-network-interfaces IPC, so this only needs the primary address.
  public getBroadcastAddress(): string | null {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]!) {
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === "IPv4" && !net.internal) {
          const ip = net.address.split(".").map(Number);
          const subnet = net.netmask.split(".").map(Number);
          return ip.map((val, i) => val | (subnet[i] ^ 255)).join(".");
        }
      }
    }
    return null;
  }

  /**
   * Scan for local sessions via UDP broadcast (matching C# ScanForUdpServers)
   */
  public scanForSessions(broadcastAddress?: string): { success: boolean; address?: string } {
    const address = broadcastAddress || this.getBroadcastAddress() || "255.255.255.255";
    let sent = false;

    if (this.port) {
      // Enable broadcast on the socket
      try {
        this.socket.setBroadcast(true);
      } catch {
        // May already be set
      }

      for (const port of this.defaultPorts) {
        try {
          const scanRequest: UdpMessage = {
            op: "scan",
            id: this.getHostId(),
            port: this.port,
            device: this.getHostId(),
            name: hostname(),
          };
          this.sendMessage(JSON.stringify(scanRequest), port, address);
          sent = true;
        } catch (e) {
          console.error(`[UDP] Scan error on port ${port}:`, e);
        }
      }
    }

    // Age out peers that have stopped answering. The window spans several scan
    // rounds on purpose: dropping a peer after a single missed offer made the list
    // flicker whenever the network lost one broadcast frame. A clean shutdown is
    // unaffected — an explicit `off` removes the peer immediately (handleOffMessage).
    const now = Date.now();
    for (const [id, session] of this.discoveredSessions) {
      if (now - session.detected > STALE_SESSION_MS) {
        this.discoveredSessions.delete(id);
      }
    }

    return { success: sent, address: sent ? address : undefined };
  }

  /**
   * Get currently discovered local sessions
   */
  public getDiscoveredSessions(): LocalSessionInfo[] {
    return Array.from(this.discoveredSessions.values());
  }

  public getHostId(): string {
    // This is a simplified version. A more robust solution might use a persistent unique ID.
    return hostname();
  }

  public getAddress(): string {
    // Return the actual machine's IP address, not the bind address
    return getMachineIpAddress();
  }

  public getPort(): number | undefined {
    return this.port;
  }

  public onRawPacket(listener: (packet: RawUdpPacket) => void): () => void {
    this.rawPacketListeners.add(listener);
    return () => {
      this.rawPacketListeners.delete(listener);
    };
  }

  /**
   * Start watching a remote UDP session - matching C# EnterSessionWatchingMode for UDP
   * Sends periodic "view" requests to the watched device
   */
  public startWatching(
    deviceId: string,
    hostId: string,
    address: string,
    port: number,
    onDisplayUpdate: (display: unknown) => void,
    onSessionEnded: () => void
  ): void {
    // Stop any existing watch
    this.trackSend(this.stopWatchingWithReason("session-switch"));

    // Transport state (address/port for periodic view requests)
    this.watchedDeviceAddress = address;
    this.watchedDevicePort = port;

    // Protocol state (display/off handling + ACK)
    this.protocolHandler.startWatching(deviceId, onDisplayUpdate, () => {
      this.clearWatchTransportState();
      onSessionEnded();
    });
    this.watchedLastResponseAt = Date.now();
    this.watchedLivenessConfirmed = false;

    // Send initial view request
    this.sendViewRequest();

    this.scheduleWatchTimers();
  }

  /**
   * Stop watching the current UDP session - matching C# ExitSessionWatchingMode for UDP
   */
  public stopWatching(): void {
    this.trackSend(this.stopWatchingWithReason("local-stop"));
  }

  private stopWatchingWithReason(reason: "local-stop" | "session-switch" | "shutdown"): Promise<void> {
    const deviceId = this.protocolHandler.watchedDeviceId;
    const watchId = this.protocolHandler.watchedWatchId;
    const address = this.watchedDeviceAddress;
    const port = this.watchedDevicePort;
    this.clearWatchTransportState();
    this.protocolHandler.stopWatching();

    if (!deviceId || !address || !port) return Promise.resolve();
    const message = Buffer.from(
      JSON.stringify({
        op: "goodbye",
        id: deviceId,
        device: this.getHostId(),
        port: this.port,
        watchId: watchId ?? undefined,
        reason,
      }),
      "utf8"
    ).toString("base64");
    return this.sendDatagram(message, port, address);
  }

  private clearWatchTransportState(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watchDeadlineTimer) {
      clearInterval(this.watchDeadlineTimer);
      this.watchDeadlineTimer = null;
    }
    this.watchedDeviceAddress = null;
    this.watchedDevicePort = null;
    this.watchedLastResponseAt = 0;
    this.watchedLivenessConfirmed = false;
  }

  private scheduleWatchTimers(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.watchDeadlineTimer) clearInterval(this.watchDeadlineTimer);
    this.watchTimer = setInterval(() => this.sendViewRequest(), getPpdWatchHeartbeatMs(this.watchTimeoutSeconds));
    this.watchDeadlineTimer = setInterval(() => {
      if (
        this.watchedLivenessConfirmed &&
        this.watchedLastResponseAt > 0 &&
        Date.now() - this.watchedLastResponseAt >= this.watchTimeoutSeconds * 1000
      ) {
        this.protocolHandler.handleWatchTimeout();
      }
    }, 1000);
  }

  /** Apply the renderer setting to the legacy main-process follower path too. */
  public setWatchTimeoutSeconds(value: unknown): void {
    this.watchTimeoutSeconds = normalizePpdWatchTimeoutSeconds(value);
    if (this.protocolHandler.isWatching()) this.scheduleWatchTimers();
  }

  /**
   * Send a "view" request to the watched device - matching C# OnUDPWatchTimerTick
   * The web/Android client expects: id = target device ID, device = sender's device ID
   */
  private sendViewRequest(): void {
    if (!this.protocolHandler.watchedDeviceId || !this.watchedDeviceAddress || !this.watchedDevicePort) {
      return;
    }

    const viewRequest: UdpMessage = {
      op: "view",
      id: this.protocolHandler.watchedDeviceId, // Target device's ID (who we're watching)
      device: this.getHostId(), // Our device ID (who is requesting the view)
      port: this.port, // Our listening port so host can respond back
      version: PPD_PROTOCOL_VERSION,
      watchId: this.protocolHandler.watchedWatchId ?? undefined,
    };

    this.sendMessage(JSON.stringify(viewRequest), this.watchedDevicePort, this.watchedDeviceAddress);
  }

  /**
   * Check if currently watching a session
   */
  public isWatching(): boolean {
    return this.protocolHandler.isWatching();
  }

  /**
   * Get the shared protocol handler (for use by other transports via P2PTransport).
   */
  public getProtocolHandler(): PpdProtocolHandler {
    return this.protocolHandler;
  }

  /**
   * Attempts to bind the socket to a specific port
   * Returns a promise that resolves when bound or rejects on error
   */
  private async tryBind(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");

      const onError = () => {
        socket.close();
        resolve(false);
      };

      const onListening = () => {
        // Successfully bound - replace our socket with this one
        this.socket.close();
        this.socket = socket;
        this.port = port;
        this.address = socket.address().address;
        resolve(true);
      };

      socket.once("error", onError);
      socket.once("listening", onListening);

      try {
        socket.bind(port);
      } catch {
        resolve(false);
      }

      // Timeout after 1 second
      setTimeout(() => {
        socket.off("error", onError);
        socket.off("listening", onListening);
        resolve(false);
      }, 1000);
    });
  }

  /** Graceful application shutdown: notify followers before releasing the UDP socket. */
  public shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    await this.stopWatchingWithReason("shutdown");
    this.protocolHandler.dispose();
    await this.flushPendingSends();
    this.rawPacketListeners.clear();
    this.sessionChangeListeners.clear();
    await new Promise<void>((resolve) => {
      try {
        this.socket.close(resolve);
      } catch {
        resolve();
      }
    });
    if (udpServerInstance === this) udpServerInstance = null;
  }

  static async initialize(webServer: WebServer): Promise<UdpServer | null> {
    const udpServer = new UdpServer(webServer);
    const defaultPorts = [1974, 1975, 1976, 1977, 1978, 1979, 1980, 1981, 1982, 1983];

    let isBound = false;
    for (const port of defaultPorts) {
      isBound = await udpServer.tryBind(port);
      if (isBound) {
        console.info(`[UDP] Socket bound to port ${port}`);
        break;
      }
    }

    if (!isBound) {
      console.error("[UDP] Could not bind to any UDP port");
      return null;
    }

    // Setup message handling on the successfully bound socket
    udpServer.socket.on("message", (msg, rinfo) => {
      try {
        const rawMessage = msg.toString();
        const localPort = udpServer.getPort() || rinfo.port;
        const packet: RawUdpPacket = {
          message: rawMessage,
          from: rinfo.address,
          port: localPort,
        };
        for (const listener of udpServer.rawPacketListeners) {
          try {
            listener(packet);
          } catch (error) {
            console.error("[UDP] Raw packet listener error", error);
          }
        }

        const decodedMsg = Buffer.from(rawMessage, "base64").toString("utf8");
        const decoded = udpMessageCodec.decode(JSON.parse(decodedMsg));
        if (decoded._tag === "Right") {
          udpServer.handleUdpMessage(decoded.right, rinfo);
        }
      } catch {
        // Ignore invalid messages
      }
    });

    udpServer.socket.on("error", (err) => {
      console.error(`[UDP] Socket error: ${err.message}`);
    });

    // Store instance for singleton access
    udpServerInstance = udpServer;

    return udpServer;
  }
}
