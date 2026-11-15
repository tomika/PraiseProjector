/**
 * Help topics for MCP clients, built from the texts the application already ships:
 * the two built-in tutorials (full view and client view) and the button tooltips.
 * Nothing here is written separately, so the help cannot drift from the UI.
 */
import type { TutorialDefinition, TutorialStep } from "../../tutorial/tutorialTypes";

export type HelpLanguage = "en" | "hu";

export interface HelpTopic {
  id: string;
  /** "full-view", "client-view" or "buttons". */
  area: string;
  title: string;
  text: string;
  /** Parts of the screen the app can point at (see the show_in_app tool). */
  targets?: { id: string; title: string }[];
}

export interface HelpSources {
  tutorials: readonly TutorialDefinition[];
  tooltips: Record<HelpLanguage, Record<string, string>>;
}

const AREA: Record<string, string> = { full: "full-view", client: "client-view" };

const TOOLTIP_GROUPS: Record<string, Record<HelpLanguage, string>> = {
  toolbar: { en: "Toolbar buttons", hu: "Eszköztár gombjai" },
  playlist: { en: "Playlist buttons", hu: "Lejátszási lista gombjai" },
  format: { en: "Format tab buttons", hu: "Formázás fül gombjai" },
};

function stepLines(step: TutorialStep, language: HelpLanguage, depth: number): string[] {
  const text = step.text[language];
  const lines = depth === 0 ? [text.body] : [`${"  ".repeat(depth - 1)}- ${text.title}: ${text.body}`];
  for (const detail of step.details ?? []) lines.push(...stepLines(detail, language, depth + 1));
  for (const branch of step.branches ?? []) {
    lines.push(`${"  ".repeat(depth)}- ${branch.label[language]}:`);
    for (const branchStep of branch.steps) lines.push(...stepLines(branchStep, language, depth + 2));
  }
  return lines;
}

export function buildHelpTopics(sources: HelpSources, language: HelpLanguage): HelpTopic[] {
  const topics: HelpTopic[] = [];
  for (const tutorial of sources.tutorials) {
    for (const step of tutorial.steps) {
      topics.push({
        id: `${tutorial.view}/${step.id}`,
        area: AREA[tutorial.view] ?? tutorial.view,
        title: step.text[language].title,
        text: stepLines(step, language, 0).join("\n"),
        targets: [step, ...(step.details ?? [])].map((part, index) => ({
          id: index ? `${tutorial.view}/${step.id}/${part.id}` : `${tutorial.view}/${step.id}`,
          title: part.text[language].title,
        })),
      });
    }
  }
  const groups = new Map<string, string[]>();
  for (const [key, text] of Object.entries(sources.tooltips[language] ?? {})) {
    const group = key.split("_")[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(`- ${text}`);
  }
  for (const [group, lines] of groups) {
    topics.push({
      id: `buttons/${group}`,
      area: "buttons",
      title: TOOLTIP_GROUPS[group]?.[language] ?? `${group} (${language === "hu" ? "gombok" : "buttons"})`,
      text: lines.join("\n"),
    });
  }
  return topics;
}

/** The tutorial steps behind a target id ("full/step" or "full/step/detail"), outermost first. */
export function findTutorialSteps(tutorials: readonly TutorialDefinition[], id: string): { view: string; steps: TutorialStep[] } | null {
  const [view, stepId, detailId] = id.split("/");
  const step = tutorials.find((tutorial) => tutorial.view === view)?.steps.find((candidate) => candidate.id === stepId);
  if (!step) return null;
  if (!detailId) return { view, steps: [step] };
  const detail = step.details?.find((candidate) => candidate.id === detailId);
  return detail ? { view, steps: [step, detail] } : null;
}

/** Lower case without diacritics, so "lejatszasi" finds "lejátszási". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

/** Topics that contain the query words, best match first. An empty query returns none. */
export function searchHelp(topics: readonly HelpTopic[], query: string, limit: number): HelpTopic[] {
  const words = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  if (!words.length) return [];
  const scored: { topic: HelpTopic; score: number; order: number }[] = [];
  topics.forEach((topic, order) => {
    const title = foldText(topic.title);
    const text = foldText(topic.text);
    let score = 0;
    let matched = 0;
    for (const word of words) {
      const inTitle = title.includes(word);
      const occurrences = text.split(word).length - 1;
      if (inTitle || occurrences) matched++;
      score += (inTitle ? 5 : 0) + Math.min(occurrences, 4);
    }
    // Topics matching every word come before partial matches.
    if (matched) scored.push({ topic, score: score + (matched === words.length ? 100 : 0), order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.topic);
}
