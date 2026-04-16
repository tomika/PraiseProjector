import express from "express";
import cors from "cors";
import { Display, NetDisplayData } from "../common/pp-types";
import { compareDisplays, deserializePlaylist } from "../common/pp-utils";
import type { ChordProStylesSettings } from "../chordpro/chordpro_styles";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { app, ipcMain, Net } from "electron";
import { Server } from "http";
import { getMachineIpAddress } from "./utils";
import { flushAllDisplayChangeListeners, getCurrentDisplay, waitForDisplayChange } from "./display";
import { getMainWindow } from "./main";
import { ApiResponse } from "../common/ipc-types";
import net, { Socket } from "net";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Get the correct static directory path for both dev and packaged app
function getStaticDir(): string {
  if (app.isPackaged) {
    // In packaged app, __dirname is inside app.asar, public is at same level
    return path.join(process.resourcesPath, "public", "app");
  } else {
    // In development, use relative path from project root
    return path.join(__dirname, "..", "..", "public", "app");
  }
}

export interface WebServerSettings {
  webServerPort: number;
  webServerPath: string;
  webServerDomainName: string;
  webServerAcceptLanClientsOnly: boolean;
  currentLeader: string;
  longPollTimeout: number;
  allClientsCanUseLeaderMode: boolean;
  leaderModeClients: string[];
  chordProStyles: ChordProStylesSettings | null;
}

// Connected client info (matching C# ClientInfo)
export interface ConnectedClient {
  id: string; // MAC address or IP
  deviceName: string;
  validTo: number; // timestamp
}

// Pending display query request with metadata
interface PendingDisplayRequest {
  res: express.Response;
  includePlaylist: boolean;
  timeoutId: NodeJS.Timeout;
}

interface ClientIdentity {
  ip: string;
  mac: string;
  id: string;
}

export class WebServer {
  private app: express.Express;
  private server?: Server;
  private bindAddress: string = getMachineIpAddress();
  private settings: WebServerSettings;
  private remoteHighlightController: string = "";
  private pendingHighlightRequests: Map<string, express.Response> = new Map();
  // Cached pages for different admin levels (matching C# adminPage, mainPage, localhostPage)
  private mainPageContent: string = "";
  // Playlist storage (matching C# playList and playListId)
  private playlistId: string = "";
  // Connected clients tracking (matching C# Program.CurrentClients)
  private connectedClients: Map<string, ConnectedClient> = new Map();
  // Restart protection
  private isRestarting: boolean = false;
  // Manual stop flag to distinguish intentional stops from crashes
  private isManualStop: boolean = false;
  // File checksum cache for cache-busting query params (matching C# checksumCache)
  private checksumCache: Map<string, string> = new Map();
  private staticDir: string = "";
  // Net display / image state (matching C# imagePage, imageData, imageId)
  private imagePageContent: string = "";
  private currentImageData: Buffer | null = null;
  private currentImageId: string = "";
  private currentImageMimeType: "image/jpeg" | "image/png" = "image/jpeg";
  private currentImageBgColor: string = "#000000";
  private currentImageTransient: number = 200;
  private pendingImageRequests: Array<{ res: express.Response; imgid: string; timeout: NodeJS.Timeout }> = [];
  private macCache: Map<string, { mac: string; validTo: number }> = new Map();
  private leaderTokens: Map<string, string> = new Map(); // token UUID → client IP
  private static readonly CONTROL_INTENT_HEADER = "x-pp-intent";
  private static readonly CONTROL_INTENT_VALUE = "control-update";
  private static readonly LEADER_TOKEN_HEADER = "x-pp-token";

