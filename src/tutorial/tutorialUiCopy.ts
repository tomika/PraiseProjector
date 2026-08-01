import type { Language } from "../localization/LocalizationContext";

export interface TutorialUiCopy {
  overview: string;
  detailsLayer: string;
  details: string;
  back: string;
  next: string;
  finish: string;
  exit: string;
  resumeTitle: string;
  resumeBody: string;
  resume: string;
  restart: string;
  resumeFromFocus: string;
  missingTarget: string;
  startBlocked: string;
}

const copy: Record<Language, TutorialUiCopy> = {
  hu: {
    overview: "Áttekintés",
    detailsLayer: "Részletek",
    details: "Részletek",
    back: "Vissza",
    next: "Tovább",
    finish: "Befejezés",
    exit: "Kilépés",
    resumeTitle: "Folytatod a bemutatót?",
    resumeBody: "A legutóbbi alkalommal nem értél a végére. Folytathatod onnan, ahol abbahagytad, vagy újrakezdheted az elejéről.",
    resume: "Folytatás",
    restart: "Újrakezdés",
    resumeFromFocus: "Folytatás innen: {item}",
    missingTarget: "Ez az elem a jelenlegi módban nem érhető el; a bemutató továbblép.",
    startBlocked: "A bemutató most nem indítható el. Előbb zárd be a nyitott párbeszédablakot, vagy fejezd be az aktuális műveletet.",
  },
  en: {
    overview: "Overview",
    detailsLayer: "Details",
    details: "Details",
    back: "Back",
    next: "Next",
    finish: "Finish",
    exit: "Exit",
    resumeTitle: "Continue the tutorial?",
    resumeBody: "You did not finish the tutorial last time. Continue where you stopped, or restart from the beginning.",
    resume: "Continue",
    restart: "Restart",
    resumeFromFocus: "Continue from here: {item}",
    missingTarget: "This item is unavailable in the current mode, so the tutorial will move on.",
    startBlocked: "The tutorial cannot start right now. Close the open dialog or finish the current operation first.",
  },
};

export function getTutorialUiCopy(language: Language): TutorialUiCopy {
  return copy[language];
}
