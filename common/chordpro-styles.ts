/**
 * ChordPro styling contract — shared across the Electron main process, the renderer,
 * the browser client and the backend.
 *
 * Only the wire/settings shape lives here. The factories that build concrete styles
 * (`defaultDisplayProperties`, `defaultStyles`, `createDefaultChordProStylesSettings`,
 * `normalizeChordProStyles`) need a localizer, font names and dark-mode context, so they
 * stay in `chordpro/chordpro_styles.ts` and re-export these types for their own callers.
 *
 * Keeping the types here is what allows `common/` to stay dependency-free: `cloudApi.ts`
 * and `electron/webserver.ts` need the shape, not the behavior.
 */

export type ChordProDisplayProperties = {
  horizontalMargin: number;
  verticalMargin: number;
  tagFont: string;
  tagColor: string;
  chordFont: string;
  chordLineHeight: number;
  chordTextColor: string;
  unknownChordTextColor: string;
  chordBorder: number;
  lyricsFont: string;
  lyricsLineHeight: number;
  lyricsTextColor: string;
  chordLyricSep: number;
  sectionBreakColor: string;
  highlightColor: string;
  chordBoxColor: string;
  cursorColor: string;
  backgroundColor: string;
  lineColor: string;
  selectedTextBg: string;
  selectedTextFg: string;
  commentBg: string;
  commentFg: string;
  commentBorder: string;
  guitarChordSize: {
    width: number;
    height: number;
  };
  pianoChordSize: {
    width: number;
    height: number;
  };
  markUnderscoreColor: string;
};

export type ChordProDirectiveStyle = {
  prefix?: string;
  font?: string;
  fg?: string;
  bg?: string;
  height?: number;
  align?: string;
  indent?: number;
  hidden?: boolean;
};

export type ChordProDirectiveStyles = Record<string, ChordProDirectiveStyle>;

export type ChordProThemeStyles = {
  display: ChordProDisplayProperties;
  directives: ChordProDirectiveStyles;
};

export type ChordProStylesSettings = {
  light: ChordProThemeStyles;
  dark: ChordProThemeStyles;
};
