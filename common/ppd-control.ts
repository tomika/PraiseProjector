import type { Display, DisplayUpdateRequest, SongData } from "./pp-types";

export const PPD_PROTOCOL_VERSION = 2 as const;

export const PPD_CONTROL_CAPABILITIES = [
  "display.watch",
  "song.fetch",
  "display.control",
  "song-preference.control",
  "playlist.control",
  "highlight.request",
  "highlight.control",
] as const;

export type PpdControlCapability = (typeof PPD_CONTROL_CAPABILITIES)[number];
export type PpdAccessMode = "verify" | "request";
export type PpdControlStatus = "ok" | "denied" | "invalid" | "unsupported" | "error";

export type PpdRemoteDisplayUpdate = DisplayUpdateRequest;

export type PpdHighlightUpdate = {
  from: number;
  to: number;
  section?: number;
};

/**
 * Superset of the legacy PPD envelope. Legacy peers ignore the v2 fields, while
 * v2 peers use session/access/command/result as a small request-response control
 * plane next to the existing view/display/ack stream.
 */
export type PpdWireMessage = {
  op: string;
  device?: string;
  id?: string;
  port?: number;
  name?: string;
  url?: string;
  display?: Display;
  songId?: string;
  songData?: SongData;
  stylesRev?: string;
  version?: number;
  requestId?: string;
  token?: string;
  capabilities?: string[];
  leaderModeAvailable?: boolean;
  access?: "highlight";
  mode?: PpdAccessMode;
  granted?: boolean;
  status?: PpdControlStatus;
  error?: string;
  command?: "display_update" | "song_update" | "highlight";
  update?: PpdRemoteDisplayUpdate;
  highlight?: PpdHighlightUpdate;
};

export type PpdPeer = {
  deviceId: string;
  address: string;
  transport: "udp" | "nearby";
  name?: string;
};

export type PpdSessionAccess = {
  version: number;
  capabilities: string[];
  leaderModeAvailable: boolean;
  controlToken?: string;
};

export type PpdControlHostCallbacks = {
  getHostId(): string;
  isLeaderAllowed(peer: PpdPeer): boolean;
  requestHighlightAccess(peer: PpdPeer, mode: PpdAccessMode): boolean | Promise<boolean>;
  applyDisplayUpdate(peer: PpdPeer, update: PpdRemoteDisplayUpdate): void | Promise<void>;
  applyHighlight(peer: PpdPeer, update: PpdHighlightUpdate): void | Promise<void>;
  getSongData(peer: PpdPeer, songId: string): SongData | undefined | Promise<SongData | undefined>;
  onHighlightControllerChanged?(deviceId: string): void;
};

type SendMessage = (message: PpdWireMessage) => void | Promise<void>;

