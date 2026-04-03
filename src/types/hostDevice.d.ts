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
  keepScreenOn?: (enabled: boolean) => void | Promise<void>;
  openLinkExternal?: (url: string) => void | Promise<void>;
  getThirdPartyLicenseSections?: () => string | Promise<string>;
  checkNearbyPermissions?: (acquire: boolean) => boolean | Promise<boolean>;
  advertiseNearby?: (enabled: boolean) => boolean | Promise<boolean>;
  discoverNearby?: (enabled: boolean) => boolean | Promise<boolean>;
  connectNearby?: (endpointId: string) => boolean | Promise<boolean>;
  sendNearbyMessage?: (endpointId: string, message: string) => boolean | Promise<boolean>;
  closeNearby?: (endpointId: string) => boolean | Promise<boolean>;
  getNearbyState?: () => Promise<{ discovering: boolean; sessions: Array<{ id: string; name: string; transport: string }> }>;
  onDeviceMessage?: (callback: (message: HostDeviceMessage) => void) => () => void;
}

declare global {
  interface Window {
    hostDevice?: ElectronHostDevice;
  }
}
