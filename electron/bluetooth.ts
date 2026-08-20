/**
 * Bluetooth Serial Port Profile (SPP) Transport Layer for PraiseProjector
 *
 * This module provides Bluetooth Classic communication using SPP, allowing
 * devices to communicate without a WiFi network. Uses the same JSON message
 * protocol as UDP for consistency.
 *
 * Supports: Windows, macOS, Linux
 *
 * PAIRING REQUIREMENT:
 * Bluetooth SPP requires devices to be paired at the OS level before connecting.
 * Discovery can find unpaired devices, but connection requires prior pairing.
 * We provide a helper to open OS Bluetooth settings for the user.
 */

import { hostname } from "os";
import { shell } from "electron";
import { exec } from "child_process";
import { WebServer } from "./webserver";
import * as t from "io-ts";
import { PpdProtocolHandler, PpdSendFn } from "./ppd-protocol";

// Bluetooth serial port types (dynamically loaded)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BluetoothSerialPort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BluetoothSerialPortServer: any = null;

try {
  // Dynamic import to handle cases where native module isn't available
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const btModule = require("bluetooth-serial-port");
  BluetoothSerialPort = btModule.BluetoothSerialPort;
  BluetoothSerialPortServer = btModule.BluetoothSerialPortServer;
} catch (e) {
  console.warn("Bluetooth support not available:", e);
}

/**
 * Open the OS Bluetooth settings for the user to pair devices
 */
export function openBluetoothSettings(): void {
  const platform = process.platform;

  if (platform === "win32") {
    // Windows: Open Bluetooth settings via ms-settings URI
    shell.openExternal("ms-settings:bluetooth");
  } else if (platform === "darwin") {
    // macOS: Open Bluetooth preferences
    exec("open /System/Library/PreferencePanes/Bluetooth.prefPane");
  } else if (platform === "linux") {
    // Linux: Try common Bluetooth manager apps
    exec(
      "which blueman-manager && blueman-manager || which gnome-control-center && gnome-control-center bluetooth || xdg-open x-scheme-handler/bluetooth",
      (error) => {
        if (error) {
          console.warn("Could not open Bluetooth settings on Linux:", error.message);
        }
      }
    );
  }
}

// Service UUID for PraiseProjector Bluetooth communication
// This is a custom UUID that identifies our application
const PP_SERVICE_UUID = "00001101-0000-1000-8000-00805F9B34FB"; // Standard SPP UUID
const PP_SERVICE_NAME = "PraiseProjector";

// Message codec - same as UDP for protocol consistency
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

