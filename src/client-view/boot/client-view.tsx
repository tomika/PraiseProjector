/**
 * Standalone entry point for the client view. Used by the dedicated HTML entry
 * the Electron webserver serves (wired in a later step) and by the future
 * standalone/cloud deployment. The same module mounts the view in every
 * REST-backed context; only the page that loads it differs.
 */

import "../ui/client-view.css";
import { disableDefaultZoom } from "../../utils/disableDefaultZoom";
import { mountClientView } from "./mountClientView";

disableDefaultZoom();

// Establish a stable base font size for the UI chrome and the ChordPro renderer,
// which reads document.documentElement.style.fontSize as its baseline (the legacy
// client sets this explicitly too).
document.documentElement.style.fontSize = "16px";

const rootEl = document.getElementById("root");
if (rootEl) {
  void mountClientView(rootEl).finally(() => {
    document.getElementById("pp-shell-loading")?.remove();
  });
}
