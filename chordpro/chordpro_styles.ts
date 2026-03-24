export function defaultDisplayProperties(darkMode?: boolean) {
  // Read the current UI font size set by ResponsiveFontSizeManager (default is 16px)
  const rootPx = typeof document !== "undefined" ? parseFloat(document.documentElement.style.fontSize || "16") || 16 : 16;
  const scale = rootPx / 16;
  const px = (base: number) => `${Math.round(base * scale)}px`;
  const lineH = (base: number) => Math.round(base * scale);

  const def = {
    horizontalMargin: 5,
    verticalMargin: 5,
    tagFont: `bold ${px(14)} arial`,
    tagColor: "black",
    chordFont: `${px(14)} arial`,
    chordLineHeight: lineH(16),
    chordTextColor: "red",
    unknownChordTextColor: "orange",
    chordBorder: 2,
    lyricsFont: `${px(14)} sherif`,
    lyricsLineHeight: lineH(16),
    lyricsTextColor: "#808080",
    chordLyricSep: lineH(7),
    sectionBreakColor: "blue",
    highlightColor: "#e5e781",
    chordBoxColor: "black",
    cursorColor: "black",
    backgroundColor: "white",
    lineColor: "black",
    selectedTextBg: "blue",
    selectedTextFg: "#fefeff",
    commentBg: "grey",
    commentFg: "black",
    commentBorder: "black 1px solid",
    guitarChordSize: {
      width: 50,
      height: 60,
    },
    pianoChordSize: {
      width: 60,
      height: 40,
    },
    markUnderscoreColor: "red",
  };

  if (darkMode) {
    for (const key of Object.keys(def) as (keyof typeof def)[]) {
      if (def[key] === "black") (def as Record<string, unknown>)[key] = "white";
      else if (def[key] === "white") (def as Record<string, unknown>)[key] = "black";
    }
    def.highlightColor = "#a5a741";
  }

  return def;
}

export function defaultStyles(lyricsFont: string, darkMode?: boolean) {
  const style = {
    title: {
      font: "bold 32px times",
      fg: "blue",
      bg: "white",
      height: 34,
      align: "center",
    },
    key: {
      prefix: "Hangnem: ",
      font: "12px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    capo: {
      prefix: "Capo: ",
      font: "14px sherif",
      fg: "#404040",
      bg: "white",
      height: 18,
    },
    tempo: {
      prefix: "Tempo: ",
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    composer: {
      prefix: "Szerző: ",
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    subtitle: {
      prefix: "Alcím/Eredeti cím: ",
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    copyright: {
      prefix: "Copyright: ",
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    start_of_grid: {
      font: "bold " + lyricsFont,
      fg: "black",
      bg: "white",
      indent: 5,
    },
    start_of_chorus: {
      font: "bold " + lyricsFont,
      fg: "black",
      bg: "white",
      indent: 15,
    },
    start_of_verse: {
      font: lyricsFont,
      fg: "black",
      bg: "white",
    },
    start_of_bridge: {
      font: "bold italic " + lyricsFont,
      fg: "black",
      bg: "white",
      indent: 10,
    },
  };

  if (darkMode) {
    const invert = (obj: { bg: string; fg: string }) => {
      for (const key of ["bg", "fg"] as const)
        if (obj[key] === "black") obj[key] = "white";
        else if (obj[key] === "white") obj[key] = "black";
    };
    for (const key of Object.keys(style) as (keyof typeof style)[]) invert(style[key]);
  }

  return style;
}
