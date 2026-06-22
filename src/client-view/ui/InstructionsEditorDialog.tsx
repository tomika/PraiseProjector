/**
 * InstructionsEditorDialog — client-view host for the shared <InstructionsEditor>.
 *
 * It keeps the client-view-specific concerns (loading the song from the store,
 * loading/error states, saving through the controller) and renders the shared
 * editor with the client-view skin: the desktop layout reskinned with the
 * client-view colours and icon buttons in place of text labels.
 */

import { useEffect, useState } from "react";
import type { SongData } from "../../../common/pp-types";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { InstructionsEditor } from "../../shared/InstructionsEditor";
import { icon } from "./assets";

export function InstructionsEditorDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const [songData, setSongData] = useState<SongData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    // Match legacy editInstructions(): prefer the already-projected song that
    // the viewer is rendering, and only fall back to a song lookup when needed.
    const projectedSongText = state.display.song?.trim();
    if (projectedSongText) {
      setSongData({ text: state.display.song, system: state.display.system });
      setLoading(false);
      setError(null);
      return () => {
        active = false;
      };
    }

    const songId = state.display.songId;
    if (!songId) {
      setLoading(false);
      setError("No song selected.");
      return;
    }
    setLoading(true);
    setError(null);
    setSongData(null);
    void store
      .getSongData(songId)
      .then((data) => {
        if (active) setSongData(data);
      })
      .catch(() => {
        if (active) setError("Could not load song data for the instructions editor.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state.display.song, state.display.system, state.display.songId, store]);

  return (
    <InstructionsEditor
      variant="cv"
      songData={songData}
      initialInstructions={state.instructionsEditorText}
      loading={loading}
      error={error}
      loadingText="Loading instructions editor…"
      isDark={state.isDark}
      title="Instructions"
      closeLabel="Close"
      collapse={{
        showText: false,
        left: { short: "Source", showLabel: "Show source panel", hideLabel: "Hide source panel" },
        middle: { short: "Editor", showLabel: "Show editor panel", hideLabel: "Hide editor panel" },
        right: { short: "Preview", showLabel: "Show preview panel", hideLabel: "Hide preview panel" },
      }}
      action={{
        style: "icon",
        clearIcon: icon("reset.svg"),
        resetIcon: icon("revert.svg"),
        saveIcon: icon("ok.svg"),
        clearTitle: "Clear instructions",
        resetTitle: "Revert instructions",
        saveTitle: "Save instructions",
      }}
      onSave={(instructions) => store.saveInstructions(instructions)}
      onClose={() => store.closeInstructionsEditor()}
    />
  );
}
