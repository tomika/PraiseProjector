export type ThirdPartyEntry = {
  name: string;
  url: string;
  licence: string;
  licenceUrl: string;
};

export type LicenseSection = {
  id: "client-webapp-libraries" | "client-webapp-tools";
  titleKey: "AboutSectionClientWebAppLibraries" | "AboutSectionClientWebAppTools";
  title: string;
  entries: ThirdPartyEntry[];
};

const clientWebAppLibraries: ThirdPartyEntry[] = [
  {
    name: "color-calendar",
    url: "https://github.com/niccokunzmann/color-calendar",
    licence: "MIT License",
    licenceUrl: "https://github.com/niccokunzmann/color-calendar/blob/main/LICENSE",
  },
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
  {
    name: "core-js",
    url: "https://github.com/zloirock/core-js",
    licence: "MIT License",
    licenceUrl: "https://github.com/zloirock/core-js/blob/master/LICENSE",
  },
];

const clientWebAppTools: ThirdPartyEntry[] = [
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

export function getClientWebAppLicenseSections(): LicenseSection[] {
  return [
    {
      id: "client-webapp-libraries",
      titleKey: "AboutSectionClientWebAppLibraries",
      title: "Shared app libraries",
      entries: clientWebAppLibraries,
    },
    {
      id: "client-webapp-tools",
      titleKey: "AboutSectionClientWebAppTools",
      title: "Shared app build/dev tools",
      entries: clientWebAppTools,
    },
  ];
}
