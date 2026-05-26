import { LicenseSection } from "./about-licenses";

type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONObject | JSONArray;
type JSONObject = { [member: string]: JSONValue };

type JSONArray = JSONValue[];

export type HostDeviceInfo = {
  deviceName?: string;
  modelName?: string;
  versionName?: string;
  totalMemory?: number;
  freeMemory?: number;
  ipAddress?: string;
  gateway?: string;
  broadcast?: string;
};

export enum HostDeviceInfoType {
  Device = 0,
  Memory = 1,
  Network = 2,
}

export interface HostDeviceInterface {
  debugLog(tag: string, message: string): void;
  showToast(toast: string): void;
  getErrors(): string;
  sendUdpMessage(message: string, host: string, port: string): string;
  listenOnUdpPort(port: string): number;
  closeUdpPort(port: string): void;
  getHome(): string;
  goHome(): void;
  setFullScreen(fs?: boolean): boolean;
  isFullScreen(): boolean;
  dialog(message: string, title: string, positiveLabel: string, negativeLabel: string): void;
  storePreference(key: string, value: string): void;
  retrievePreference(key: string): string;
  getName?(): string;
  getModel?(): string;
  exit?(): void;
  version?(): string;
  info?(flags: HostDeviceInfoType): string;
  enableNotification?(sessionId: string, name: string, descriptionText: string, checkIntervalMinutes: number, acquire: boolean): boolean;
  cancelNotification?(notificationId: number): boolean;
  cancelAllNotifications?(): boolean;
  getCacheSize?(): number;
  clearCache?(includeDiskFiles: boolean): boolean;
  startNavigationTimeout?(navigationTimeoutMs: number, message: string): void;
  pageLoadedSuccessfully?(): void;
  keepScreenOn?(enabled: boolean): void;
  share?(url: string, title: string, text: string): void;
  openLinkExternal?(url: string): void;
  getThirdPartyLicenseSections?(): string;
}
export interface NearbyInterface {
  checkNearbyPermissions(acquire: boolean): boolean;
  advertiseNearby(enabled: boolean): boolean;
  discoverNearby(enabled: boolean): boolean;
  connectNearby(endpointId: string): boolean;
  sendNearbyMessage(endpointId: string, message: string): boolean;
  closeNearby(endpointId: string): boolean;
}

export type DeviceMessage = {
  op: string;
  param: JSONValue;
};

export type PpdPacket = {
  message: string;
  from: string;
  port?: number;
};

export class HostDevice {
  private readonly pending = new Map<string, { resolve: (param: boolean) => void }[]>();
  private addPending(op: string) {
    return new Promise<boolean>((resolve) => {
      let q = this.pending.get(op);
      if (q == null) this.pending.set(op, (q = []));
      q.push({ resolve });
    });
  }
  _setRetval(op: string, value: JSONValue) {
    const pending = this.pending.get(op);
    if (pending) {
      const handler = pending.shift();
      if (!handler) this.debugLog(HostDevice.debugLogTag, "Invalid return value type from host device for op(" + op + "):" + value);
      else if (typeof value !== "boolean") this.debugLog(HostDevice.debugLogTag, "Invalid return value from host device for op(" + op + "):" + value);
      else handler.resolve(value);
    }
  }
  private formatPorts(ports: number | number[]) {
    const s = new Set(typeof ports === "number" ? [ports] : ports);
    const a = Array.from(s).sort();
    let p: number | null = null;
    const rv: string[] = [];
    for (const c of a) {
      if (p === null) {
        rv.push(c.toString(10));
        p = c;
      } else if (p + 1 !== c) {
        rv[rv.length - 1] += "-" + p.toString(10);
        p = null;
      } else p = c;
    }
    if (p != null && rv[rv.length - 1] !== p.toString(10)) rv[rv.length - 1] += "-" + p.toString(10);
    return rv.join(",");
  }

  private static _hostDevice?: HostDevice | null;
  static get hostDevice() {
    if (this._hostDevice === undefined) {
      const hdi = (window as unknown as Record<string, unknown>)["hostDevice"] as HostDeviceInterface;
      this._hostDevice = hdi ? new HostDevice(hdi) : null;
    }
    return this._hostDevice;
  }

  static readonly debugLogTag = "PraiseProjectorDebugLog";

