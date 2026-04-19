interface ChordProAPI {
  load(editorDiv: HTMLDivElement, chordPro: string, editable?: boolean, compareBase?: string): void;
  getText?(): string;
  setDisplay(
    showTitle: boolean,
    showMeta: boolean,
    superscript: boolean,
    bb: boolean,
    mollMode: string,
    sectionLabels: string,
    zoom: number,
    hideChords: boolean
  ): void;
  transpose(shift: number): void;
  enableEdit(enable: boolean, multiChordChangeEnabled?: boolean): void;
  tagSelection(tag: string, value?: string): void;
  makeSelectionTitle(): void;
  highlight(from: number, to: number): void;
  getAllKnownChordModifier?(): string;
  getChordFindAndSplitPattern?(): string;
  getUnknownChords?(): string;
  updateDocument?(text: string): void;
  dispose?(): void;
  installLocaleHandler?(handler: (s: string) => string): void;
  installTooltipHandler?(handler: (key: string) => string | undefined): void;
  darkMode?(dark: boolean): void;
  refreshDisplayProps?(): void;
}

declare interface Window {
  chordProAPI?: ChordProAPI;
}