const bluetoothMessageCodec = t.intersection([
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
      t.literal("hello"), // Initial handshake
      t.literal("goodbye"), // Disconnection notice
      t.literal("session"),
      t.literal("access"),
      t.literal("command"),
      t.literal("result"),
    ]),
  }),
  t.partial({
    id: t.string,
    port: t.number,
    name: t.string,
    url: t.string,
    device: t.string,
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

type BluetoothMessage = t.TypeOf<typeof bluetoothMessageCodec>;

// Discovered Bluetooth device info
export interface BluetoothDeviceInfo {
  address: string;
  name: string;
  channel?: number;
  detected: number; // timestamp
  connected: boolean;
}

// Connected peer info
interface ConnectedPeer {
  address: string;
  name: string;
  deviceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any; // BluetoothSerialPort instance
  buffer: string; // Partial message buffer for handling fragmented data
}

// Module-level instance for singleton access
let bluetoothServerInstance: BluetoothServer | null = null;

export function getBluetoothServerInstance(): BluetoothServer | null {
  return bluetoothServerInstance;
}

export function isBluetoothAvailable(): boolean {
  return BluetoothSerialPort !== null && BluetoothSerialPortServer !== null;
}

export class BluetoothServer {
  private discoveredDevices: Map<string, BluetoothDeviceInfo> = new Map();
  private connectedPeers: Map<string, ConnectedPeer> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private server: any = null; // BluetoothSerialPortServer instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null; // BluetoothSerialPort instance for discovery/client connections
  private isAdvertising = false;
  private isDiscovering = false;

  // Watch mode transport state (protocol state is in shared protocolHandler)
  private watchedDeviceAddress: string | null = null;
  private deviceEventCallback: ((event: string, address: string, name: string) => void) | null = null;

  // Shared protocol handler (set via setProtocolHandler, same instance as UDP)
  private protocolHandler: PpdProtocolHandler | null = null;

  private constructor(private readonly webServer: WebServer) {}

  /**
   * Check if Bluetooth is available on this system
   */
  public static isAvailable(): boolean {
    return isBluetoothAvailable();
  }

  /**
   * Initialize the Bluetooth server
   */
  public static async initialize(webServer: WebServer): Promise<BluetoothServer | null> {
    if (!isBluetoothAvailable()) {
      console.warn("Bluetooth is not available on this system");
      return null;
    }

    const server = new BluetoothServer(webServer);
    bluetoothServerInstance = server;
    return server;
  }

  /**
   * Set the shared PPD protocol handler (same instance used by UDP).
   */
  public setProtocolHandler(handler: PpdProtocolHandler): void {
    this.protocolHandler = handler;
  }

  /**
   * Get the device's hostname as its ID (same as UDP)
   */
  public getHostId(): string {
    return hostname();
  }

  /**
   * Start advertising this device as a Bluetooth server
   * Other devices can discover and connect to us
   */
  public startAdvertising(): boolean {
    if (!BluetoothSerialPortServer || this.isAdvertising) {
      return false;
    }

    try {
      this.server = new BluetoothSerialPortServer();

      this.server.listen(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (clientAddress: string, _channel: number, connection: any) => {
          console.log(`Bluetooth client connected: ${clientAddress}`);
          this.handleClientConnection(clientAddress, connection);
        },
        (error: Error) => {
          console.error("Bluetooth server error:", error);
        },
        {
          uuid: PP_SERVICE_UUID,
          name: PP_SERVICE_NAME,
        }
      );

      this.isAdvertising = true;
      console.log("Bluetooth advertising started");
      return true;
    } catch (e) {
      console.error("Failed to start Bluetooth advertising:", e);
      return false;
    }
  }

  /**
   * Stop advertising
   */
  public stopAdvertising(): boolean {
    if (this.server) {
      try {
        this.server.close();
        this.server = null;
        this.isAdvertising = false;
        console.log("Bluetooth advertising stopped");
        return true;
      } catch (e) {
        console.error("Failed to stop Bluetooth advertising:", e);
      }
    }
    return false;
  }

  /**
   * Start discovering nearby Bluetooth devices
   */
  public startDiscovery(onDeviceFound?: (device: BluetoothDeviceInfo) => void, onDeviceLost?: (address: string) => void): boolean {
    if (!BluetoothSerialPort || this.isDiscovering) {
      return false;
    }

    try {
      this.client = new BluetoothSerialPort();
      this.isDiscovering = true;

      // Clear stale devices before starting new discovery
      const now = Date.now();
      const staleThreshold = 30000; // 30 seconds
      for (const [address, device] of this.discoveredDevices) {
        if (now - device.detected > staleThreshold && !device.connected) {
          this.discoveredDevices.delete(address);
          onDeviceLost?.(address);
        }
      }

      this.client.on("found", (address: string, name: string) => {
        const device: BluetoothDeviceInfo = {
          address,
          name: name || address,
          detected: Date.now(),
          connected: false,
        };
        this.discoveredDevices.set(address, device);
        onDeviceFound?.(device);
        this.deviceEventCallback?.("discovered", address, name || address);
      });

      this.client.on("finished", () => {
        // Discovery cycle finished, restart if still in discovery mode
        if (this.isDiscovering) {
          setTimeout(() => {
            if (this.isDiscovering && this.client) {
              this.client.inquire();
            }
          }, 5000); // Wait 5 seconds before next scan
        }
      });

      // Start the inquiry
      this.client.inquire();
      console.log("Bluetooth discovery started");
      return true;
    } catch (e) {
      console.error("Failed to start Bluetooth discovery:", e);
      this.isDiscovering = false;
      return false;
    }
  }

  /**
   * Stop discovering
   */
  public stopDiscovery(): boolean {
    this.isDiscovering = false;
    // The client will stop after the current inquiry cycle
    console.log("Bluetooth discovery stopping...");
    return true;
  }

  /**
   * Connect to a discovered Bluetooth device
   */
  public connect(address: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!BluetoothSerialPort) {
        resolve(false);
        return;
      }

      const device = this.discoveredDevices.get(address);
      if (!device) {
        console.error("Device not found:", address);
        resolve(false);
        return;
      }

      try {
        const connection = new BluetoothSerialPort();

        // Find the channel for the device
        connection.findSerialPortChannel(
          address,
          (channel: number) => {
            connection.connect(
              address,
              channel,
              () => {
                console.log(`Connected to Bluetooth device: ${address}`);

                const peer: ConnectedPeer = {
                  address,
                  name: device.name,
                  deviceId: device.name, // Will be updated with hello message
                  connection,
                  buffer: "",
                };
                this.connectedPeers.set(address, peer);
                device.connected = true;
                device.channel = channel;

                // Set up data handler
                this.setupDataHandler(peer);

                // Send hello message
                this.sendMessageToPeer(address, {
                  op: "hello",
                  device: this.getHostId(),
                  name: this.webServer.getSettings().currentLeader,
                });

                this.deviceEventCallback?.("connected", address, device.name);
                resolve(true);
              },
              () => {
                console.error("Failed to connect to device:", address);
                this.deviceEventCallback?.("connection failed", address, device.name);
                resolve(false);
              }
            );
          },
          () => {
            console.error("Failed to find channel for device:", address);
            resolve(false);
          }
        );
      } catch (e) {
        console.error("Bluetooth connect error:", e);
        resolve(false);
      }
    });
  }

  /**
   * Disconnect from a peer
   */
  public disconnect(address?: string): void {
    if (address) {
      const peer = this.connectedPeers.get(address);
      if (peer) {
        try {
          // Send goodbye message before disconnecting
          this.sendMessageToPeer(address, { op: "goodbye", device: this.getHostId() });
          peer.connection.close();
        } catch (e) {
          console.error("Error closing connection:", e);
        }
        this.connectedPeers.delete(address);

        const device = this.discoveredDevices.get(address);
        if (device) {
          device.connected = false;
        }
        this.deviceEventCallback?.("disconnected", address, peer.name);
      }
    } else {
      // Disconnect all
      for (const [addr] of this.connectedPeers) {
        this.disconnect(addr);
      }
    }
  }

  /**
   * Send a message to a connected peer
   */
  public sendMessageToPeer(address: string, message: BluetoothMessage): boolean {
    const peer = this.connectedPeers.get(address);
    if (!peer) {
      console.error("Peer not connected:", address);
      return false;
    }

    try {
      // Use newline as message delimiter
      const data = JSON.stringify(message) + "\n";
      peer.connection.write(Buffer.from(data), (err: Error | null) => {
        if (err) {
          console.error("Bluetooth write error:", err);
        }
      });
      return true;
    } catch (e) {
      console.error("Failed to send Bluetooth message:", e);
      return false;
    }
  }

  /**
   * Broadcast a message to all connected peers
   */
  public broadcastMessage(message: BluetoothMessage): void {
    for (const [address] of this.connectedPeers) {
      this.sendMessageToPeer(address, message);
    }
  }

  /**
   * Handle incoming client connection (when we're the server)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleClientConnection(address: string, connection: any): void {
    const peer: ConnectedPeer = {
      address,
      name: address, // Will be updated with hello message
      deviceId: address,
      connection,
      buffer: "",
    };
    this.connectedPeers.set(address, peer);

    // Set up data handler
    this.setupDataHandler(peer);

    // Send hello message
    this.sendMessageToPeer(address, {
      op: "hello",
      device: this.getHostId(),
      name: this.webServer.getSettings().currentLeader,
    });
  }

  /**
   * Set up data handler for a peer connection
   */
  private setupDataHandler(peer: ConnectedPeer): void {
    peer.connection.on("data", (buffer: Buffer) => {
      peer.buffer += buffer.toString();

      // Process complete messages (newline-delimited)
      const lines = peer.buffer.split("\n");
      peer.buffer = lines.pop() || ""; // Keep incomplete message in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(peer, line.trim());
        }
      }
    });

    peer.connection.on("closed", () => {
      console.log(`Bluetooth connection closed: ${peer.address}`);
      this.connectedPeers.delete(peer.address);

      const device = this.discoveredDevices.get(peer.address);
      if (device) {
        device.connected = false;
      }

      this.deviceEventCallback?.("disconnected", peer.address, peer.name);

      // If we were watching this device, clean up
      if (peer.address === this.watchedDeviceAddress) {
        this.stopWatching();
      }
      // Also remove as a watcher if it was viewing our display
      this.protocolHandler?.removeWatcher(peer.deviceId);
    });

    peer.connection.on("failure", (err: Error) => {
      console.error(`Bluetooth connection failure: ${peer.address}`, err);
    });
  }

  /**
   * Handle incoming message from a peer
   */
  private handleMessage(peer: ConnectedPeer, data: string): void {
    try {
      const parsed = JSON.parse(data);
      const decoded = bluetoothMessageCodec.decode(parsed);

      if (decoded._tag !== "Right") {
        console.error("Invalid Bluetooth message:", data);
        return;
      }

      const message = decoded.right;

      // Build a transport-specific send callback for this peer
      const sendResponse: PpdSendFn = (msg) => {
        this.sendMessageToPeer(peer.address, msg as BluetoothMessage);
      };

      // Route through shared protocol handler (handles view, ack, display, off)
      if (this.protocolHandler && message.device) {
        this.protocolHandler.handleMessage(message as import("./ppd-protocol").PpdMessage, sendResponse);
      }

      // BT-specific handling
      switch (message.op) {
        case "hello":
          // Update peer info with actual device name/id
          if (message.device) {
            peer.deviceId = message.device;
          }
          if (message.name) {
            peer.name = message.name;
          }
          // Add to discovered devices if not already there
          if (!this.discoveredDevices.has(peer.address)) {
            this.discoveredDevices.set(peer.address, {
              address: peer.address,
              name: peer.name,
              detected: Date.now(),
              connected: true,
            });
          }
          this.deviceEventCallback?.("connected", peer.address, peer.name);
          break;

        case "goodbye":
          this.disconnect(peer.address);
          break;

        case "offer":
          // Device is offering its services
          if (!this.discoveredDevices.has(peer.address)) {
            this.discoveredDevices.set(peer.address, {
              address: peer.address,
              name: message.name || peer.name,
              detected: Date.now(),
              connected: true,
            });
          }
          break;

        case "off":
          // Device going offline — also disconnect BT peer
          this.disconnect(peer.address);
          break;
      }
    } catch (e) {
      console.error("Failed to parse Bluetooth message:", e, data);
    }
  }

  /**
   * Start watching a remote Bluetooth device
   */
  public startWatching(address: string, onDisplayUpdate: (display: unknown) => void, onSessionEnded: () => void): void {
    this.stopWatching();

    this.watchedDeviceAddress = address;

    // Get the peer's device ID for protocol handler matching
    const peer = this.connectedPeers.get(address);
    const deviceId = peer?.deviceId || address;

    // Protocol state (display/off handling + ACK)
    this.protocolHandler?.startWatching(deviceId, onDisplayUpdate, onSessionEnded);

    // Send initial view request
    this.sendViewRequest();
  }

  /**
   * Stop watching
   */
  public stopWatching(): void {
    this.watchedDeviceAddress = null;
    this.protocolHandler?.stopWatching();
  }

  /**
   * Send view request to watched device
   */
  private sendViewRequest(): void {
    if (!this.watchedDeviceAddress) return;

    const peer = this.connectedPeers.get(this.watchedDeviceAddress);
    if (peer) {
      this.sendMessageToPeer(this.watchedDeviceAddress, {
        op: "view",
        id: peer.deviceId,
        device: this.getHostId(),
      });
    }
  }

  /**
   * Set device event callback
   */
  public setDeviceEventCallback(callback: (event: string, address: string, name: string) => void): void {
    this.deviceEventCallback = callback;
  }

  /**
   * Get list of discovered devices
   */
  public getDiscoveredDevices(): BluetoothDeviceInfo[] {
    return Array.from(this.discoveredDevices.values());
  }

  /**
   * Get list of connected peers
   */
  public getConnectedPeers(): { address: string; name: string; deviceId: string }[] {
    return Array.from(this.connectedPeers.values()).map((p) => ({
      address: p.address,
      name: p.name,
      deviceId: p.deviceId,
    }));
  }

  /**
   * Check if currently advertising
   */
  public isCurrentlyAdvertising(): boolean {
    return this.isAdvertising;
  }

  /**
   * Check if currently discovering
   */
  public isCurrentlyDiscovering(): boolean {
    return this.isDiscovering;
  }

  /**
   * Cleanup and shutdown
   */
  public shutdown(): void {
    this.stopWatching();
    this.disconnect(); // Disconnect all peers
    this.stopDiscovery();
    this.stopAdvertising();
  }
}
