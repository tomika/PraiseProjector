/**
 * P2P Transport Layer for PraiseProjector (Electron)
 *
 * Unified interface that wraps both UDP and Bluetooth transport layers.
 * Uses endpoint ID prefixes to internally route messages:
 * - "udp_" prefix: UDP/WiFi transport
 * - "bt_" prefix: Bluetooth SPP transport
 *
 * Frontend code uses the same API regardless of underlying transport.
 */

import { hostname } from "os";
import { UdpServer } from "./udp";
import { BluetoothServer } from "./bluetooth";
import { WebServer } from "./webserver";

// Transport type prefixes for endpoint IDs
const UDP_PREFIX = "udp_";
const BT_PREFIX = "bt_";

/**
 * Unified session info that works across transports
 */
export interface P2PSessionInfo {
  id: string; // Prefixed endpoint ID (udp_ or bt_)
  name: string;
  deviceId: string;
  hostId: string;
  url: string;
  transport: "udp" | "bluetooth";
  // Transport-specific fields
  address?: string;
  port?: number;
  detected: number;
}

/**
 * P2P Transport status
 */
export interface P2PStatus {
  udpAvailable: boolean;
  bluetoothAvailable: boolean;
  isAdvertising: boolean;
  isDiscovering: boolean;
}

// Module-level instance
let p2pTransportInstance: P2PTransport | null = null;

export function getP2PTransportInstance(): P2PTransport | null {
  return p2pTransportInstance;
}

export class P2PTransport {
  private udpServer: UdpServer | null = null;
  private bluetoothServer: BluetoothServer | null = null;
  private isAdvertising = false;
  private isDiscovering = false;

  // Watch mode state
  private watchedEndpointId: string | null = null;
  private displayUpdateCallback: ((display: unknown) => void) | null = null;
  private sessionEndedCallback: (() => void) | null = null;

  // Nearby message callback - fires for Bluetooth peer messages (and future transports)
  private nearbyMessageCallback: ((endpointId: string, message: unknown) => void) | null = null;

  private constructor(private readonly webServer: WebServer) {}

  /**
   * Initialize the P2P transport layer with both UDP and Bluetooth
   */
  public static async initialize(webServer: WebServer, udpServer: UdpServer): Promise<P2PTransport> {
    const transport = new P2PTransport(webServer);
    transport.udpServer = udpServer;

    // Initialize Bluetooth if available
    // DISABLED: Bluetooth support is untested - re-enable when ready
    // if (isBluetoothAvailable()) {
    //   transport.bluetoothServer = await BluetoothServer.initialize(webServer);
    //   if (transport.bluetoothServer) {
    //     // Share the same PPD protocol handler instance across both transports
    //     transport.bluetoothServer.setProtocolHandler(udpServer.getProtocolHandler());
    //     // Forward Bluetooth messages as nearby events
    //     transport.bluetoothServer.onPeerMessage((address, message) => {
    //       transport.nearbyMessageCallback?.(BT_PREFIX + address, message);
    //     });
    //     console.log("P2P Transport: Bluetooth available");
    //   }
    // }

    p2pTransportInstance = transport;
    return transport;
  }

  /**
   * Register a callback for incoming messages from nearby peers.
   * Called when a Bluetooth (or future transport) peer sends a message.
   */
  public onNearbyMessage(callback: ((endpointId: string, message: unknown) => void) | null): void {
    this.nearbyMessageCallback = callback;
  }

  /**
   * Get the device's host ID
   */
  public getHostId(): string {
    return hostname();
  }

  /**
   * Start advertising on all available transports
   */
  public startAdvertising(): boolean {
    let success = false;

    // UDP advertises via responding to scan requests (always active when server is running)
    // So we just mark ourselves as advertising
    if (this.udpServer) {
      success = true;
    }

    // Start Bluetooth advertising if available
    if (this.bluetoothServer) {
      const btSuccess = this.bluetoothServer.startAdvertising();
      success = success || btSuccess;
    }

    this.isAdvertising = success;
    return success;
  }

  /**
   * Stop advertising on all transports
   */
  public stopAdvertising(): void {
    if (this.bluetoothServer) {
      this.bluetoothServer.stopAdvertising();
    }
    this.isAdvertising = false;
  }

  /**
   * Start discovery on all available transports
   */
  public startDiscovery(broadcastAddress?: string): { success: boolean } {
    let success = false;

    // UDP scan
    if (this.udpServer) {
      const udpResult = this.udpServer.scanForSessions(broadcastAddress);
      success = udpResult.success;
    }

    // Bluetooth discovery
    if (this.bluetoothServer) {
      const btSuccess = this.bluetoothServer.startDiscovery();
      success = success || btSuccess;
    }

    this.isDiscovering = success;
    return { success };
  }

  /**
   * Stop discovery on all transports
   */
  public stopDiscovery(): void {
    if (this.bluetoothServer) {
      this.bluetoothServer.stopDiscovery();
    }
    this.isDiscovering = false;
  }

  /**
   * Get all discovered sessions from all transports
   * Sessions are returned with prefixed IDs to identify their transport
   */
  public getDiscoveredSessions(): P2PSessionInfo[] {
    const sessions: P2PSessionInfo[] = [];

    // Get UDP sessions
    if (this.udpServer) {
      const udpSessions = this.udpServer.getDiscoveredSessions();
      for (const session of udpSessions) {
        sessions.push({
          id: UDP_PREFIX + session.id,
          name: session.name,
          deviceId: session.deviceId,
          hostId: session.hostId,
          url: session.url,
          transport: "udp",
          address: session.address,
          port: session.port,
          detected: session.detected,
        });
      }
    }

    // Get Bluetooth devices
    if (this.bluetoothServer) {
      const btDevices = this.bluetoothServer.getDiscoveredDevices();
      for (const device of btDevices) {
        sessions.push({
          id: BT_PREFIX + device.address,
          name: device.name || device.address,
          deviceId: device.address,
          hostId: device.name || device.address,
          url: "", // No URL for Bluetooth
          transport: "bluetooth",
          address: device.address,
          detected: device.detected,
        });
      }
    }

    return sessions;
  }

