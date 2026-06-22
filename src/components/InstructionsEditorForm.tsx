import React, { useEffect, useState } from "react";
import { Song } from "../../db-common/Song";
import type { ChordSystemCode } from "../../chordpro/chordpro_base";
import { useTooltips } from "../localization/TooltipContext";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import InstructionsEditor from "../shared/InstructionsEditor";

interface InstructionsEditorFormProps {
  song: Song;
  initialInstructions: string;
  isInProfile: boolean;
  onSave: (instructions: string, storeInProfile: boolean) => void;
  onClose: () => void;
}

/** Track the desktop app's dark mode (driven by the documentElement data-theme). */
function useDataThemeDark(): boolean {
  const [isDark, setIsDark] = useState(() => typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark");
  useEffect(() => {
    const apply = () => setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

/**
 * Desktop GUI instructions editor. Thin wrapper over the shared
 * <InstructionsEditor>: maps the Song entity to song data, derives dark mode
 * from the app theme, and supplies localized text labels + the desktop features
 * (panel-collapse captions and the "store in profile" checkbox).
 */
const InstructionsEditorForm: React.FC<InstructionsEditorFormProps> = ({ song, initialInstructions, isInProfile, onSave, onClose }) => {
  const { tt } = useTooltips();
  const { t } = useLocalization();
  const isDark = useDataThemeDark();

  return (
    <InstructionsEditor
      variant="desktop"
      songData={{ text: song.Text, system: (song.System || "G") as ChordSystemCode }}
      initialInstructions={initialInstructions}
      isDark={isDark}
      localeHandler={(s) => t(s.replace(/ /g, "") as StringKey)}
      title={t("InstructionsEditorTitle")}
      closeLabel={t("Close")}
      collapse={{
        showText: true,
        left: {
          short: t("InstructionsEditorLeftPanelShort"),
          showLabel: t("InstructionsEditorShowLeftPanel"),
          hideLabel: t("InstructionsEditorCollapseLeftPanel"),
        },
        middle: {
          short: t("InstructionsEditorMiddlePanelShort"),
          showLabel: t("InstructionsEditorShowMiddlePanel"),
          hideLabel: t("InstructionsEditorCollapseMiddlePanel"),
        },
        right: {
          short: t("InstructionsEditorRightPanelShort"),
          showLabel: t("InstructionsEditorShowRightPanel"),
          hideLabel: t("InstructionsEditorCollapseRightPanel"),
        },
      }}
      storeInProfile={{ label: t("InstructionsEditorStoreInProfile"), isInProfile, defaultChecked: true }}
      action={{
        style: "text",
        clearLabel: t("InstructionsEditorClear"),
        resetLabel: t("InstructionsEditorReset"),
        saveLabel: t("Save"),
        saveTitle: tt("instructions_save"),
      }}
      onSave={onSave}
      onClose={onClose}
    />
  );
};

export default InstructionsEditorForm;
