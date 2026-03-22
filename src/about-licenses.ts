import { getClientWebAppLicenseSections, type ThirdPartyEntry, type LicenseSection as ClientLicenseSection } from "../client/about-licenses";
import { getElectronBackendLicenseSections } from "../electron/about-licenses";

export type LicenseSection = {
  id: "electron-frontend-webapp" | "electron-backend-runtime" | ClientLicenseSection["id"];
  titleKey: "AboutSectionElectronFrontend" | "AboutSectionElectronBackend" | ClientLicenseSection["titleKey"];
  title: string;
  entries: ThirdPartyEntry[];
};

export type AboutRuntimeMode = "frontend-only" | "full-electron";

const electronFrontendWebApp: ThirdPartyEntry[] = [
  {
    name: "React",
    url: "https://github.com/facebook/react",
    licence: "MIT License",
    licenceUrl: "https://github.com/facebook/react/blob/main/LICENSE",
  },
  {
    name: "React DOM",
    url: "https://github.com/facebook/react/tree/main/packages/react-dom",
    licence: "MIT License",
    licenceUrl: "https://github.com/facebook/react/blob/main/LICENSE",
  },
  {
    name: "Bootstrap",
    url: "https://github.com/twbs/bootstrap",
    licence: "MIT License",
    licenceUrl: "https://github.com/twbs/bootstrap/blob/main/LICENSE",
  },
  {
    name: "qrcode.react",
    url: "https://github.com/zpao/qrcode.react",
    licence: "ISC License",
    licenceUrl: "https://github.com/zpao/qrcode.react/blob/master/LICENSE",
  },
  {
    name: "react-dnd",
    url: "https://github.com/react-dnd/react-dnd",
    licence: "MIT License",
    licenceUrl: "https://github.com/react-dnd/react-dnd/blob/main/LICENSE",
  },
  {
    name: "react-resizable-panels",
    url: "https://github.com/bvaughn/react-resizable-panels",
    licence: "MIT License",
    licenceUrl: "https://github.com/bvaughn/react-resizable-panels/blob/main/LICENSE",
  },
  {
    name: "localforage",
    url: "https://github.com/localForage/localForage",
    licence: "Apache License 2.0",
    licenceUrl: "https://github.com/localForage/localForage/blob/master/LICENSE",
  },
  {
    name: "pdfjs-dist",
    url: "https://github.com/mozilla/pdf.js",
    licence: "Apache License 2.0",
    licenceUrl: "https://github.com/mozilla/pdf.js/blob/master/LICENSE",
  },
  {
    name: "mammoth",
    url: "https://github.com/mwilliamson/mammoth.js",
    licence: "BSD-2-Clause",
    licenceUrl: "https://github.com/mwilliamson/mammoth.js/blob/master/LICENSE",
  },
  {
    name: "Typesense-JS",
    url: "https://github.com/typesense/typesense-js",
    licence: "Apache-2.0 license",
    licenceUrl: "https://github.com/typesense/typesense-js?tab=Apache-2.0-1-ov-file#readme",
  },
  {
    name: "Font Awesome",
    url: "https://github.com/FortAwesome/Font-Awesome",
    licence: "SIL OFL 1.1 (fonts), MIT License (CSS)",
    licenceUrl: "https://github.com/FortAwesome/Font-Awesome/blob/4.x/README.md#license",
  },
  {
    name: "tiny-emitter",
    url: "https://github.com/scottcorgan/tiny-emitter",
    licence: "MIT License",
    licenceUrl: "https://github.com/scottcorgan/tiny-emitter/blob/master/LICENSE",
  },
  {
    name: "uuid",
    url: "https://github.com/uuidjs/uuid",
    licence: "MIT License",
    licenceUrl: "https://github.com/uuidjs/uuid/blob/main/LICENSE.md",
  },
  {
    name: "react-dnd-html5-backend",
    url: "https://github.com/react-dnd/react-dnd",
    licence: "MIT License",
    licenceUrl: "https://github.com/react-dnd/react-dnd/blob/main/LICENSE",
  },
];

export function getSettingsAboutLicenseSections(mode: AboutRuntimeMode): LicenseSection[] {
  const sections: LicenseSection[] = [
    ...getClientWebAppLicenseSections(),
    {
      id: "electron-frontend-webapp",
      titleKey: "AboutSectionElectronFrontend",
      title: "Electron frontend/web app (public/src)",
      entries: electronFrontendWebApp,
    },
  ];

  if (mode === "full-electron") {
    for (const section of getElectronBackendLicenseSections()) {
      sections.push(section);
    }
  }

  return sections;
}