  /**
   * Connect to a session by its prefixed endpoint ID
   */
  public async connect(endpointId: string): Promise<boolean> {
    if (endpointId.startsWith(UDP_PREFIX)) {
      // UDP doesn't require explicit connection
      return true;
    } else if (endpointId.startsWith(BT_PREFIX)) {
      const address = endpointId.substring(BT_PREFIX.length);
      if (this.bluetoothServer) {
        return await this.bluetoothServer.connect(address);
      }
    }
    return false;
  }

  /**
   * Disconnect from a session
   */
  public disconnect(endpointId?: string): void {
    if (!endpointId) {
      // Disconnect all
      if (this.bluetoothServer) {
        this.bluetoothServer.disconnect();
      }
      return;
    }

    if (endpointId.startsWith(BT_PREFIX)) {
      const address = endpointId.substring(BT_PREFIX.length);
      if (this.bluetoothServer) {
        this.bluetoothServer.disconnect(address);
      }
    }
    // UDP doesn't maintain persistent connections
  }

  /**
   * Send a message to a specific endpoint
   */
  public sendMessage(endpointId: string, message: unknown): boolean {
    if (endpointId.startsWith(UDP_PREFIX)) {
      // For UDP, we need the session info to get address/port
      const sessions = this.udpServer?.getDiscoveredSessions() || [];
      const sessionId = endpointId.substring(UDP_PREFIX.length);
      const session = sessions.find((s) => s.id === sessionId);
      if (session && this.udpServer) {
        this.udpServer.sendMessage(JSON.stringify(message), session.port, session.address);
        return true;
      }
    } else if (endpointId.startsWith(BT_PREFIX)) {
      const address = endpointId.substring(BT_PREFIX.length);
      if (this.bluetoothServer) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.bluetoothServer.sendMessageToPeer(address, message as any);
      }
    }
    return false;
  }

  /**
   * Broadcast a message to all connected endpoints
   */
  public broadcastMessage(message: unknown): void {
    // UDP broadcast is handled differently (via broadcast address)
    // Bluetooth broadcast to all connected peers
    if (this.bluetoothServer) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.bluetoothServer.broadcastMessage(message as any);
    }
  }

  /**
   * Start watching a remote session for display updates
   */
  public startWatching(endpointId: string, onDisplayUpdate: (display: unknown) => void, onSessionEnded: () => void): boolean {
    this.stopWatching();

    this.watchedEndpointId = endpointId;
    this.displayUpdateCallback = onDisplayUpdate;
    this.sessionEndedCallback = onSessionEnded;

    if (endpointId.startsWith(UDP_PREFIX)) {
      const sessionId = endpointId.substring(UDP_PREFIX.length);
      const sessions = this.udpServer?.getDiscoveredSessions() || [];
      const session = sessions.find((s) => s.id === sessionId);
      if (session && this.udpServer) {
        this.udpServer.startWatching(session.deviceId, session.hostId, session.address, session.port, onDisplayUpdate, onSessionEnded);
        return true;
      }
    } else if (endpointId.startsWith(BT_PREFIX)) {
      const address = endpointId.substring(BT_PREFIX.length);
      if (this.bluetoothServer) {
        this.bluetoothServer.startWatching(address, onDisplayUpdate, onSessionEnded);
        return true;
      }
    }

    return false;
  }

  /**
   * Stop watching the current session
   */
  public stopWatching(): void {
    if (this.watchedEndpointId?.startsWith(UDP_PREFIX) && this.udpServer) {
      this.udpServer.stopWatching();
    } else if (this.watchedEndpointId?.startsWith(BT_PREFIX) && this.bluetoothServer) {
      this.bluetoothServer.stopWatching();
    }

    this.watchedEndpointId = null;
    this.displayUpdateCallback = null;
    this.sessionEndedCallback = null;
  }

  /**
   * Get current P2P transport status
   */
  public getStatus(): P2PStatus {
    return {
      udpAvailable: this.udpServer !== null,
      bluetoothAvailable: this.bluetoothServer !== null,
      isAdvertising: this.isAdvertising,
      isDiscovering: this.isDiscovering,
    };
  }

  /**
   * Clean up resources
   */
  public close(): void {
    this.stopWatching();
    this.stopAdvertising();
    this.stopDiscovery();
    // Note: Don't close udpServer here as it's managed externally
    // Bluetooth server cleanup is done via its own close method
  }
}

/**
 * Helper to determine transport type from endpoint ID
 */
export function getTransportType(endpointId: string): "udp" | "bluetooth" | null {
  if (endpointId.startsWith(UDP_PREFIX)) return "udp";
  if (endpointId.startsWith(BT_PREFIX)) return "bluetooth";
  return null;
}

/**
 * Helper to strip transport prefix from endpoint ID
 */
export function stripTransportPrefix(endpointId: string): string {
  if (endpointId.startsWith(UDP_PREFIX)) return endpointId.substring(UDP_PREFIX.length);
  if (endpointId.startsWith(BT_PREFIX)) return endpointId.substring(BT_PREFIX.length);
  return endpointId;
}
