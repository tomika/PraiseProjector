import { clientViewTutorial } from "./clientViewTutorial";
import { fullViewTutorial } from "./fullViewTutorial";
import type { TutorialDefinition, TutorialView } from "./tutorialTypes";

const definitions: Record<TutorialView, TutorialDefinition> = {
  full: fullViewTutorial,
  client: clientViewTutorial,
};

export function getTutorialDefinition(view: TutorialView): TutorialDefinition {
  return definitions[view];
}
