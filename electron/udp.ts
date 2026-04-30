import dgram from "dgram";
import { networkInterfaces, hostname } from "os";
import { WebServer } from "./webserver";
import { getMachineIpAddress } from "./utils";
import * as t from "io-ts";
import { PpdProtocolHandler, PpdSendFn, PpdHostInfo } from "./ppd-protocol";

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
    ]),
    device: t.string,
  }),
  t.partial({
    id: t.string,
    port: t.number,
    name: t.string,
    url: t.string,
    display: displayCodec,
  }),
]);

type UdpMessage = t.TypeOf<typeof udpMessageCodec>;

// Discovered local session info (from UDP scan)
export interface LocalSessionInfo {
  id: string;
  name: string;
  deviceId: string;
  hostId: string; // hostname from offer's "id" field
  url: string;
  address: string;
  port: number;
  detected: number; // timestamp
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

  // Shared protocol handler (handles view/ack/display/off logic for both UDP and BT)
  private protocolHandler: PpdProtocolHandler;

  private constructor(private readonly webServer: WebServer) {
    this.socket = dgram.createSocket("udp4");

    const hostInfo: PpdHostInfo = {
      getHostId: () => this.getHostId(),
      getHostName: () => this.webServer.getSettings().currentLeader || hostname(),
      shouldAdvertiseStyles: () => this.webServer.getSettings().stylesToClients,
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

    // Build a transport-specific send callback that includes our UDP listen port
    // so the receiver can send replies back to us.
    const sendResponse: PpdSendFn = (msg) => {
      const augmented = { ...msg, port: this.port };
      const targetPort = message.port || rinfo.port;
      console.debug(`[UDP] Sending ${msg.op} to ${rinfo.address}:${targetPort} (msg.port=${message.port}, rinfo.port=${rinfo.port})`);
      this.sendMessage(JSON.stringify(augmented), targetPort, rinfo.address);
    };

    // Route through shared protocol handler (handles view, ack, display, off)
    this.protocolHandler.handleMessage(message as import("./ppd-protocol").PpdMessage, sendResponse);

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
    if (!message.device) return;

    const session: LocalSessionInfo = {
      id: message.device,
      name: message.name || message.device,
      deviceId: message.device,
      hostId: message.id || message.device, // Store hostname from offer's id field
      url: message.url || `http://${rinfo.address}:${message.port || 80}/`,
      address: rinfo.address,
      port: message.port || rinfo.port,
      detected: Date.now(),
    };

    this.discoveredSessions.set(message.device, session);
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

  private handleScanRequest(message: UdpMessage, rinfo: dgram.RemoteInfo): void {
    // Get webserver settings to respond with
    const settings = this.webServer.getSettings();

    const response: UdpMessage = {
      id: message.id,
      op: "offer",
      port: this.getPort(),
      name: settings.currentLeader,
      url: `http://${settings.webServerDomainName || this.webServer.getAddress()}:${this.webServer.getPort()}${settings.webServerPath}`,
      device: this.getHostId(),
    };

    const targetPort = message.port || rinfo.port;
    this.sendMessage(JSON.stringify(response), targetPort, rinfo.address);
  }

  public sendMessage(message: string, port: number, address: string): void {
    const encodedMsg = Buffer.from(message, "utf8").toString("base64");
    this.socket.send(encodedMsg, port, address, (err) => {
      if (err) console.error(`[UDP] Send error: ${err.stack}`);
    });
  }

  /**
   * Send an already-encoded UDP payload as-is.
   * HostDevice callers (Android-compatible flow) provide base64 payloads already,
   * so re-encoding them would break PPD parsing on receivers.
   */
  public sendRawMessage(rawMessage: string, port: number, address: string): void {
    this.socket.send(rawMessage, port, address, (err) => {
      if (err) console.error(`[UDP] Send error: ${err.stack}`);
    });
  }

  public getBroadcastAddress(): string | null {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]!) {
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === "IPv4" && !net.internal) {
          const ip = net.address.split(".").map(Number);
          const subnet = net.netmask.split(".").map(Number);
          const broadcast = ip.map((val, i) => val | (subnet[i] ^ 255));
          return broadcast.join(".");
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

    // Clean up stale sessions (older than 3 seconds)
    const now = Date.now();
    const staleThreshold = 3000;
    for (const [id, session] of this.discoveredSessions) {
      if (now - session.detected > staleThreshold) {
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
    this.stopWatching();

    // Transport state (address/port for periodic view requests)
    this.watchedDeviceAddress = address;
    this.watchedDevicePort = port;

    // Protocol state (display/off handling + ACK)
    this.protocolHandler.startWatching(deviceId, onDisplayUpdate, onSessionEnded);

    // Send initial view request
    this.sendViewRequest();

    // Start periodic timer - matching C# OnUDPWatchTimerTick (every 10 seconds)
    this.watchTimer = setInterval(() => {
      this.sendViewRequest();
    }, 10000);
  }

  /**
   * Stop watching the current UDP session - matching C# ExitSessionWatchingMode for UDP
   */
  public stopWatching(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }

    this.watchedDeviceAddress = null;
    this.watchedDevicePort = null;
    this.protocolHandler.stopWatching();
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
