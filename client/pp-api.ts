import { AppConfig } from "../common/pp-types";
import {
  CHORDFORMAT_BB,
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_SUBSCRIPT,
  ChordProEditor,
} from "../chordpro/chordpro_editor";
import {
  createChordProEditor,
  getJoinedMetaDataDirectives,
  getAllKnownChordModifier as ppGetAllKnownChordModifier,
  getChordFindAndSplitPattern as ppGetChordFindAndSplitPattern,
  App,
} from "./praiseprojector";

import { getAboutBoxHtml as ppGetAboutBoxHtml } from "./about";
import { doubleClickHelper, makeVisible } from "../common/utils";
import { HostDevice } from "./host-device";

let editor: ChordProEditor | undefined;
const appNoteSystemCode = "G"; // TODO: this should not be fixed
export function load(chp: string, editable?: boolean, compareBase?: string) {
  editor = createChordProEditor(
    document.getElementById("editor") as HTMLDivElement,
    chp,
    appNoteSystemCode,
    editable,
    document.getElementById("chordsel") as HTMLDivElement,
    compareBase
  );
  if (editor) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webview = (window as any)?.chrome?.webview;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const external = window.external as any;
    editor.onChange = function (s) {
      if (webview) webview.postMessage("UpdateChordProData\n" + s);
      else external.UpdateChordProData(s);
    };
    editor.onLog = function (s) {
      if (webview) webview.postMessage("LogFromWebEditor\n" + s);
      else external.LogFromWebEditor(s);
    };
    editor.onLineSel = function (p) {
      if (webview) webview.postMessage("OnLineSel\n" + p);
      else external.OnLineSel(p);
    };
    editor.onLineDblclk = function (p) {
      if (webview) webview.postMessage("OnLineDblclk\n" + p);
      else external.OnLineDblclk(p);
    };
    editor.onCopy = function (p) {
      if (webview) webview.postMessage("OnCopy\n" + p);
      return external.OnCopy(p);
    };
    editor.onPaste = function () {
      if (webview) webview.postMessage("OnPaste\n");
      return external.OnPaste();
    };
  }
}
export function doPaste(s: string) {
  if (editor) editor.externalPaste(s);
}
export function getMetadataList() {
  return getJoinedMetaDataDirectives(":");
}
export function getAllKnownChordModifier() {
  return ppGetAllKnownChordModifier("\n");
}
export function getChordFindAndSplitPattern() {
  return ppGetChordFindAndSplitPattern(appNoteSystemCode);
}
export function getUnknownChords() {
  return editor ? editor.getUnknownChords().join("\n") : "";
}
export function getAboutBoxHtml() {
  return ppGetAboutBoxHtml();
}
export function highlight(f: number, t: number) {
  if (editor) editor.highlight(f, t);
}
export function update(chp: string) {
  if (editor) {
    editor.externalUpdate(chp);
    editor.highlight(0, 0);
  }
}
export function makeSelectionTitle() {
  if (editor) editor.makeSelectionTitle();
}
export function tagSelection(tagName: string, tagValue: string) {
  if (editor) editor.tagSelection(tagName, tagValue);
}
export function enableEdit(enable: boolean, multiChordChangeEnabled: boolean) {
  if (!editor) return;
  editor.setReadOnly(!enable, multiChordChangeEnabled);
  if (enable) editor.focus();
  editor.highlight(0, 0);
}
export function transpose(shift: number) {
  if (editor) editor.transpose(shift);
}

export function setDisplay(
  title: boolean,
  meta: boolean,
  superscript: boolean,
  bb: boolean,
  moll_mode: string,
  tag_mode: string,
  scale: number,
  no_chords: boolean
) {
  if (editor) {
    tag_mode = tag_mode || "full";
    tag_mode = tag_mode.toLowerCase().substr(0, 1);
    let chordFormatFlags = 0;
    switch (moll_mode) {
      case "am":
        chordFormatFlags = CHORDFORMAT_LCMOLL;
        break;
      case "a":
        chordFormatFlags = CHORDFORMAT_NOMMOL;
        break;
    }
    if (superscript) chordFormatFlags += CHORDFORMAT_SUBSCRIPT;
    if (bb) chordFormatFlags += CHORDFORMAT_BB;
    if (no_chords) chordFormatFlags += CHORDFORMAT_NOCHORDS;
    editor.scale = scale;
    editor.setDisplayMode(title, meta, tag_mode !== "n", tag_mode === "a", false, chordFormatFlags);
  }
}

export function editInstructions(song: string, instructions: string) {
  const div = document.getElementById("instructionsEditor") as HTMLElement | null;
  if (div) {
    makeVisible(div);
    load(song);
    if (editor) {
      makeVisible(editor.parentDiv, false);
      editor.setupInstructionsEditor(div, instructions);
    }
  }
}

export function getInstructions() {
  return editor?.getInstructions("SETTING") ?? "";
}

export function initServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => console.log("service worker register failed: " + err));
    });
  }
}

const apps: App[] = [];

export function onLoad(url: string, options?: AppConfig) {
  const app = new App(url, options);
  apps.push(app);
  app.onLoad();
}

export function handleDeviceMessage(message: string) {
  for (const app of apps) app.handleDeviceMessage(message);
}

export function initApp(url: string, options: AppConfig, greeting: string) {
  const app = new App(url, options);
  apps.push(app);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).forceOrientation = (o: string) => app.handleOrientationChange(o);

  app.onLoad();
  if (!HostDevice.hostDevice) {
    const ls = localStorage || window.localStorage;
    if (ls) {
      const last = ls.getItem("pp-last-greet");
      const today = new Date().toDateString();
      if (!last || last !== today) ls.setItem("pp-last-greet", today);
      else greeting = "";
    } else
      setTimeout(function () {
        const exitWarn = "\uD83D\uDEAA?";
        window.onbeforeunload = function () {
          return exitWarn;
        };
        window.addEventListener("beforeunload", function (e) {
          e.returnValue = exitWarn;
        });
      }, 30000);
  } else greeting = "";
  app.start(greeting);
  return app;
}

export function imageApp(url: string) {
  if (!url.endsWith("/")) url += "/";
  const app = new App(url);
  apps.push(app);
  let startupImageId: string | undefined = "startup";
  let inited = false;
  const init = () => {
    if (!inited && document.body) {
      doubleClickHelper(document.body, () => {
        location.href = url;
      });
      inited = true;
    }
  };
  const requestImage = () => {
    app.requestImage(
      (id) => {
        document.body.style.backgroundImage = id && id !== "NULL" ? "url(" + url + "image?c=" + encodeURIComponent(id) + ")" : "";
        setTimeout(requestImage, 100);
        init();
      },
      (error) => {
        console.log("Cannot load image: " + error);
        setTimeout(requestImage, 10000);
        init();
      },
      startupImageId
    );
    startupImageId = undefined;
  };
  requestImage();
  return app;
}

export function genChordSheets(options?: { baseNoteSuffix?: string | undefined; modifierSuffix?: string | undefined }) {
  const app = new App();
  app.genChordSheets(document.documentElement, "PIANO", undefined, undefined, options);
  return app;
}

export function initChordSelector() {
  const app = new App();
  app.onLoad();
  app.loadSong("", "", "G");
  app.setupChordBoxMode();
  return app;
}
