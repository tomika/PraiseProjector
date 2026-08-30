import type { WebServerNativeWireInterface } from "../../common/webserver-interface";

export type HostDeviceMessage = {
  op: string;
  param: unknown;
};

export interface ElectronHostDevice {
  debugLog?: (tag: string, message: string) => void | Promise<void>;
  showToast?: (toast: string) => void | Promise<void>;
  getErrors?: () => string | Promise<string>;
  sendUdpMessage?: (message: string, host: string, port: string) => string | Promise<string>;
  listenOnUdpPort?: (port: string) => number | Promise<number>;
  closeUdpPort?: (port: string) => void | Promise<void>;
  getHome?: () => string | Promise<string>;
  goHome?: () => void | Promise<void>;
  setFullScreen?: (fs?: boolean) => boolean | Promise<boolean>;
  isFullScreen?: () => boolean | Promise<boolean>;
  dialog?: (message: string, title: string, positiveLabel: string, negativeLabel: string) => void | Promise<void>;
  storePreference?: (key: string, value: string) => void | Promise<void>;
  retrievePreference?: (key: string) => string | Promise<string>;
  getName?: () => string | Promise<string>;
  getModel?: () => string | Promise<string>;
  exit?: () => void | Promise<void>;
  version?: () => string | Promise<string>;
  info?: (flags: number) => string | Promise<string>;
  /** JSON array of active IPv4 interfaces — `{ name, address, netmask }[]` — for the
   *  app's local-network consumers. Electron: os.networkInterfaces(); Android:
   *  NetworkInterface.getNetworkInterfaces(). */
  getNetworkInterfaces?: () => string | Promise<string>;
  enableNotification?: (
    sessionId: string,
    name: string,
    descriptionText: string,
    checkIntervalMinutes: number,
    acquire: boolean
  ) => boolean | Promise<boolean>;
  cancelNotification?: (notificationId: number) => boolean | Promise<boolean>;
  cancelAllNotifications?: () => boolean | Promise<boolean>;
  getCacheSize?: () => number | Promise<number>;
  clearCache?: (includeDiskFiles: boolean) => boolean | Promise<boolean>;
  startNavigationTimeout?: (navigationTimeoutMs: number, message: string) => void | Promise<void>;
  pageLoadedSuccessfully?: () => void | Promise<void>;
  keepScreenOn?: (enabled: boolean) => void | Promise<void>;
  share?: (url: string, title: string, text: string) => void | Promise<void>;
  openLinkExternal?: (url: string) => void | Promise<void>;
  getThirdPartyLicenseSections?: () => string | Promise<string>;
  checkNearbyPermissions?: (acquire: boolean) => boolean | Promise<boolean>;
  advertiseNearby?: (enabled: boolean) => boolean | Promise<boolean>;
  discoverNearby?: (enabled: boolean) => boolean | Promise<boolean>;
  connectNearby?: (endpointId: string) => boolean | Promise<boolean>;
  sendNearbyMessage?: (endpointId: string, message: string) => boolean | Promise<boolean>;
  closeNearby?: (endpointId: string) => boolean | Promise<boolean>;
  /** JSON `WebAppBundleStatus` — Android only, where the frontend is a native-managed
   *  bundle that updates independently of the store binary. Local read, no network. */
  getWebAppBundleStatus?: () => string | Promise<string>;
  /** Forced server check; the outcome arrives as a `pp-webapp-bundle-event`. */
  checkWebAppUpdateNow?: () => void | Promise<void>;
  /** JSON `WebAppUpdateActivity`; local-only snapshot used when the UI mounted after
   *  the activation check had already started. */
  getWebAppUpdateActivity?: () => string | Promise<string>;
  /** Trial-launches an already downloaded release immediately (reloads the WebView). */
  applyPendingWebAppUpdate?: () => void | Promise<void>;
}

/** Transient Android webapp update activity. */
export interface WebAppUpdateActivity {
  phase: "idle" | "checking" | "downloading";
  downloadedBytes: number;
  totalBytes: number;
}

/** Mirrors `WebAppBundleStatus` in `WebAppBundleManager.kt`. */
export interface WebAppBundleStatus {
  /** Release baked into the installed APK. */
  factoryReleaseId?: string;
  factoryVersion?: string;
  /** Downloaded release promoted after a successful trial launch. */
  activeReleaseId?: string;
  activeVersion?: string;
  /** Downloaded and verified, waiting for its trial launch. */
  pendingReleaseId?: string;
  pendingVersion?: string;
  runningReleaseId: string;
  runningVersion?: string;
  runningCommit?: string;
  runningIsFactory: boolean;
  runningIsTrial: boolean;
  /**
   * A different bundle than `runningReleaseId` is already selected for the next launch, so
   * `applyPendingWebAppUpdate()` can switch to it right away. Covers a downloaded
   * `pendingReleaseId`, but also a revert *back* to the factory bundle, where nothing is
   * pending. Optional: this bundle can run on an older APK whose bridge never sends it.
   */
  activationPending?: boolean;
  /** Release discarded after a failed launch; retried no earlier than the timestamp. */
  retryBlockedReleaseId?: string;
  /** Epoch ms, 0 when nothing is blocked. */
  retryAvailableAt: number;
}

export interface WebAppBundleEventDetail {
  phase: "checking" | "downloading" | "result" | "error";
  result?: "UPDATED" | "CURRENT" | "INCOMPATIBLE";
  message?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  /** JSON-encoded `WebAppBundleStatus`, as produced by the native bridge. */
  status?: string | null;
}

/**
 * Android-only bridge that the native host injects once per webapp bundle launch. Because
 * the binding is created with the document, a report through it tells the host *which*
 * bundle booted — `hostDevice.pageLoadedSuccessfully()` cannot, and a late report from an
 * outgoing page there can be credited to the bundle replacing it.
 */
export interface WebAppLaunchBridge {
  pageLoadedSuccessfully?: () => void;
}

declare global {
  interface Window {
    hostDevice?: ElectronHostDevice;
    ppWebAppLaunch?: WebAppLaunchBridge;
    webServerNativeWire?: WebServerNativeWireInterface;
  }
}
