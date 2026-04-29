const CSS_URLS = [
  { href: "./stylesheets/chordpro.css", dataAttr: "data-chordpro-css" },
  { href: "./stylesheets/chordselector.css", dataAttr: "data-chordselector-css" },
];

function ensureStyles(): void {
  const head = document.head || document.getElementsByTagName("head")[0];
  CSS_URLS.forEach(({ href, dataAttr }) => {
    if (!document.querySelector(`link[${dataAttr}]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute(dataAttr, "true");
      head.appendChild(link);
    }
  });
}

export function ensureChordProAssets(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  ensureStyles();

  return Promise.resolve();
}