  readonly openLinkExternal?: (url: string) => void;
  readonly exit?: () => void;
  constructor(private readonly device: HostDeviceInterface) {
    if (this.device.exit)
      this.exit = () => {
        if (this.device.exit) this.device.exit();
      };
    if (this.device.openLinkExternal) {
      this.openLinkExternal = (url: string) => {
        if (this.device.openLinkExternal) this.device.openLinkExternal(url);
      };
    }
  }
  debugLog(tag: string, message: string) {
    this.device.debugLog(tag, message);
  }
  getErrors() {
    return this.device.getErrors();
  }
  showToast(toast: string) {
    this.device.showToast(toast);
  }
  sendUdpMessage(message: string, host: string, ports: number | number[]) {
    return this.device.sendUdpMessage(message, host, this.formatPorts(ports));
  }
  listenOnUdpPort(ports: number | number[]) {
    return this.device.listenOnUdpPort(this.formatPorts(ports));
  }
  closeUdpPort(ports?: number | number[]) {
    this.device.closeUdpPort(ports == null ? "" : this.formatPorts(ports));
  }
  getHome() {
    return this.device.getHome();
  }
  goHome() {
    Nearby.closeAll();
    this.device.goHome();
  }
  setFullScreen(fs?: boolean) {
    return this.device.setFullScreen(fs);
  }
  get fullScreen() {
    return this.device.isFullScreen();
  }
  getName() {
    return this.device.getName ? this.device.getName().trim() : (this.info(HostDeviceInfoType.Device)?.deviceName ?? "");
  }
  getModel() {
    return this.device.getModel ? this.device.getModel().trim() : (this.info(HostDeviceInfoType.Device)?.modelName ?? "");
  }
  async alert(message: string, title = "") {
    const pending = this.addPending("alert");
    this.device.dialog(message, title, "OK", "");
    await pending;
  }
  async confirm(question: string, title = "") {
    const pending = this.addPending("confirm");
    this.device.dialog(question, title, "👍", "👎");
    return await pending;
  }
  storePreference(key: string, value: string) {
    this.device.storePreference(key, value);
  }
  retrievePreference(key: string) {
    return this.device.retrievePreference(key);
  }
  get version() {
    return this.device.version ? this.device.version() : "";
  }

  info(flags = -1) {
    const infoStr = this.device.info ? this.device.info(flags) : "";
    try {
      return JSON.parse(infoStr) as HostDeviceInfo;
    } catch (error) {
      this.debugLog("Info", String(error));
    }
    return null;
  }
  enableNotification(sessionId: string, name: string, desc: string, checkIntervalMinutes: number, acquire = false) {
    return this.device.enableNotification?.(sessionId, name, desc, checkIntervalMinutes, acquire) ?? false;
  }
  cancelNotification(notificationId: number) {
    return this.device.cancelNotification?.(notificationId) ?? false;
  }
  cancelAllNotifications() {
    return this.device.cancelAllNotifications?.() ?? false;
  }
  async getCacheSize() {
    let size = this.device.getCacheSize?.() ?? -1;
    if ("storage" in navigator && "estimate" in navigator.storage)
      try {
        const estimate = await navigator.storage.estimate();
        if (estimate.usage != null) size = Math.max(estimate.usage, size);
      } catch (error) {
        console.error("Error getting cache storage size", error);
      }
    return size >= 0 ? size : undefined;
  }
  clearCache(includeDiskFiles: boolean) {
    return this.device.clearCache?.(includeDiskFiles);
  }
  startNavigationTimeout(navigationTimeoutMs: number, message: string) {
    this.device.startNavigationTimeout?.(navigationTimeoutMs, message);
  }
  pageLoadedSuccessfully() {
    this.device.pageLoadedSuccessfully?.();
  }
  keepScreenOn(enabled: boolean) {
    this.device.keepScreenOn?.(enabled);
  }
  share(url: string, title?: string, text?: string) {
    if (!this.device.share) return false;
    this.device.share(url, title ?? "", text ?? "");
    return true;
  }
  getThirdPartyLicenseSections(): LicenseSection[] {
    const licenses = this.device.getThirdPartyLicenseSections?.() ?? "";
    if (licenses) {
      try {
        return JSON.parse(licenses) as LicenseSection[];
      } catch (error) {
        this.debugLog("ThirdPartyLicenses", String(error));
      }
    }
    return [];
  }
}

export type NearbyMessageParam = {
  id?: string;
  event?: string;
  msg?: string;
  granted?: boolean;
};

export class Nearby {
  private static _instance?: Nearby | null;
  static get instance() {
    if (this._instance === undefined) {
      const nbi = (window as unknown as Record<string, unknown>)["hostDevice"] as NearbyInterface;
      this._instance = nbi?.checkNearbyPermissions != null ? new Nearby(nbi) : null;
    }
    return this._instance;
  }

