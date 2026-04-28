/**
 * PPD (PraiseProjector Direct) Protocol Handler
 *
 * Transport-agnostic protocol state machine shared by UDP and Bluetooth transports.
 * Implements the same protocol as the mobile client (praiseprojector.ts):
 *
 * Leader mode (hosting a session):
 *   - Responds to "view" by registering watcher and pushing display updates
 *   - Tracks ACK state per watcher; retransmits unacked displays
 *   - Responds to "scan" (delegated — transport constructs the offer)
 *
 * Viewer mode (watching a remote session):
 *   - Receives "display" and forwards to callback
 *   - Sends "ack" back to leader (the missing piece that caused retransmits)
 *   - Handles "off" (leader stopped session)
 */

import { Display, PpdMessage } from "../common/pp-types";
import { getEmptyDisplay } from "../common/pp-utils";
import { getCurrentDisplay, registerDisplayChangeListener } from "./display";

export type { PpdMessage };

/** Callback to send a PPD message to a peer. Transport provides this. */
export type PpdSendFn = (message: PpdMessage) => void;

/** Identity info the protocol handler needs from the host. */
export interface PpdHostInfo {
  /** This device's unique ID (hostname). */
  getHostId(): string;
  /** Friendly display name for this device (leader name). */
  getHostName(): string;
  /** Whether style metadata should be advertised to clients. */
  shouldAdvertiseStyles(): boolean;
}

/** Tracks a remote viewer subscribed to our display (leader mode). */
interface PpdWatcher {
  peerId: string;
  sendMessage: PpdSendFn;
  lastRequestArrived: number;
  lastDisplaySent: number;
  lastDisplayAcked: boolean;
  lastDisplay?: string;
  unregisterDisplayListener?: () => void;
}

export class PpdProtocolHandler {
  // ── Leader mode state ──
  private watchers = new Map<string, PpdWatcher>();
  private _isLeading = false;
  private retransmitTimer: NodeJS.Timeout | null = null;

  // ── Viewer mode state ──
  private _watchedDeviceId: string | null = null;
  private displayUpdateCallback: ((display: unknown) => void) | null = null;
  private sessionEndedCallback: (() => void) | null = null;

  constructor(private readonly host: PpdHostInfo) {}

