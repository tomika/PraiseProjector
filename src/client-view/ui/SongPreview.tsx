/**
 * SongPreview — the read-only song preview modal (legacy click-to-preview). When
 * a catalogue/search row is clicked the controller sets `previewSongId`; this
 * renders the song into a chordProApi editor inside a dismissible modal, without
 * projecting it (that is the ▶ play button's job). Clicking the backdrop or the
 * Close button dismisses it.
 *
 * Like SongView it renders through the Database-free `chordProApi` bridge to stay
 * within the servable boundary.
 */

import { useEffect, useRef } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { chordProAPI } from "../../../chordpro/chordProApi";

type BoundEditor = ReturnType<typeof chordProAPI.bind>;

/** Scale the editor to fit the preview box WIDTH (full width), letting the body
 *  scroll vertically for long songs — mirrors SongView.fitAndZoom scroll mode.
 *  Fitting to width keeps the text large and readable instead of shrinking a long
 *  song to cram the whole page into view. */
function fitWidth(host: HTMLDivElement, api: BoundEditor): void {
  const container = host.parentElement;
  host.style.removeProperty("zoom");
  api.fitToPane(true);
  const ew = host.offsetWidth || 1;
  const cw = container?.clientWidth || ew;
  const z = cw / ew;
  host.style.setProperty("zoom", String(z));
}

export function SongPreview() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const songId = state.previewSongId;
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!songId) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const api = chordProAPI.bind(host);
    void store
      .getSongData(songId)
      .then((data) => {
        if (cancelled) return;
        api.load(data.text, false);
        // Show title / meta / tags read-only; chord boxes off (a quick look).
        api.setDisplayMode(true, true, true, false, false, 0, "");
        api.darkMode(state.isDark);
        fitWidth(host, api);
      })
      .catch(() => {
        /* a song that fails to load just shows an empty preview */
      });
    return () => {
      cancelled = true;
      api.dispose();
    };
  }, [songId, state.isDark, store]);

  if (!songId) return null;

  return (
    <div className="cv-modal-backdrop" onClick={() => store.closePreview()}>
      <div className="cv-preview" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="cv-preview-close" aria-label="Close" onClick={() => store.closePreview()}>
          ✕
        </button>
        <div className="cv-preview-body">
          <div className="editor" ref={hostRef} tabIndex={-1} />
        </div>
      </div>
    </div>
  );
}