  static processMessage(param: NearbyMessageParam) {
    if (this._instance) {
      if (param.granted != null) this._instance._permissionWaiters.pop()?.(param.granted);
      else if (param.id != null) {
        switch (param.event) {
          case null:
          case undefined:
            break;
          case "discovered":
            this._instance._discovered.add(param.id);
            break;
          case "disappeared":
            this._instance._discovered.delete(param.id);
            break;
          case "connected":
            this._instance._connected.add(param.id);
            break;
          case "connection failed":
          case "disconnected":
            this._instance._connected.delete(param.id);
            break;
          default:
            HostDevice.hostDevice?.debugLog(HostDevice.debugLogTag, "Unknown nearby param: " + param.event);
            return;
        }
        if (param.event) {
          for (const cb of this._instance.reg.values()) cb.deviceEventCallback?.(param.event, param.id);
        } else if (param.msg) {
          for (const cb of this._instance.reg.values()) cb.incomingMessageCallback?.(param.msg, param.id);
        }
      }
    }
  }

  static closeAll() {
    Nearby._instance?.advertise(false);
    Nearby._instance?.discover(false);
    Nearby._instance?.close();
  }

  private readonly reg = new Map<
    string,
    {
      deviceEventCallback?: (event: string, entrypointId: string) => void;
      incomingMessageCallback?: (message: string, entrypointId: string) => void;
    }
  >();
  private readonly _discovered = new Set<string>();
  private readonly _connected = new Set<string>();
  private readonly _permissionWaiters: ((result: boolean) => void)[] = [];
  private constructor(private readonly nbi: NearbyInterface) {}

  get available() {
    return Array.from(this._discovered.keys());
  }

  get connected() {
    return Array.from(this._connected.keys());
  }

  register(
    id: string,
    deviceEventCallback?: (event: string, entrypointId: string) => void,
    incomingMessageCallback?: (message: string, entrypointId: string) => void
  ) {
    if (deviceEventCallback || incomingMessageCallback) this.reg.set(id, { deviceEventCallback, incomingMessageCallback });
    else this.reg.delete(id);
  }

  unregister(id: string) {
    this.reg.delete(id);
  }

  async checkPermissions(acquire?: boolean) {
    if (this.nbi.checkNearbyPermissions(!!acquire)) return true;
    if (!acquire) return false;
    return new Promise<boolean>((resolve) => {
      this._permissionWaiters.push(resolve);
    });
  }

  advertise(enabled: boolean) {
    return this.nbi.advertiseNearby(enabled);
  }

  discover(enabled: boolean) {
    return this.nbi.discoverNearby(enabled);
  }

  connect(endpointId: string) {
    return this.nbi.connectNearby(endpointId);
  }

  sendMessage(endpointId: string, message: string) {
    return this.nbi.sendNearbyMessage(endpointId, message);
  }

  close(endpointId?: string) {
    return this.nbi.closeNearby(endpointId ?? "");
  }
}

/*
class HostDeviceEmulator implements HostDeviceInterface {
  debugLog(tag: string, message: string) {
    console.log(`${tag}:${message}`);
  }
  showToast(toast: string) {
    this.debugLog("TOAST", toast);
  }
  getErrors() {
    return "";
  }
  sendUdpMessage(message: string, host: string, port: string) {
    this.debugLog(`UDP:${host}:${port}`, message);
    return host;
  }
  listenOnUdpPort(port: string) {
    return 1974;
  }
  closeUdpPort(port: string) {
    this.debugLog("CLOSE", port);
  }
  getHome() {
    return "http://localhost:9000/app/main.html";
  }
  goHome() {
    location.href = this.getHome();
  }
  setFullScreen(fs?: boolean) {
    this.debugLog("FS", fs == null ? "null" : fs ? "true" : "false");
    return this.isFullScreen();
  }
  isFullScreen() {
    return false;
  }
  getName() {
    return "It's me Mario";
  }
  getModel() {
    return "Emulated model";
  }
  dialog(message: string, title: string, positiveLabel: string, negativeLabel: string) {
    const text = title + "\n" + message;
    if (negativeLabel) confirm(text);
    else alert(message);
  }
  storePreference(key: string, value: string) {}
  retrievePreference(key: string): string {
    return "";
  }
}

if (window["hostDevice"] == null && location.href.startsWith("http://localhost:9000")) {
  window["hostDevice"] = new HostDeviceEmulator();
}
*/