  get isLeading(): boolean {
    return this._isLeading;
  }
  get watchedDeviceId(): string | null {
    return this._watchedDeviceId;
  }
  get watcherCount(): number {
    return this.watchers.size;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Message dispatch
  // ─────────────────────────────────────────────────────────────────

  /**
   * Process an incoming PPD protocol message.
   *
   * @param message  Decoded PPD message
   * @param sendResponse  Callback to reply to the sender (transport-specific)
   *
   * The transport should always call this, then handle transport-specific ops
   * (scan, offer, discovery) itself.  The protocol handler processes:
   * view, ack, display, off.
   */
  handleMessage(message: PpdMessage, sendResponse: PpdSendFn): void {
    // Ignore own messages
    if (message.device === this.host.getHostId()) return;

    switch (message.op) {
      case "view":
        this.handleView(message, sendResponse);
        break;

      case "ack":
        this.handleAck(message);
        break;

      case "display":
        this.handleDisplay(message, sendResponse);
        break;

      case "off":
        this.handleOff(message);
        break;

      // scan, offer, hello, goodbye — handled by transport layer
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Leader mode
  // ─────────────────────────────────────────────────────────────────

  /** Start leading a session (accept watchers). */
  startLeading(): void {
    if (this._isLeading) return;
    this._isLeading = true;
    // Retransmit unacked displays and prune stale watchers periodically
    this.retransmitTimer = setInterval(() => this.retransmitTick(), 500);
  }

  /** Stop leading and notify all watchers. */
  stopLeading(): void {
    if (!this._isLeading) return;
    for (const watcher of this.watchers.values()) {
      try {
        watcher.sendMessage({ op: "off", device: this.host.getHostId() });
      } catch {
        /* ignore send errors during shutdown */
      }
      watcher.unregisterDisplayListener?.();
    }
    this.watchers.clear();
    this._isLeading = false;
    if (this.retransmitTimer) {
      clearInterval(this.retransmitTimer);
      this.retransmitTimer = null;
    }
  }

  /** Remove a specific watcher (e.g. when its transport connection is lost). */
  removeWatcher(peerId: string): void {
    const watcher = this.watchers.get(peerId);
    if (watcher) {
      watcher.unregisterDisplayListener?.();
      this.watchers.delete(peerId);
    }
  }

  private handleView(message: PpdMessage, sendResponse: PpdSendFn): void {
    if (!this._isLeading) return;
    if (message.id && message.id !== this.host.getHostId()) return;

    const peerId = message.device;
    if (!peerId) return;

    const now = Date.now();
    let watcher = this.watchers.get(peerId);

    if (watcher) {
      // Existing watcher — refresh keepalive and update sender
      // (address/port may have changed)
      watcher.lastRequestArrived = now;
      watcher.sendMessage = sendResponse;
    } else {
      // New watcher — register a display change listener so we push updates
      watcher = {
        peerId,
        sendMessage: sendResponse,
        lastRequestArrived: now,
        lastDisplaySent: 0,
        lastDisplayAcked: false,
        lastDisplay: undefined,
      };
      this.watchers.set(peerId, watcher);

      const unregister = registerDisplayChangeListener((display) => {
        const w = this.watchers.get(peerId);
        if (w) this.sendDisplayToWatcher(w, display);
      }, getCurrentDisplay());

      watcher.unregisterDisplayListener = unregister;
    }

    // Send current display immediately
    this.sendDisplayToWatcher(watcher, getCurrentDisplay());
  }

  private handleAck(message: PpdMessage): void {
    if (!this._isLeading) return;
    // Mobile client sends: { op: "ack", id: <leader_device_id>, device: <viewer_device_id> }
    if (message.id !== this.host.getHostId()) return;

    const watcher = this.watchers.get(message.device);
    if (watcher) {
      watcher.lastDisplayAcked = true;
      console.debug(`[PPD] ACK from ${message.device}`);
    }
  }

  private sendDisplayToWatcher(watcher: PpdWatcher, display: Display): void {
    const now = Date.now();
    const clientDisplay = this.prepareDisplayForClient(display);
    const disp = JSON.stringify(clientDisplay);
    watcher.lastDisplaySent = now;
    watcher.lastDisplay = disp;
    watcher.lastDisplayAcked = false;
    watcher.sendMessage({
      op: "display",
      name: this.host.getHostName(),
      display: clientDisplay,
      device: this.host.getHostId(),
    });
  }

  private prepareDisplayForClient(display: Display): Display {
    const clientDisplay: Display = {
      ...display,
      playlist: display.playlist ? [...display.playlist] : display.playlist,
    };

    delete clientDisplay.chordProStyles;
    if (!this.host.shouldAdvertiseStyles()) {
      delete clientDisplay.chordProStylesRev;
    }

    return clientDisplay;
  }

  /** Periodic tick: retransmit unacked displays and prune stale watchers. */
  private retransmitTick(): void {
    const now = Date.now();
    const dropLimit = now - 120_000; // 2 min timeout (matching mobile client)
    const toRemove: string[] = [];

    for (const [id, watcher] of this.watchers) {
      if (watcher.lastRequestArrived < dropLimit) {
        toRemove.push(id);
      } else if (!watcher.lastDisplayAcked && watcher.lastDisplay && watcher.lastDisplaySent < now - 500) {
        // Retransmit unacked display
        watcher.lastDisplaySent = now;
        try {
          watcher.sendMessage({
            op: "display",
            name: this.host.getHostName(),
            display: JSON.parse(watcher.lastDisplay),
            device: this.host.getHostId(),
          });
        } catch (error) {
          console.error(`[PPD] Retransmit failed for ${id}:`, error);
        }
      }
    }

    for (const id of toRemove) {
      const watcher = this.watchers.get(id);
      watcher?.unregisterDisplayListener?.();
      this.watchers.delete(id);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Viewer mode
  // ─────────────────────────────────────────────────────────────────

  /** Start watching a remote device for display updates. */
  startWatching(deviceId: string, onDisplayUpdate: (display: unknown) => void, onSessionEnded: () => void): void {
    this.stopWatching();
    this._watchedDeviceId = deviceId;
    this.displayUpdateCallback = onDisplayUpdate;
    this.sessionEndedCallback = onSessionEnded;
    console.info(`[PPD] Now watching device: ${deviceId}`);
  }

  /** Stop watching. */
  stopWatching(): void {
    if (this._watchedDeviceId) {
      console.info(`[PPD] Stopped watching device: ${this._watchedDeviceId}`);
    }
    this._watchedDeviceId = null;
    this.displayUpdateCallback = null;
    this.sessionEndedCallback = null;
  }

  isWatching(): boolean {
    return this._watchedDeviceId !== null;
  }

  private handleDisplay(message: PpdMessage, sendResponse: PpdSendFn): void {
    if (message.device !== this._watchedDeviceId) {
      console.debug(`[PPD] Ignoring display from ${message.device} (watching: ${this._watchedDeviceId ?? "none"})`);
      return;
    }

    if (message.display && this.displayUpdateCallback) {
      this.displayUpdateCallback(message.display);
    }

    // ★ Send ACK back to leader — this is the critical missing piece.
    // The mobile client retransmits display until it receives this ack.
    console.debug(`[PPD] Sending ACK to leader ${message.device}`);
    sendResponse({
      op: "ack",
      id: message.device, // leader's device ID
      device: this.host.getHostId(), // our device ID
    });
  }

  private handleOff(message: PpdMessage): void {
    if (message.device === this._watchedDeviceId && this.sessionEndedCallback) {
      console.info(`[PPD] Watched device ${message.device} went offline`);
      const cb = this.sessionEndedCallback;
      this.stopWatching();
      cb();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Cleanup
  // ─────────────────────────────────────────────────────────────────

  dispose(): void {
    this.stopLeading();
    this.stopWatching();
  }
}