  constructor(initialSettings?: Partial<WebServerSettings>) {
    this.settings = {
      webServerPort: initialSettings?.webServerPort ?? 19740,
      webServerPath: initialSettings?.webServerPath ?? "/",
      webServerDomainName: initialSettings?.webServerDomainName ?? "",
      webServerAcceptLanClientsOnly: initialSettings?.webServerAcceptLanClientsOnly ?? true,
      longPollTimeout: initialSettings?.longPollTimeout ?? 30,
      currentLeader: initialSettings?.currentLeader ?? "",
      allClientsCanUseLeaderMode: initialSettings?.allClientsCanUseLeaderMode ?? true,
      leaderModeClients: initialSettings?.leaderModeClients ?? [],
      chordProStyles: initialSettings?.chordProStyles ?? null,
    };

    this.verifyWebServerPath();

    this.app = express();
    this.app.use(
      cors({
        origin: (origin, callback) => {
          // Same-origin requests usually have no Origin header; CORS is only for cross-origin clients.
          if (!origin) return callback(null, false);
          callback(null, this.isAllowedCorsOrigin(origin));
        },
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Accept", "Authorization", "X-Requested-With", "X-PP-Device-Name", "X_PP_DEVICE_NAME", "X-PP-Intent"],
        exposedHeaders: ["X-PP-Token"],
        optionsSuccessStatus: 204,
      })
    );
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.get("/display_styles_query", (req, res) => {
      this.setCommonHeaders(res);
      const rev = (req.query.rev as string) || "";
      const currentRev = this.getChordProStylesRev();
      if (rev && rev === currentRev) {
        res.json({ rev: currentRev, changed: false });
        return;
      }
      res.json({
        rev: currentRev,
        changed: true,
        styles: this.settings.chordProStyles ?? undefined,
      });
    });

    //log all requests and response http codes
    this.app.use((req, res, next) => {
      res.on("finish", () => {
        console.debug(`Request: ${req.method} ${req.url} Response: ${res.statusCode}`);
      });
      next();
    });

    // Add global error handler for unhandled errors
    this.app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error("[WebServer] Unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    });

    this.setupRoutes();
  }

  private verifyWebServerPath() {
    if (this.settings.webServerPath && !this.settings.webServerPath.startsWith("/")) {
      this.settings.webServerPath = "/" + this.settings.webServerPath;
    }
    if (this.settings.webServerPath && !this.settings.webServerPath.endsWith("/")) {
      this.settings.webServerPath = this.settings.webServerPath + "/";
    }
  }

  private getChordProStylesRev() {
    return this.settings.chordProStyles
      ? crypto.createHash("md5").update(JSON.stringify(this.settings.chordProStyles)).digest("hex")
      : "";
  }

  private setupRoutes() {
    this.staticDir = getStaticDir();
    console.info(`WebServer static directory: ${this.staticDir}`);

    // Load localization strings for server-side page preprocessing
    this.loadLocalizationStrings();

    // Initialize main page content with leader-mode options
    this.initMainPages(this.staticDir);
    // Initialize image page content for /netdisplay (matching C# imagePage)
    this.initImagePage(this.staticDir);

    // Preprocess path from settings
    this.app.use((req, res, next) => {
      if (this.settings.webServerPath !== "/") {
        if (req.path.startsWith(this.settings.webServerPath)) {
          const stripped = req.url.substring(this.settings.webServerPath.length);
          req.url = "/" + stripped;
        } else {
          return res.status(404).send("Not found");
        }
      }
      next();
    });

    // Restrict access to private/local network clients only.
    this.app.use((req, res, next) => {
      if (this.settings.webServerAcceptLanClientsOnly) {
        const remoteIp = this.normalizeIp(req.socket.remoteAddress || "");
        if (!this.isLanClientIp(remoteIp)) {
          console.warn(`[WebServer] Rejected non-LAN client: ${remoteIp} ${req.method} ${req.originalUrl}`);
          return res.status(403).send("LAN access only");
        }
      }
      next();
    });

    // Serve index.html with preprocessing based on client admin status
    this.app.get(/\/(index\.html?)?$/, (req, res) => {
      // Workaround: ignore client cache validators for index route,
      // always serve a fresh HTML document with current server-side options.
      delete req.headers["if-none-match"];
      delete req.headers["if-modified-since"];

      const pageContent = this.mainPageContent;
      if (!pageContent) {
        // Fallback if pages not initialized
        const indexPath = path.join(this.staticDir, "index.html");
        fs.readFile(indexPath, "utf8", (err, data) => {
          if (err) return res.status(404).send("Not found");
          const content = data.replace(/\/praiseprojector\//g, this.settings.webServerPath);
          if (this.redirectToCanonicalIndexUrl(req, res, content)) {
            return;
          }
          this.setCommonHeaders(res);
          res.type("html").send(content);
        });
        return;
      }
      if (this.redirectToCanonicalIndexUrl(req, res, pageContent)) {
        return;
      }
      this.setCommonHeaders(res);
      res.type("html").send(pageContent);
    });

    // Serve static files with aggressive caching — cache-busting query params in HTML
    // ensure clients always get updated files after app updates (matching C# cache headers)
    this.app.use(
      express.static(this.staticDir, {
        maxAge: "6d",
        etag: true,
        lastModified: true,
      })
    );

    // Setup remaining routes
    this.setupDisplayRoutes();
  }

  /**
   * Format options object for P.onLoad() injection (matching C# FormatOpt)
   */
  private formatOpt(leaderModeAvailable: boolean, leaderModeEnabled: boolean): string {
    const parts: string[] = [];
    if (leaderModeAvailable) parts.push("leaderModeAvailable: true");
    if (leaderModeEnabled) parts.push("leaderModeEnabled: true");
    return "{" + parts.join(", ") + "}";
  }

  /**
   * Initialize main page content with different admin levels (matching C# InitMainPage)
   */
  private initMainPages(staticDir: string): void {
    const indexPath = path.join(staticDir, "index.html");

    try {
      const rawContent = fs.readFileSync(indexPath, "utf8");
      // Replace /praiseprojector/ with config path and add cache-busting to file references
      this.mainPageContent = this.updateFileReferences(rawContent.replace(/\/praiseprojector\//g, this.settings.webServerPath));

      console.info("Main pages initialized with admin options");
    } catch (err) {
      console.error("Error initializing main pages:", err);
    }
  }

  private normalizeIp(address: string): string {
    if (!address) return "";
    return address.replace(/^::ffff:/i, "").trim();
  }

  private isLanClientIp(address: string): boolean {
    const ip = this.normalizeIp(address).toLowerCase();
    if (!ip) return false;

    // Localhost access from the same machine.
    if (ip === "127.0.0.1" || ip === "::1") return true;

    // RFC1918 + link-local IPv4 ranges.
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith("169.254.")) return true;

    // RFC4193 unique-local + link-local IPv6 ranges.
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;

    return false;
  }

  private isAllowedCorsOrigin(origin: string): boolean {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }

      const originHost = this.normalizeIp(parsed.hostname);
      if (!originHost) return false;

      if (originHost === "127.0.0.1" || originHost === "::1" || originHost === "localhost") {
        return true;
      }

      const configuredHost = this.normalizeIp(this.settings.webServerDomainName || "");
      if (configuredHost && originHost === configuredHost) {
        return true;
      }

      return this.isLanClientIp(originHost);
    } catch {
      return false;
    }
  }

  private hasValidControlIntent(req: express.Request): boolean {
    return !!req.header(WebServer.CONTROL_INTENT_HEADER);
  }

  private issueLeaderToken(ip: string): string {
    for (const [token, tokenIp] of this.leaderTokens) {
      if (tokenIp === ip) {
        this.leaderTokens.delete(token);
        break;
      }
    }
    const token = crypto.randomUUID();
    this.leaderTokens.set(token, ip);
    return token;
  }

  private getOrIssueLeaderToken(ip: string): string {
    for (const [token, tokenIp] of this.leaderTokens) {
      if (tokenIp === ip) return token;
    }
    return this.issueLeaderToken(ip);
  }

  private checkLeaderToken(token: string, ip: string): boolean {
    return this.leaderTokens.get(token) === ip;
  }

  private normalizeMac(mac: string): string {
    return mac.trim().toUpperCase().replace(/-/g, ":");
  }

  private extractMacAddress(rawText: string, ip: string): string {
    if (!rawText) return "";

    const macRegex = /([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/g;
    const normalizedIp = ip.trim();
    const lines = rawText.split(/\r?\n/);

    for (const line of lines) {
      if (normalizedIp && !line.includes(normalizedIp)) {
        continue;
      }
      const match = line.match(macRegex);
      if (match && match[0]) {
        return this.normalizeMac(match[0]);
      }
    }

    const first = rawText.match(macRegex);
    return first && first[0] ? this.normalizeMac(first[0]) : "";
  }

  private async resolveMacAddressForIp(ip: string): Promise<string> {
    const cached = this.macCache.get(ip);
    const now = Date.now();
    if (cached && cached.validTo > now) {
      return cached.mac;
    }

    // Validate that ip is actually an IP address before passing to execFile
    if (!net.isIP(ip)) return "";

    // Use execFile (no shell) with separate args to avoid command injection
    const commands: Array<{ cmd: string; args: string[] }> =
      process.platform === "win32"
        ? [{ cmd: "arp", args: ["-a", ip] }]
        : process.platform === "darwin"
          ? [{ cmd: "arp", args: ["-n", ip] }]
          : [
              { cmd: "ip", args: ["neigh", "show", ip] },
              { cmd: "arp", args: ["-n", ip] },
            ];

    let mac = "";
    for (const { cmd, args } of commands) {
      try {
        const { stdout } = await execFileAsync(cmd, args, { timeout: 1000 });
        mac = this.extractMacAddress(stdout, ip);
        if (mac) break;
      } catch {
        // Best effort only: keep trying fallback commands.
      }
    }

    if (mac) {
      this.macCache.set(ip, { mac, validTo: now + 60_000 });
    }

    return mac;
  }

  private async resolveClientIdentity(socket: Socket): Promise<ClientIdentity> {
    const ip = this.normalizeIp(socket.remoteAddress || "");
    const mac = ip ? await this.resolveMacAddressForIp(ip) : "";
    return {
      ip,
      mac,
      id: mac || ip,
    };
  }

  /**
   * Check if a client MAC is in the admin clients list. Falls back to IP when MAC is unavailable.
   */
  private getClientType(socket: Socket, identity: ClientIdentity): "GUEST" | "LEADER" | "LOCAL" {
    if (socket.remoteAddress === socket.localAddress) {
      return "LOCAL";
    }
    if (this.settings.allClientsCanUseLeaderMode) return "LEADER";

    const clientMac = identity.mac;
    const clientIp = identity.ip;

    for (const leaderEntry of this.settings.leaderModeClients) {
      const parts = leaderEntry.split("@");
      const identifier = (parts[parts.length - 1] || "").trim();
      const normalizedIdentifierMac = this.normalizeMac(identifier);

      if (clientMac && normalizedIdentifierMac === clientMac) {
        return "LEADER";
      }

      if (!clientMac && identifier === clientIp) {
        return "LEADER";
      }
    }
    return "GUEST";
  }

  private getContentChecksum(content: string): string {
    return crypto.createHash("sha1").update(content).digest("hex").substring(0, 12);
  }

  private redirectToCanonicalIndexUrl(req: express.Request, res: express.Response, content: string, expectedChecksum?: string): boolean {
    const canonicalChecksum = expectedChecksum ?? this.getContentChecksum(content);
    const currentRaw = req.query.v;
    const currentChecksum = Array.isArray(currentRaw) ? String(currentRaw[0] ?? "") : currentRaw != null ? String(currentRaw) : "";

    if (currentChecksum === canonicalChecksum) {
      return false;
    }

    const targetPath = this.settings.webServerPath + "index.html";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (value == null || key === "v") continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.set(key, String(value));
      }
    }
    params.set("v", canonicalChecksum);

    this.setCommonHeaders(res);
    res.redirect(302, `${targetPath}?${params.toString()}`);
    return true;
  }

  private setCommonHeaders(res: express.Response, clientType?: "GUEST" | "LEADER" | "LOCAL") {
    // Prevent HTML caching/revalidation (workaround for stale index.html)
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0, private");
    res.set("Surrogate-Control", "no-store");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.removeHeader("ETag");
    res.removeHeader("Last-Modified");

    // Defense-in-depth for browser clients on LAN.
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");

    if (clientType != null) {
      res.set("x-pp-leader-enabled", clientType === "LOCAL" ? "true" : "false");
      res.set("x-pp-leader-available", clientType !== "GUEST" ? "true" : "false");
    }
  }

  /**
   * Compute SHA1 checksum of a file for cache-busting (matching C# GetChecksum).
   * Results are cached so each file is only hashed once.
   */
  private getFileChecksum(filename: string): string {
    let checksum = this.checksumCache.get(filename);
    if (checksum) return checksum;
    try {
      const filePath = path.join(this.staticDir, filename);
      const data = fs.readFileSync(filePath);
      checksum = crypto.createHash("sha1").update(data).digest("hex").substring(0, 12);
      this.checksumCache.set(filename, checksum);
    } catch {
      checksum = "0";
    }
    return checksum;
  }

  /**
   * Append ?v=<checksum> to src/href references in HTML
   * This ensures clients fetch new versions after app updates while caching aggressively.
   */
  private updateFileReferences(content: string): string {
    return content.replace(/(?:src|href)="([^"]*\.(?:js|css))"/g, (match, filename) => {
      const checksum = this.getFileChecksum(filename);
      return match.slice(0, -1) + "?v=" + checksum + '"';
    });
  }

  // Localization strings loaded from JSON files, keyed by language code
  private locStrings: Record<string, Record<string, string>> = {};

  /**
   * Get the primary language from the Accept-Language header.
   */
  private static getClientLanguage(req: express.Request): string {
    const accept = req.headers["accept-language"] || "";
    // Parse first language tag, e.g. "hu-HU,hu;q=0.9,en;q=0.8" → "hu"
    const match = accept.match(/^([a-zA-Z]{2})/);
    return match ? match[1].toLowerCase() : "en";
  }

  /**
   * Get a localized string by key and language, falling back to English.
   */
  private getLocalizedString(lang: string, key: string): string {
    return this.locStrings[lang]?.[key] || this.locStrings["en"]?.[key] || key;
  }

  /**
   * Load localization JSON files from src/localization/ (or bundled path).
   */
  private loadLocalizationStrings(): void {
    const locDir = app.isPackaged ? path.join(process.resourcesPath, "localization") : path.join(__dirname, "..", "..", "src", "localization");

    for (const lang of ["en", "hu"]) {
      try {
        const filePath = path.join(locDir, `strings.${lang}.json`);
        const content = fs.readFileSync(filePath, "utf8");
        this.locStrings[lang] = JSON.parse(content);
      } catch (err) {
        console.warn(`[WebServer] Could not load localization for '${lang}':`, err);
      }
    }
  }

  /**
   * Initialize image page content for /netdisplay route (matching C# imagePage initialization).
   * Loads image.html and replaces /praiseprojector/ paths with /.
   */
  private initImagePage(staticDir: string): void {
    const imagePath = path.join(staticDir, "image.html");
    try {
      const rawContent = fs.readFileSync(imagePath, "utf8");
      // Replace paths and add cache-busting to file references (matching C# imagePage init)
      this.imagePageContent = this.updateFileReferences(rawContent.replace(/\/praiseprojector\//g, this.settings.webServerPath));
      console.info("Image page initialized for /netdisplay");
    } catch (err) {
      console.error("Error loading image.html for /netdisplay:", err);
    }
  }

  private setupDisplayRoutes() {
    // Serve /netdisplay page (matching C# netdisplay handler)
    // Returns image.html with bgcolor and startupImageId customization from query params
    this.app.get("/netdisplay", (req, res) => {
      if (!this.imagePageContent) {
        return res.status(404).send("Not found");
      }

      let page = this.imagePageContent;
      let bgColor = "";

      // Collect query params (matching C# building startupImageId from all query params)
      for (const [key, value] of Object.entries(req.query)) {
        if (key === "bgcolor" && typeof value === "string") bgColor = value;
      }

      // Replace background-color if custom bgcolor provided (matching C# ColorTranslator logic)
      if (bgColor && bgColor.toLowerCase() !== "black") {
        page = page.replace("background-color: black;", `background-color: ${bgColor};`);
      }

      // Inject localized toast text based on client's Accept-Language
      const lang = WebServer.getClientLanguage(req);
      const toastText = this.getLocalizedString(lang, "DoubleTapToExit");
      page = page.replace("__TOAST_TEXT__", toastText);

      res.type("html").send(page);
    });

    // Serve /image endpoint for net display image data (matching C# ImageReq long-poll)
    // Client flow:
    //   1. GET /image?id=startup → responds with current imageId (text)
    //   2. Client sets background-image: url(/image?c=<id>) → browser loads image
    //   3. GET /image?c=<id> → responds with PNG data (id param is empty)
    //   4. GET /image?id=<currentId> → long-poll, waits for image change
    this.app.get("/image", (req, res) => {
      this.setCommonHeaders(res);

      // No id param (browser image load via ?c=...): serve actual image data
      if (req.query.c) {
        if (this.currentImageData) {
          res.type(this.currentImageMimeType).send(this.currentImageData);
        } else {
          res.status(404).send("No image available");
        }
        return;
      }

      const imgid = (req.query.id as string) || "";

      // If client's id doesn't match current: respond immediately with new id
      if (imgid !== this.currentImageId) {
        res.json(this.getNetDisplayResponse());
        return;
      }

      // Long-poll: id matches, wait for image to change
      const timeoutMs = (this.settings.longPollTimeout || 30) * 1000;
      const timeout = setTimeout(() => {
        this.removePendingImageRequest(res);
        res.json(this.getNetDisplayResponse());
      }, timeoutMs);

      this.pendingImageRequests.push({ res, imgid, timeout });
    });

    this.app.get("/display_query", async (req, res) => {
      console.debug(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] /display_query received`, req.query);

      const clientIdentity = await this.resolveClientIdentity(req.socket);
      let clientType = this.getClientType(req.socket, clientIdentity);
      const forced = req.query.forced === "true";

      const currentDisplay = getCurrentDisplay();
      const verifyDisplayPlaylist = (clientDisplay: Display) => {
        if (clientType !== "GUEST" && (forced || (req.query.playlist_id ?? "") !== "")) {
          clientDisplay.playlist_id = (req.query.playlist_id as string) || currentDisplay.playlist_id;
          clientDisplay.playlist = currentDisplay.playlist ? [...currentDisplay.playlist] : [];
        }
      };

      // Track connected clien
      const deviceName = (req.headers["x_pp_device_name"] as string) || (req.headers["x-pp-device-name"] as string) || "";
      if (deviceName && clientIdentity.id) this.trackClient(clientIdentity.id, deviceName);

      try {
        const stylesRev = this.getChordProStylesRev();
        const clientDisplay: Display = {
          songId: (req.query.id as string) || currentDisplay.songId,
          song: currentDisplay.song,
          system: currentDisplay.system,
          from: req.query.from != null ? parseInt((req.query.from as string) || "0", 10) : currentDisplay.from,
          to: req.query.to != null ? parseInt((req.query.to as string) || "0", 10) : currentDisplay.to,
          transpose: (req.query.transpose ?? "") !== "" ? parseInt(req.query.transpose as string, 10) : currentDisplay.transpose,
          capo: (req.query.capo ?? "") !== "" ? parseInt(req.query.capo as string, 10) : currentDisplay.capo,
          instructions: (req.query.instructions ?? "") !== "" ? (req.query.instructions as string) : currentDisplay.instructions,
          section: (req.query.section ?? "") !== "" ? parseInt((req.query.section as string) || "-1", 10) : currentDisplay.section,
          message: (req.query.message ?? "") !== "" ? (req.query.message as string) : currentDisplay.message,
          chordProStylesRev: (req.query.chordpro_styles_rev as string) || "",
        };

        verifyDisplayPlaylist(clientDisplay);

        console.debug(`[WebServer] display_query: forced=${forced}`);

        // If forced or state changed, respond immediately
        let newDisplay =
          forced ||
          clientDisplay.chordProStylesRev !== stylesRev ||
          !compareDisplays(clientDisplay, clientType !== "GUEST" ? currentDisplay : { ...currentDisplay, playlist_id: undefined })
            ? currentDisplay
            : undefined;

        if (!newDisplay) {
          console.debug(
            `[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] display_query: waiting for changes from client display:`,
            {
              songId: clientDisplay.songId,
              from: clientDisplay.from,
              to: clientDisplay.to,
              transpose: clientDisplay.transpose,
              capo: clientDisplay.capo,
            }
          );
          // Long poll - wait for changes with timeout
          const timeoutMs = (this.settings.longPollTimeout || 30) * 1000;
          newDisplay = await waitForDisplayChange(clientDisplay, timeoutMs, () => req.socket.destroyed);
        }
        if (!req.socket.destroyed) {
          // reget client type in case it changed while waiting for display change
          clientType = this.getClientType(req.socket, clientIdentity);
          verifyDisplayPlaylist(clientDisplay);
          this.setCommonHeaders(res, clientType);
          // Issue a leader token so future control requests skip MAC lookup
          if (clientType !== "GUEST" && !this.settings.allClientsCanUseLeaderMode) {
            res.set(WebServer.LEADER_TOKEN_HEADER, this.getOrIssueLeaderToken(clientIdentity.ip));
          }

          const displayToSend = clientType !== "GUEST" ? newDisplay : { ...newDisplay, playlist: undefined, playlist_id: undefined }; // Hide playlist from non-admins
          displayToSend.chordProStylesRev = stylesRev;
          delete displayToSend.chordProStyles;
          console.debug(
            `[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] display_query: responding with new display:`,
            displayToSend
          );
          res.json(displayToSend);
        } else console.debug(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] display_query: client disconnected before response`);
      } catch (error) {
        console.error(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] display_query error:`, error);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        this.trackClient(clientIdentity.id);
      }
    });

    // Handle highlight permission and line change requests
    this.app.get("/highlight", (req, res) => {
      this.setCommonHeaders(res);

      const permission = req.query.permission as string;
      const clientId = (req.query.deviceId as string) || "";
      const lineStr = req.query.line as string;

      if (permission === "verify" || permission === "request") {
        // For "verify", immediately check if client is the controller and respond
        if (permission === "verify") {
          const result = this.remoteHighlightController === clientId ? "GRANTED" : "DENIED";
          return res.json(result);
        }

        // For "request", if client is not already controller, ask user for approval
        // Matching C# logic: if (permissionReq == "request" && remoteHighlightContoller != clientId)
        if (permission === "request" && this.remoteHighlightController !== clientId) {
          // Store pending request for async response
          this.pendingHighlightRequests.set(clientId, res);
          // Notify frontend about highlight access request
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send("highlight-access-request", { clientId });
          }
          // Set a timeout to auto-deny if not responded
          setTimeout(() => {
            if (this.pendingHighlightRequests.has(clientId)) {
              this.pendingHighlightRequests.get(clientId)?.json("DENIED");
              this.pendingHighlightRequests.delete(clientId);
            }
          }, 30000);
          return;
        }

        // Client is already the controller - respond immediately
        const result = this.remoteHighlightController === clientId ? "GRANTED" : "DENIED";
        return res.json(result);
      }

      // Handle line highlight change
      if (lineStr && clientId === this.remoteHighlightController) {
        const lineNumber = parseInt(lineStr, 10);
        if (!isNaN(lineNumber)) {
          // Notify frontend about highlight line change
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send("highlight-changed", { line: lineNumber });
          }
        }
      }

      res.send("OK");
    });

    // Handle display_update and song_update (POST only)
    const handleRemoteUpdateRequest = async (req: express.Request, res: express.Response) => {
      console.debug(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] ${req.method} ${req.path} received`, req.body);
      this.setCommonHeaders(res);

      if (!this.hasValidControlIntent(req)) {
        console.warn(`[WebServer] Rejected ${req.path}: missing ${WebServer.CONTROL_INTENT_HEADER}`);
        res.status(403).send("Missing control intent header");
        return;
      }

      const ip = this.normalizeIp(req.socket.remoteAddress || "");
      let clientType: "GUEST" | "LEADER" | "LOCAL";

      if (req.socket.remoteAddress === req.socket.localAddress) {
        clientType = "LOCAL";
      } else if (this.settings.allClientsCanUseLeaderMode) {
        clientType = "LEADER";
      } else {
        const intentValue = req.header(WebServer.CONTROL_INTENT_HEADER) ?? "";
        // Fast path: valid token with matching IP
        if (intentValue !== WebServer.CONTROL_INTENT_VALUE && this.checkLeaderToken(intentValue, ip)) {
          clientType = "LEADER";
        } else {
          // Slow path: MAC fallback (covers server restart / stale token)
          const mac = ip ? await this.resolveMacAddressForIp(ip) : "";
          const identity: ClientIdentity = { ip, mac, id: mac || ip };
          clientType = this.getClientType(req.socket, identity);
          if (clientType !== "GUEST") {
            // Issue fresh token so client self-corrects without another fallback
            res.set(WebServer.LEADER_TOKEN_HEADER, this.issueLeaderToken(ip));
          }
        }
      }

      if (clientType === "GUEST") {
        console.warn(`[WebServer] Rejected ${req.path}: guest client (${ip})`);
        res.status(403).send("Leader access required");
        return;
      }

      const command = req.path.includes("/display_update") ? "display_update" : "song_update";
      const params = (req.body ?? {}) as Record<string, unknown>;
      const id = (params.id as string) || "";
      const from = parseInt((params.from as string) || "0", 10);
      const to = parseInt((params.to as string) || "0", 10);
      // Use undefined as default to indicate "no change" for transpose/capo
      const transposeStr = params.transpose as string;
      const capoStr = params.capo as string;
      const transpose = transposeStr !== undefined && transposeStr !== "" ? parseInt(transposeStr, 10) : undefined;
      const capo = capoStr !== undefined && capoStr !== "" ? parseInt(capoStr, 10) : undefined;
      const instructions = (params.instructions as string) || "";
      const title = (params.title as string) || "";
      const playlist = deserializePlaylist(params.playlist);

      console.debug("[WebServer] display_update:", {
        method: req.method,
        id,
        from,
        to,
        transpose,
        capo,
        instructions,
        title,
        playlist,
      });

      // Notify main window about song change (matching C# SongChanged delegate)
      const mainWindow = getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send("remote-display-update", { command, id, from, to, transpose, capo, instructions, title, playlist });
      }

      let remainingTime = 3000;
      let currentDisplay = getCurrentDisplay();
      const end = Date.now() + remainingTime;
      while (command === "display_update" && id && currentDisplay.songId !== id && remainingTime > 0) {
        await waitForDisplayChange(currentDisplay, remainingTime, () => req.socket.destroyed);
        currentDisplay = getCurrentDisplay();
        remainingTime = end - Date.now();
      }
      if (!req.socket.destroyed) res.send("DONE");
    };

    this.app.post("/display_update", handleRemoteUpdateRequest);
    this.app.post("/song_update", handleRemoteUpdateRequest);

    // Generic POST handler for other actions
    this.app.post("/:path", (req, res) => {
      const path = req.params.path;
      console.debug(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] Generic POST to /${path}`, req.body);

      switch (path) {
        case "song":
          // Handle save song
          this.setCommonHeaders(res);
          res.json({ success: true, songId: req.body.id || "new-song-id" });
          break;
        case "playlist":
          // Handle save playlist
          this.setCommonHeaders(res);
          res.json({ success: true });
          break;
        case "delete_song":
          // Handle delete song
          this.setCommonHeaders(res);
          res.json({ success: true });
          break;
        default:
          res.status(404).send("Not Found");
      }
    });

    // General proxy - forward ALL unhandled requests to frontend (must be last!)
    this.app.use(async (req, res) => {
      console.debug(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] Proxying request to frontend: ${req.method} ${req.path}`);

      const proxyAllowedGetPaths = new Set(["/songs", "/leaders", "/search"]);
      if (req.method !== "GET" || !proxyAllowedGetPaths.has(req.path)) {
        res.status(404).json({ error: "Not Found" });
        return;
      }

      try {
        const mainWindow = getMainWindow();

        if (!mainWindow) {
          res.status(503).json({ error: "Frontend not available" });
          return;
        }

        // Forward the entire request to frontend
        const apiRequest = {
          method: req.method,
          path: req.path,
          query: req.query,
          body: req.body,
          headers: req.headers,
        };

        const response: ApiResponse = await new Promise((resolve) => {
          const handler = (_event: Electron.IpcMainEvent, apiResponse: ApiResponse) => {
            ipcMain.off("webserver-api-response", handler);
            resolve(apiResponse);
          };
          ipcMain.once("webserver-api-response", handler);

          mainWindow.webContents.send("webserver-api-request", apiRequest);

          setTimeout(() => {
            ipcMain.off("webserver-api-response", handler);
            resolve({ status: 504, data: { error: "Request timeout" } });
          }, 10000);
        });

        // Send response back to client
        res.status(response.status || 200);
        if (response.headers) {
          Object.entries(response.headers).forEach(([key, value]) => {
            res.set(key, value as string);
          });
        }
        res.json(response.data);
      } catch (error) {
        console.error(`[WebServer (${req.socket.remoteAddress}:${req.socket.remotePort})] API proxy error:`, error);
        res.status(500).json({ error: "Internal server error" });
      }
    });
  }

  public start() {
    const port = this.settings.webServerPort;
    const configuredHost = (this.settings.webServerDomainName || "").trim();
    const listenAddress = "0.0.0.0";
    // Bind on all interfaces for reliability; advertise configured host when provided.
    this.bindAddress = configuredHost || getMachineIpAddress();

    // Validate port number
    if (port < 1 || port > 65535) {
      console.error(`[WebServer] Invalid port number: ${port}, using default 19740`);
      this.settings.webServerPort = 19740;
      this.start(); // Retry with default port
      return;
    }

    try {
      this.server = this.app.listen(port, listenAddress, () => {
        console.info(`[WebServer] Started on ${listenAddress}:${port} (advertised as ${this.bindAddress}:${port})`);
      });

      // Add error handler for server startup failures
      this.server.on("error", (error: NodeJS.ErrnoException) => {
        console.error(`[WebServer] Failed to start on port ${port}:`, error.message);

        if (error.code === "EADDRINUSE") {
          console.warn(`[WebServer] Port ${port} is already in use, trying port ${port + 1}`);
          this.settings.webServerPort = port + 1;
          this.start(); // Retry with next port
        } else if (error.code === "EACCES") {
          console.warn(`[WebServer] Permission denied on port ${port}, trying port 19740`);
          this.settings.webServerPort = 19740;
          this.start(); // Retry with default port
        } else {
          console.error(`[WebServer] Server error: ${error.message}`);
        }
      });

      // Add crash recovery - restart server if it crashes
      this.server.on("close", () => {
        console.warn("[WebServer] Server closed, checking if restart needed...");
        this.server = undefined;

        // Only auto-restart if this wasn't a manual stop
        if (!this.isManualStop && !this.isRestarting) {
          console.warn("[WebServer] Server unexpectedly closed, attempting restart...");
          // Delay restart to avoid rapid restart loops
          setTimeout(() => {
            if (!this.server && !this.isRestarting) {
              this.start();
            }
          }, 2000);
        } else if (this.isManualStop) {
          console.info("[WebServer] Server manually stopped, no auto-restart.");
        }
      });
    } catch (error) {
      console.error(`[WebServer] Unexpected error starting server:`, error);
    }
  }

  public stop() {
    if (this.server) {
      this.isManualStop = true; // Mark as manual stop
      this.server.close(() => {
        console.info("[WebServer] Stopped.");
        this.isManualStop = false; // Reset flag after stop completes
      });
      this.server = undefined;
    }
  }

  public updateSettings(newSettings: Partial<WebServerSettings>) {
    const portOrPathChanged =
      (newSettings.webServerPort != null && newSettings.webServerPort !== this.settings.webServerPort) ||
      (newSettings.webServerPath != null && newSettings.webServerPath !== this.settings.webServerPath);

    // Revoke all leader tokens when the authorized client list changes
    if (newSettings.leaderModeClients !== undefined) {
      this.leaderTokens.clear();
    }

    // Update settings
    this.settings = {
      ...this.settings,
      ...newSettings,
    };

    this.verifyWebServerPath();
    this.initMainPages(this.staticDir);
    this.initImagePage(this.staticDir);

    // Restart server if port or path changed
    if (portOrPathChanged && this.server) {
      console.info(`[WebServer] Port or path changed, restarting...`, {
        port: this.settings.webServerPort,
        path: this.settings.webServerPath,
      });
      this.restart();
      return;
    }

    flushAllDisplayChangeListeners(); // Notify all clients to refresh display based on new settings
  }

  private async restart() {
    if (this.isRestarting) {
      console.warn("[WebServer] Restart already in progress, skipping...");
      return;
    }

    this.isRestarting = true;
    try {
      await this.stopAsync();
      // Small delay to ensure port is fully released
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.start();
    } catch (error) {
      console.error("[WebServer] Error during restart:", error);
    } finally {
      this.isRestarting = false;
    }
  }

  private stopAsync(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            console.error("[WebServer] Error stopping server:", err);
          } else {
            console.info("[WebServer] Stopped.");
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public getSettings(): WebServerSettings {
    return { ...this.settings };
  }

  public getAddress(): string {
    return this.bindAddress;
  }

  public getPort(): number {
    return this.settings.webServerPort;
  }

  public getRemoteHighlightController(): string {
    return this.remoteHighlightController;
  }

  public respondHighlightControllerRequest(clientId: string, grant: boolean) {
    if (grant) {
      this.remoteHighlightController = clientId;
    }

    const pendingResponse = this.pendingHighlightRequests.get(clientId);
    if (pendingResponse) {
      pendingResponse.json(grant ? "GRANTED" : "DENIED");
      this.pendingHighlightRequests.delete(clientId);
    }
  }

  public clearHighlightController() {
    this.remoteHighlightController = "";
  }

  /**
   * Set the current net display image data (matching C# SetImage).
   * Called from IPC when the frontend renders a new display frame.
   * @param imageDataUrl - data URL (data:image/jpeg;base64,..., data:image/png;base64,...) or raw base64 string
   */
  public setImage(imageDataUrl: string | null, options?: { mimeType?: "image/jpeg" | "image/png"; bgColor?: string; transient?: number }): void {
    if (options?.mimeType) this.currentImageMimeType = options.mimeType;
    if (typeof options?.bgColor === "string" && options.bgColor.trim() !== "") this.currentImageBgColor = options.bgColor;
    if (typeof options?.transient === "number" && Number.isFinite(options.transient)) {
      this.currentImageTransient = Math.max(0, Math.min(500, Math.round(options.transient)));
    }

    if (!imageDataUrl) {
      this.currentImageData = null;
      this.currentImageId = "";
      // Notify pending requests that image cleared
      this.notifyPendingImageRequests();
      return;
    }

    // Convert data URL (any image format) or raw base64 to buffer
    const base64Match = imageDataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    const base64Data = base64Match ? base64Match[1] : imageDataUrl;
    this.currentImageData = Buffer.from(base64Data, "base64");

    // Compute SHA1 hash for image ID (matching C# SHA1CryptoServiceProvider)
    this.currentImageId = crypto.createHash("sha1").update(this.currentImageData).digest("hex").toUpperCase();

    // Notify pending long-poll image requests
    this.notifyPendingImageRequests();
  }

  private notifyPendingImageRequests(): void {
    for (const pending of this.pendingImageRequests) {
      clearTimeout(pending.timeout);
      try {
        pending.res.json(this.getNetDisplayResponse());
      } catch {
        // Client may have disconnected
      }
    }
    this.pendingImageRequests = [];
  }

  private getNetDisplayResponse(): NetDisplayData {
    return {
      id: this.currentImageId,
      bgColor: this.currentImageBgColor,
      transient: this.currentImageTransient,
    };
  }

  private removePendingImageRequest(res: express.Response): void {
    this.pendingImageRequests = this.pendingImageRequests.filter((p) => p.res !== res);
  }

  /**
   * Get playlist ID for change detection
   */
  public getPlaylistId(): string {
    return this.playlistId;
  }

  /**
   * Track connected client
   */
  public trackClient(clientId: string, deviceName?: string): void {
    if (deviceName) {
      const forever = new Date("9999-12-31").getTime();
      this.connectedClients.set(clientId, { id: clientId, deviceName, validTo: forever });
    } else {
      const existing = this.connectedClients.get(clientId);
      if (existing) existing.validTo = Date.now() + 3000; // Extend validity a bit
    }
  }

  /**
   * Get list of connected clients for admin selection
   * Returns combined list of current clients and admin clients
   */
  public getConnectedClients(): Array<{ id: string; deviceName: string; isLeaderModeClient: boolean }> {
    const now = Date.now();
    const result: Array<{ id: string; deviceName: string; isLeaderModeClient: boolean }> = [];

    // Add currently connected clients that are not already leader-mode clients
    for (const [clientId, client] of this.connectedClients) {
      if (client.validTo > now) {
        const fullId = `${client.deviceName}@${clientId}`;
        // Check if not already in leader-mode list
        const isAlreadyLeaderModeClient = this.settings.leaderModeClients.some((entry) => {
          const parts = entry.split("@");
          return parts[parts.length - 1] === clientId;
        });
        if (!isAlreadyLeaderModeClient) {
          result.push({ id: fullId, deviceName: client.deviceName, isLeaderModeClient: false });
        }
      }
    }

    return result;
  }
}

let webServerInstance: WebServer | null = null;

export function initializeWebServer(initialSettings?: Partial<WebServerSettings>): WebServer {
  if (!webServerInstance) {
    webServerInstance = new WebServer(initialSettings);
    webServerInstance.start();
  }
  return webServerInstance;
}

export function getWebServerInstance(): WebServer | null {
  return webServerInstance;
}
