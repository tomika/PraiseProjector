import { getElectronBackendLicenseSections } from "../electron/about-licenses";
import type { LicenseSectionOf, ThirdPartyEntry } from "../common/licenses";

export type LicenseSection = LicenseSectionOf<
  "electron-frontend-webapp" | "electron-backend-runtime" | "client-webapp-libraries" | "client-webapp-tools",
  "AboutSectionElectronFrontend" | "AboutSectionElectronBackend" | "AboutSectionClientWebAppLibraries" | "AboutSectionClientWebAppTools"
>;

export type AboutRuntimeMode = "frontend-only" | "full-electron";

const sharedAppLibraries: ThirdPartyEntry[] = [
  {
    name: "yalps",
    url: "https://github.com/Ivordir/YALPS",
    licence: "MIT License",
    licenceUrl: "https://github.com/Ivordir/YALPS/blob/master/LICENSE",
  },
  {
    name: "midi.js",
    url: "https://github.com/mudcube/MIDI.js/",
    licence: "MIT License",
    licenceUrl: "https://github.com/mudcube/MIDI.js/blob/master/LICENSE.txt",
  },
  {
    url: "https://github.com/paulrosen/midi-js-soundfonts",
    name: "midi-js-soundfonts",
    licence: "MIT License",
    licenceUrl: "https://github.com/paulrosen/midi-js-soundfonts/blob/master/LICENSE",
  },
  {
    name: "abcjs",
    url: "https://github.com/paulrosen/abcjs",
    licence: "MIT-based custom license",
    licenceUrl: "https://github.com/paulrosen/abcjs/blob/main/LICENSE.md",
  },
  {
    name: "diff",
    url: "https://github.com/kpdecker/jsdiff",
    licence: "BSD License",
    licenceUrl: "https://github.com/kpdecker/jsdiff/blob/master/LICENSE",
  },
  {
    name: "io-ts",
    url: "https://github.com/gcanti/io-ts",
    licence: "MIT License",
    licenceUrl: "https://github.com/gcanti/io-ts/blob/master/LICENSE",
  },
  {
    name: "fp-ts",
    url: "https://github.com/gcanti/fp-ts",
    licence: "MIT License",
    licenceUrl: "https://github.com/gcanti/fp-ts/blob/master/LICENSE",
  },
];

const sharedAppTools: ThirdPartyEntry[] = [
  {
    name: "Visual Studio Code",
    url: "https://github.com/microsoft/vscode",
    licence: "MIT License",
    licenceUrl: "https://github.com/microsoft/vscode/blob/main/LICENSE.txt",
  },
  {
    name: "TypeScript",
    url: "https://github.com/microsoft/TypeScript",
    licence: "Apache License 2.0",
    licenceUrl: "https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt",
  },
  {
    name: "esbuild",
    url: "https://github.com/evanw/esbuild",
    licence: "MIT License",
    licenceUrl: "https://github.com/evanw/esbuild/blob/main/LICENSE.md",
  },
];

function getSharedAppLicenseSections(): LicenseSection[] {
  return [
    {
      id: "client-webapp-libraries",
      titleKey: "AboutSectionClientWebAppLibraries",
      title: "Shared app libraries",
      entries: sharedAppLibraries,
    },
    {
      id: "client-webapp-tools",
      titleKey: "AboutSectionClientWebAppTools",
      title: "Shared app build/dev tools",
      entries: sharedAppTools,
    },
  ];
}

const electronFrontendWebApp: ThirdPartyEntry[] = [
  {
    name: "xml2abc-js 122 (Willem G. Vree and contributors; PraiseProjector adaptation)",
    url: "https://wim.vree.org/js/xml2abc-js_index.html",
    licence: "GNU Lesser General Public License",
    licenceUrl: "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html",
  },
  {
    name: "@xmldom/xmldom",
    url: "https://github.com/xmldom/xmldom",
    licence: "MIT License",
    licenceUrl: "https://github.com/xmldom/xmldom/blob/master/LICENSE",
  },
  {
    name: "Twemoji flag graphics (Twitter, Inc. and contributors)",
    url: "https://github.com/twitter/twemoji/tree/v14.0.2",
    licence: "CC-BY 4.0",
    licenceUrl: "https://github.com/twitter/twemoji/blob/v14.0.2/LICENSE-GRAPHICS",
  },
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

function getAppFrontendLicenseSection(): LicenseSection {
  return {
    id: "electron-frontend-webapp",
    titleKey: "AboutSectionElectronFrontend",
    title: "PraiseProjector app frontend (public/src)",
    entries: electronFrontendWebApp,
  };
}

export function getClientViewAboutLicenseSections(): LicenseSection[] {
  return [...getSharedAppLicenseSections(), getAppFrontendLicenseSection()];
}

export function getSettingsAboutLicenseSections(mode: AboutRuntimeMode): LicenseSection[] {
  const sections: LicenseSection[] = getClientViewAboutLicenseSections();

  if (mode === "full-electron") {
    for (const section of getElectronBackendLicenseSections()) {
      sections.push(section);
    }
  }

  return sections;
}
