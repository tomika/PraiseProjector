import { readPersistedSettingsText } from "./persisted-settings";

/** Song-independent defaults for ABC engraving and playback. MIDI programs are zero-based. */
export interface ScoreDefaults {
  program: number;
  bassprog: number;
  chordprog: number;
  bassvol: number;
  chordvol: number;
  swing: number;
  chordsOff: boolean;
  voicesOff: boolean;
  paddingtop: number;
  paddingbottom: number;
}

export function createDefaultScoreDefaults(): ScoreDefaults {
  return {
    program: 0,
    bassprog: 0,
    chordprog: 0,
    bassvol: 64,
    chordvol: 48,
    swing: 50,
    chordsOff: false,
    voicesOff: false,
    paddingtop: 15,
    paddingbottom: 15,
  };
}

export function normalizeScoreDefaults(value: unknown): ScoreDefaults {
  const defaults = createDefaultScoreDefaults();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const saved = value as Record<string, unknown>;
  for (const key of ["program", "bassprog", "chordprog", "bassvol", "chordvol"] as const) {
    const n = saved[key];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 127) defaults[key] = n;
  }
  for (const key of ["swing", "paddingtop", "paddingbottom"] as const) {
    const n = saved[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) defaults[key] = n;
  }
  for (const key of ["chordsOff", "voicesOff"] as const) {
    if (typeof saved[key] === "boolean") defaults[key] = saved[key];
  }
  return defaults;
}

let persistedCache: { text: string | null; defaults: Readonly<ScoreDefaults> } | null = null;

/**
 * The saved score defaults, read without a `SettingsProvider` (the standalone client
 * view has none). Parsed once per distinct `pp-settings` text, because renderers call
 * this for every ABC block. The returned object is shared: copy it before changing it.
 */
export function readPersistedScoreDefaults(): Readonly<ScoreDefaults> {
  const text = readPersistedSettingsText();
  if (persistedCache?.text === text) return persistedCache.defaults;
  let saved: unknown;
  try {
    saved = text ? (JSON.parse(text) as { scoreDefaults?: unknown } | null)?.scoreDefaults : undefined;
  } catch {
    saved = undefined;
  }
  persistedCache = { text, defaults: normalizeScoreDefaults(saved) };
  return persistedCache.defaults;
}
