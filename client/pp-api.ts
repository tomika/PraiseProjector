import { AppConfig } from "../common/pp-types";
import {
  CHORDFORMAT_BB,
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_SUBSCRIPT,
  ChordProEditor,
  ChordProEditorEventHandlers,
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

export function load(chp: string, editable?: boolean, compareBase?: string, eventHandlers?: ChordProEditorEventHandlers) {
  editor = createChordProEditor(
    document.getElementById("editor") as HTMLDivElement,
    chp,
    appNoteSystemCode,
    editable,
    document.getElementById("chordsel") as HTMLDivElement,
    compareBase,
    eventHandlers
  );
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

export function editInstructions(song: string, instructions: string, eventHandlers?: ChordProEditorEventHandlers) {
  const div = document.getElementById("instructionsEditor") as HTMLElement | null;
  if (div) {
    makeVisible(div);
    load(song, undefined, undefined, eventHandlers);
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
  let imageLayers: [HTMLImageElement, HTMLImageElement] | undefined;
  let activeLayerIndex = 0;
  let currentImageId: string | undefined;
  let loadingImageId: string | undefined;
  let loadSequence = 0;
  let clearTimer: number | undefined;
  let transitionMs = 200;
  let transitionType = "linear";

  const applyNetDisplaySettings = (bgColor?: string) => {
    if (!document.body) return;
    document.body.style.backgroundColor = bgColor && bgColor.trim() ? bgColor : "black";
  };

  const ensureLayers = () => {
    if (imageLayers || !document.body) return;

    const createLayer = (zIndex: number, opacity: string) => {
      const img = document.createElement("img");
      img.style.position = "fixed";
      img.style.left = "0";
      img.style.top = "0";
      img.style.width = "100vw";
      img.style.height = "100vh";
      img.style.objectFit = "contain";
      img.style.objectPosition = "center center";
      img.style.pointerEvents = "none";
      img.style.userSelect = "none";
      img.style.zIndex = zIndex.toString();
      img.style.opacity = opacity;
      img.style.transition = "opacity 200ms linear";
      return img;
    };

    const front = createLayer(1, "1");
    const back = createLayer(0, "0");
    document.body.appendChild(front);
    document.body.appendChild(back);
    imageLayers = [front, back];
  };

  const clampTransitionMs = (value: unknown) => {
    if (typeof value === "boolean") return value ? 500 : 0;
    if (typeof value !== "number" || !Number.isFinite(value)) return 200;
    return Math.max(0, Math.min(500, Math.round(value)));
  };

  const setLayerTransition = (ms: number, type: string = "linear") => {
    if (!imageLayers) return;
    const transition = ms <= 0 ? "none" : `opacity ${ms}ms ${type}`;
    imageLayers[0].style.transition = transition;
    imageLayers[1].style.transition = transition;
  };

  const cancelClear = () => {
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  };

  const clearImagesNow = () => {
    if (!imageLayers) return;
    ++loadSequence;
    currentImageId = undefined;
    loadingImageId = undefined;
    imageLayers[0].removeAttribute("src");
    imageLayers[1].removeAttribute("src");
    imageLayers[0].style.opacity = "0";
    imageLayers[1].style.opacity = "0";
  };

  const clearWithTransition = (ms: number) => {
    if (!imageLayers) return;
    if (clearTimer !== undefined) return;
    setLayerTransition(ms, transitionType);
    const active = imageLayers[activeLayerIndex];
    const inactive = imageLayers[1 - activeLayerIndex];
    active.style.opacity = "0";
    inactive.style.opacity = "0";
    if (ms <= 0) {
      clearImagesNow();
      return;
    }
    clearTimer = window.setTimeout(() => {
      clearTimer = undefined;
      clearImagesNow();
    }, ms);
  };

  const loadIntoBackLayerAndSwap = (imageId: string) => {
    if (imageId === currentImageId || imageId === loadingImageId) return;
    ensureLayers();
    if (!imageLayers) return;

    const backLayerIndex = 1 - activeLayerIndex;
    const backLayer = imageLayers[backLayerIndex];
    const frontLayer = imageLayers[activeLayerIndex];

    const nextUrl = url + "image?c=" + encodeURIComponent(imageId);
    const sequence = ++loadSequence;
    loadingImageId = imageId;
    cancelClear();
    setLayerTransition(transitionMs, transitionType);
    backLayer.style.opacity = "0";
    backLayer.style.zIndex = "2";

    backLayer.onload = () => {
      if (sequence !== loadSequence || loadingImageId !== imageId) return;

      if (transitionMs <= 0) {
        backLayer.style.transition = "none";
        frontLayer.style.transition = "none";
        backLayer.style.opacity = "1";
        frontLayer.style.opacity = "0";
        backLayer.style.zIndex = "1";
        frontLayer.style.zIndex = "0";
      } else {
        requestAnimationFrame(() => {
          backLayer.style.opacity = "1";
          frontLayer.style.opacity = "0";
        });
        window.setTimeout(() => {
          if (sequence !== loadSequence || loadingImageId !== undefined) return;
          backLayer.style.zIndex = "1";
          frontLayer.style.zIndex = "0";
        }, transitionMs);
      }

      activeLayerIndex = backLayerIndex;
      currentImageId = imageId;
      loadingImageId = undefined;
    };
    backLayer.onerror = () => {
      if (sequence !== loadSequence || loadingImageId !== imageId) return;
      loadingImageId = undefined;
      console.log("Cannot preload image: " + imageId);
    };
    backLayer.src = nextUrl;
  };

  const init = () => {
    if (!inited && document.body) {
      applyNetDisplaySettings();
      ensureLayers();
      doubleClickHelper(document.body, () => {
        location.href = url;
      });
      inited = true;
    }
  };
  const requestImage = () => {
    app
      .requestImage(startupImageId)
      .then((netDisplayData) => {
        applyNetDisplaySettings(netDisplayData.bgColor);
        transitionMs = clampTransitionMs(netDisplayData.transient);
        transitionType = (netDisplayData.transitionType as string) ?? "linear";
        if (netDisplayData.id) {
          loadIntoBackLayerAndSwap(netDisplayData.id);
        } else if (imageLayers) {
          clearWithTransition(transitionMs);
        }
        setTimeout(requestImage, 100);
        init();
      })
      .catch((error) => {
        console.log("Cannot load image: " + error);
        setTimeout(requestImage, 10000);
        init();
      });
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