type PeerGrant = {
  leaderToken?: string;
  highlightToken?: string;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const normalizeIdentity = (value: string): string => value.trim().toLowerCase();

const normalizeMac = (value: string): string => {
  const compact = value.trim().replace(/[:-]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(compact) ? compact : "";
};

/** Match the webserver's persisted `Device name@identifier` allowlist against
 * the identities available on PPD. Exact device/IP matching is preferred; the
 * saved device name is the fallback for MAC-based rows because browser UDP
 * bridges do not expose the peer's layer-2 address. */
export function isPpdPeerAllowlisted(peer: PpdPeer, entries: readonly string[]): boolean {
  const peerIdentifiers = [peer.deviceId, peer.address].filter(Boolean);
  return entries.some((entry) => {
    const separator = entry.lastIndexOf("@");
    const savedName = separator >= 0 ? entry.slice(0, separator).trim() : "";
    const savedIdentifier = (separator >= 0 ? entry.slice(separator + 1) : entry).trim();
    const savedMac = normalizeMac(savedIdentifier);
    const identifierMatches = peerIdentifiers.some((candidate) => {
      if (normalizeIdentity(candidate) === normalizeIdentity(savedIdentifier)) return true;
      const candidateMac = normalizeMac(candidate);
      return !!savedMac && candidateMac === savedMac;
    });
    const macNameFallback = !!savedMac && !!savedName && !!peer.name && normalizeIdentity(savedName) === normalizeIdentity(peer.name);
    return identifierMatches || macNameFallback;
  });
}

export function isPpdWireMessage(value: unknown): value is PpdWireMessage {
  if (!isObject(value) || typeof value.op !== "string") return false;
  if (value.device !== undefined && typeof value.device !== "string") return false;
  if (value.version !== undefined && (!Number.isInteger(value.version) || (value.version as number) < 1)) return false;
  if (value.requestId !== undefined && typeof value.requestId !== "string") return false;
  return true;
}

export function readPpdSessionAccess(message: PpdWireMessage): PpdSessionAccess | null {
  if (message.op !== "session" || message.version !== PPD_PROTOCOL_VERSION) return null;
  return {
    version: message.version,
    capabilities: Array.isArray(message.capabilities) ? message.capabilities.filter((value): value is string => typeof value === "string") : [],
    leaderModeAvailable: message.leaderModeAvailable === true,
    controlToken: typeof message.token === "string" && message.token ? message.token : undefined,
  };
}

function isRemoteDisplayUpdate(value: unknown): value is PpdRemoteDisplayUpdate {
  if (!isObject(value)) return false;
  if (value.command !== "display_update" && value.command !== "song_update") return false;
  return typeof value.id === "string" && typeof value.from === "number" && typeof value.to === "number";
}

function isHighlightUpdate(value: unknown): value is PpdHighlightUpdate {
  return isObject(value) && typeof value.from === "number" && typeof value.to === "number";
}

/** Host-side v2 authorization and command dispatcher. Transport and UI effects
 * are injected, keeping this module usable from Electron and browser/Android. */
export class PpdControlHost {
  private readonly grants = new Map<string, PeerGrant>();
  private readonly completed = new Map<string, PpdWireMessage>();
  private readonly inFlight = new Map<string, Promise<PpdWireMessage>>();
  private highlightController = "";
  private highlightControllerKey = "";

  constructor(
    private readonly callbacks: PpdControlHostCallbacks,
    private readonly createToken: () => string = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  ) {}

  private key(peer: PpdPeer): string {
    return `${peer.transport}:${peer.address}:${peer.deviceId}`;
  }

  private grantFor(peer: PpdPeer): PeerGrant {
    const key = this.key(peer);
    let grant = this.grants.get(key);
    if (!grant) {
      grant = {};
      this.grants.set(key, grant);
    }
    return grant;
  }

  private refreshLeaderGrant(peer: PpdPeer): PeerGrant {
    const grant = this.grantFor(peer);
    if (this.callbacks.isLeaderAllowed(peer)) grant.leaderToken ??= this.createToken();
    else grant.leaderToken = undefined;
    return grant;
  }

  sessionMessage(peer: PpdPeer): PpdWireMessage {
    const grant = this.refreshLeaderGrant(peer);
    return {
      op: "session",
      version: PPD_PROTOCOL_VERSION,
      device: this.callbacks.getHostId(),
      capabilities: [...PPD_CONTROL_CAPABILITIES],
      leaderModeAvailable: !!grant.leaderToken,
      token: grant.leaderToken,
    };
  }

  removePeer(peer: PpdPeer): void {
    const peerKey = this.key(peer);
    this.grants.delete(peerKey);
    if (this.highlightControllerKey === peerKey) {
      this.highlightController = "";
      this.highlightControllerKey = "";
      this.callbacks.onHighlightControllerChanged?.("");
    }
  }

  clear(): void {
    this.grants.clear();
    this.completed.clear();
    this.inFlight.clear();
    if (this.highlightController) this.callbacks.onHighlightControllerChanged?.("");
    this.highlightController = "";
    this.highlightControllerKey = "";
  }

  async handle(message: PpdWireMessage, peer: PpdPeer, send: SendMessage): Promise<boolean> {
    if (message.op === "view" && message.version === PPD_PROTOCOL_VERSION) {
      await send(this.sessionMessage(peer));
      return false;
    }
    if (message.op === "off") {
      this.removePeer(peer);
      return false;
    }
    if (message.version !== PPD_PROTOCOL_VERSION || (message.op !== "access" && message.op !== "command" && message.op !== "get-song")) {
      return false;
    }

    const requestId = message.requestId;
    if (!requestId) {
      await send(this.result("", "invalid", "Missing requestId"));
      return true;
    }
    const completionKey = `${this.key(peer)}:${requestId}`;
    const completed = this.completed.get(completionKey);
    if (completed) {
      await send(completed);
      return true;
    }

    const existingOperation = this.inFlight.get(completionKey);
    if (existingOperation) {
      await send(await existingOperation);
      return true;
    }

    const operation = (async (): Promise<PpdWireMessage> => {
      try {
        if (message.op === "access") return await this.handleAccess(message, peer);
        if (message.op === "get-song") return await this.handleSongRequest(message, peer);
        return await this.handleCommand(message, peer);
      } catch (error) {
        return this.result(requestId, "error", error instanceof Error ? error.message : String(error));
      }
    })();
    this.inFlight.set(completionKey, operation);
    const response = await operation;
    if (this.inFlight.get(completionKey) === operation) this.inFlight.delete(completionKey);
    this.completed.set(completionKey, response);
    if (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value as string);
    await send(response);
    return true;
  }

  private async handleAccess(message: PpdWireMessage, peer: PpdPeer): Promise<PpdWireMessage> {
    if (message.access !== "highlight" || (message.mode !== "verify" && message.mode !== "request")) {
      return this.result(message.requestId!, "unsupported", "Unsupported access request");
    }
    const grant = this.refreshLeaderGrant(peer);
    const peerKey = this.key(peer);
    const alreadyGranted = this.highlightControllerKey === peerKey && !!grant.highlightToken;

    // Verify is a read-only permission probe. In particular, a leader checking
    // its right must not take highlight ownership away from another peer.
    if (message.mode === "verify") {
      const token = grant.leaderToken ?? (alreadyGranted ? grant.highlightToken : undefined);
      return token ? { ...this.result(message.requestId!, "ok"), granted: true, token } : this.result(message.requestId!, "denied");
    }

    // Leader access already authorizes highlight commands. Ownership changes
    // only when the peer actually sends a highlight, not while asking permission.
    if (grant.leaderToken) return { ...this.result(message.requestId!, "ok"), granted: true, token: grant.leaderToken };

    if (!(await this.callbacks.requestHighlightAccess(peer, message.mode))) return this.result(message.requestId!, "denied");

    for (const [key, peerGrant] of this.grants) {
      if (key !== peerKey) peerGrant.highlightToken = undefined;
    }
    grant.highlightToken ??= this.createToken();
    this.highlightController = peer.deviceId;
    this.highlightControllerKey = peerKey;
    this.callbacks.onHighlightControllerChanged?.(peer.deviceId);
    return { ...this.result(message.requestId!, "ok"), granted: true, token: grant.highlightToken };
  }

  private async handleCommand(message: PpdWireMessage, peer: PpdPeer): Promise<PpdWireMessage> {
    const grant = this.refreshLeaderGrant(peer);
    if (message.command === "highlight") {
      if (!isHighlightUpdate(message.highlight)) return this.result(message.requestId!, "invalid", "Invalid highlight payload");
      const peerKey = this.key(peer);
      const hasLeaderToken = !!grant.leaderToken && message.token === grant.leaderToken;
      const hasActiveHighlightToken = this.highlightControllerKey === peerKey && !!grant.highlightToken && message.token === grant.highlightToken;
      if (!hasLeaderToken && !hasActiveHighlightToken) return this.result(message.requestId!, "denied");
      if (this.highlightControllerKey !== peerKey) {
        this.highlightController = peer.deviceId;
        this.highlightControllerKey = peerKey;
        this.callbacks.onHighlightControllerChanged?.(peer.deviceId);
      }
      await this.callbacks.applyHighlight(peer, message.highlight);
      return this.result(message.requestId!, "ok");
    }
    if (message.command !== "display_update" && message.command !== "song_update") {
      return this.result(message.requestId!, "unsupported", "Unsupported command");
    }
    if (!grant.leaderToken || message.token !== grant.leaderToken) return this.result(message.requestId!, "denied");
    if (!isRemoteDisplayUpdate(message.update) || message.update.command !== message.command) {
      return this.result(message.requestId!, "invalid", "Invalid display update payload");
    }
    await this.callbacks.applyDisplayUpdate(peer, message.update);
    return this.result(message.requestId!, "ok");
  }

  private async handleSongRequest(message: PpdWireMessage, peer: PpdPeer): Promise<PpdWireMessage> {
    const songId = message.songId?.trim();
    if (!songId) return this.result(message.requestId!, "invalid", "Missing songId");
    const songData = await this.callbacks.getSongData(peer, songId);
    if (!songData) return this.result(message.requestId!, "error", "Song not found");
    return { ...this.result(message.requestId!, "ok"), songId, songData };
  }

  private result(requestId: string, status: PpdControlStatus, error?: string): PpdWireMessage {
    return {
      op: "result",
      version: PPD_PROTOCOL_VERSION,
      device: this.callbacks.getHostId(),
      requestId,
      status,
      granted: status === "ok",
      error,
    };
  }
}
