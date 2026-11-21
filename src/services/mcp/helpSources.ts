import enTooltips from "../../localization/tooltips.en.json";
import huTooltips from "../../localization/tooltips.hu.json";
import { getTutorialDefinition } from "../../tutorial/tutorialDefinitions";
import type { HelpSources } from "./help";

export const appHelpSources: HelpSources = {
  tutorials: [getTutorialDefinition("full"), getTutorialDefinition("client")],
  tooltips: { en: enTooltips, hu: huTooltips },
};
