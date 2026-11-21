/**
 * Help topics for MCP clients, built from the texts the application already ships:
 * the two built-in tutorials (full view and client view) and the button tooltips.
 * Nothing here is written separately, so the help cannot drift from the UI.
 */
import type { HelpIcon, TutorialDefinition, TutorialStep } from "../../tutorial/tutorialTypes";

export type HelpLanguage = "en" | "hu";

interface HelpLine {
  prefix: string;
  text: string;
  icons?: TutorialStep["helpIcons"];
}

export interface HelpTopic {
  id: string;
  /** "full-view", "client-view" or "buttons". */
  area: string;
  title: string;
  text: string;
  /** Formatted lines for the web help generator. */
  lines?: readonly HelpLine[];
  /** Parts of the screen the app can point at (see the show_in_app tool). */
  targets?: { id: string; title: string }[];
}

export interface HelpSources {
  tutorials: readonly TutorialDefinition[];
  tooltips: Record<HelpLanguage, Record<string, string>>;
  tooltipIcons?: Readonly<Record<string, readonly HelpIcon[]>>;
}

const AREA: Record<string, string> = { full: "full-view", client: "client-view" };

const TOOLTIP_GROUPS: Record<string, Record<HelpLanguage, string>> = {
  toolbar: { en: "Toolbar buttons", hu: "Eszköztár gombjai" },
  playlist: { en: "Playlist buttons", hu: "Lejátszási lista gombjai" },
  format: { en: "Format tab buttons", hu: "Formázás fül gombjai" },
  song: { en: "Song filters and preferences", hu: "Dalszűrés és kedveltség" },
  songtree: { en: "Using the song library", hu: "Dalkönyvtár használata" },
  sectionlist: { en: "Using the section list", hu: "Szakaszlista használata" },
  dbsync: { en: "Resolving sync differences", hu: "Szinkronizálási eltérések feloldása" },
};

function stepLines(step: TutorialStep, language: HelpLanguage, depth: number): HelpLine[] {
  const text = step.text[language];
  const lines: HelpLine[] = [
    {
      prefix: depth === 0 ? "" : `${"  ".repeat(depth - 1)}- `,
      text: depth === 0 ? text.body : `${text.title}: ${text.body}`,
      icons: step.helpIcons,
    },
  ];
  for (const detail of step.details ?? []) lines.push(...stepLines(detail, language, depth + 1));
  for (const branch of step.branches ?? []) {
    lines.push({ prefix: `${"  ".repeat(depth)}- `, text: `${branch.label[language]}:` });
    for (const branchStep of branch.steps) lines.push(...stepLines(branchStep, language, depth + 2));
  }
  return lines;
}

export function buildHelpTopics(sources: HelpSources, language: HelpLanguage, { includeIcons = false } = {}): HelpTopic[] {
  const topics: HelpTopic[] = [];
  for (const tutorial of sources.tutorials) {
    for (const step of tutorial.steps) {
      const lines = stepLines(step, language, 0);
      topics.push({
        id: `${tutorial.view}/${step.id}`,
        area: AREA[tutorial.view] ?? tutorial.view,
        title: step.text[language].title,
        text: lines.map(({ prefix, text }) => prefix + text).join("\n"),
        ...(includeIcons ? { lines } : {}),
        targets: [step, ...(step.details ?? [])].map((part, index) => ({
          id: index ? `${tutorial.view}/${step.id}/${part.id}` : `${tutorial.view}/${step.id}`,
          title: part.text[language].title,
        })),
      });
    }
  }
  const groups = new Map<string, HelpLine[]>();
  for (const [key, text] of Object.entries(sources.tooltips[language] ?? {})) {
    const group = key.split("_")[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ prefix: "- ", text, icons: sources.tooltipIcons?.[key] });
  }
  for (const [group, lines] of groups) {
    topics.push({
      id: `buttons/${group}`,
      area: "buttons",
      title: TOOLTIP_GROUPS[group]?.[language] ?? `${group} (${language === "hu" ? "gombok" : "buttons"})`,
      text: lines.map(({ prefix, text }) => prefix + text).join("\n"),
      ...(includeIcons ? { lines } : {}),
    });
  }
  return topics;
}

export function renderHelpMarkdown(topics: readonly HelpTopic[]): string {
  return topics.map((topic) => `## ${topic.title}\n(${topic.area}, id: ${topic.id})\n\n${topic.text}`).join("\n\n");
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

const SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "full/song-tree": ["favorite song", "favorite songs", "preferred song", "preferred songs", "kedvelt dal", "kedvelt dalok", "sziv ikon"],
  "full/playlist": ["favorite playlist", "favorite playlists", "kedvenc musortar", "kedvenc musortarak"],
};

/** Topics that contain the query words, best match first. An empty query returns none. */
export function searchHelp(topics: readonly HelpTopic[], query: string, limit: number): HelpTopic[] {
  const words = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  if (!words.length) return [];
  const phrase = ` ${words.join(" ")} `;
  const scored: { topic: HelpTopic; score: number; alias: boolean; order: number }[] = [];
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
    const alias = SEARCH_ALIASES[topic.id]?.some((term) => phrase.includes(` ${term} `)) ?? false;
    // Topics matching every word come before partial matches.
    if (alias || matched) scored.push({ topic, score: score + (matched === words.length ? 100 : 0), alias, order });
  });
  return scored
    .sort((a, b) => Number(b.alias) - Number(a.alias) || b.score - a.score || a.order - b.order)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.topic);
}
