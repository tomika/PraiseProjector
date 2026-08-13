import type { LicenseSectionOf, ThirdPartyEntry } from "../common/licenses";

export type LicenseSection = LicenseSectionOf<"electron-backend-runtime", "AboutSectionElectronBackend">;

const electronBackendRuntime: ThirdPartyEntry[] = [
  {
    name: "Electron",
    url: "https://github.com/electron/electron",
    licence: "MIT License",
    licenceUrl: "https://github.com/electron/electron/blob/main/LICENSE",
  },
  {
    name: "electron-builder",
    url: "https://github.com/electron-userland/electron-builder",
    licence: "MIT License",
    licenceUrl: "https://github.com/electron-userland/electron-builder/blob/master/LICENSE",
  },
  {
    name: "electron-updater",
    url: "https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater",
    licence: "MIT License",
    licenceUrl: "https://github.com/electron-userland/electron-builder/blob/master/LICENSE",
  },
  {
    name: "Express",
    url: "https://github.com/expressjs/express",
    licence: "MIT License",
    licenceUrl: "https://github.com/expressjs/express/blob/master/LICENSE",
  },
  {
    name: "axios",
    url: "https://github.com/axios/axios",
    licence: "MIT License",
    licenceUrl: "https://github.com/axios/axios/blob/v1.x/LICENSE",
  },
  {
    name: "cors",
    url: "https://github.com/expressjs/cors",
    licence: "MIT License",
    licenceUrl: "https://github.com/expressjs/cors/blob/master/LICENSE",
  },
  {
    name: "@abandonware/bleno (optional BLE peripheral module)",
    url: "https://github.com/abandonware/bleno",
    licence: "MIT License",
    licenceUrl: "https://github.com/abandonware/bleno/blob/master/LICENSE",
  },
];

export function getElectronBackendLicenseSections(): LicenseSection[] {
  return [
    {
      id: "electron-backend-runtime",
      titleKey: "AboutSectionElectronBackend",
      title: "Electron backend/runtime",
      entries: electronBackendRuntime,
    },
  ];
}
