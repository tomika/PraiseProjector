/**
 * Passive, runtime-local performance profile for ChordPro-driven views.
 *
 * Browser, PWA and Electron views share a small, separate localStorage record.
 * The profile is based on work the user already caused (currently settled
 * ChordPro renders), not a synthetic startup benchmark.
 */

declare const __APP_VERSION__: string;

const STORAGE_KEY = "pp-client-performance-profile";
const SCHEMA_VERSION = 2;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 5;
const SLOW_RENDER_THRESHOLD_MS = 60;
const MAX_REASONABLE_RENDER_MS = 30_000;

interface PersistedClientPerformanceProfile {
  schemaVersion: number;
  appVersion: string;
  chordProRenderSamplesMs: number[];
  chordProSlow: boolean;
  updatedAt: number;
}

export interface ClientPerformanceSnapshot {
  /** True once repeated settled renders show that live ChordPro work is slow. */
  chordProSlow: boolean;
  /** True after enough passive samples exist to make a classification. */
  chordProMeasured: boolean;
  /** Median of the bounded initial sample window, for diagnostics. */
  chordProMedianRenderMs: number | null;
  chordProSampleCount: number;
}

const listeners = new Set<() => void>();

function appVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "development";
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function emptyProfile(): PersistedClientPerformanceProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: appVersion(),
    chordProRenderSamplesMs: [],
    chordProSlow: false,
    updatedAt: Date.now(),
  };
}

function readProfile(): PersistedClientPerformanceProfile {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage?.getItem(STORAGE_KEY) : null;
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as Partial<PersistedClientPerformanceProfile>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.appVersion !== appVersion()) return emptyProfile();
    const samples = Array.isArray(parsed.chordProRenderSamplesMs)
      ? parsed.chordProRenderSamplesMs
          .filter((value): value is number => Number.isFinite(value) && value >= 0 && value <= MAX_REASONABLE_RENDER_MS)
          .slice(-MAX_SAMPLES)
      : [];
    return {
      schemaVersion: SCHEMA_VERSION,
      appVersion: appVersion(),
      chordProRenderSamplesMs: samples,
      chordProSlow: parsed.chordProSlow === true,
      updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return emptyProfile();
  }
}

function toSnapshot(profile: PersistedClientPerformanceProfile): ClientPerformanceSnapshot {
  return {
    chordProSlow: profile.chordProSlow,
    chordProMeasured: profile.chordProRenderSamplesMs.length >= MIN_SAMPLES,
    chordProMedianRenderMs: median(profile.chordProRenderSamplesMs),
    chordProSampleCount: profile.chordProRenderSamplesMs.length,
  };
}

function persistProfile(profile: PersistedClientPerformanceProfile): void {
  try {
    if (typeof window !== "undefined") window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* PWA private mode / embedded webviews may make storage unavailable. */
  }
}

let profile = readProfile();
let snapshot = toSnapshot(profile);

export function getClientPerformanceSnapshot(): ClientPerformanceSnapshot {
  return snapshot;
}

export function subscribeClientPerformance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Record one real, settled current-page ChordPro render/update. A bounded median
 * filters out cold-font and one-off scheduling spikes. Once a device is classified
 * slow (or five samples establish a fast profile) collection stops for this app
 * version, avoiding both oscillation and measurement-storage overhead.
 */
export function recordChordProRenderDuration(durationMs: number): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_REASONABLE_RENDER_MS) return;
  if (profile.chordProSlow || profile.chordProRenderSamplesMs.length >= MAX_SAMPLES) return;

  const samples = [...profile.chordProRenderSamplesMs, durationMs];
  const measuredMedian = median(samples);
  const slow = profile.chordProSlow || (samples.length >= MIN_SAMPLES && measuredMedian !== null && measuredMedian >= SLOW_RENDER_THRESHOLD_MS);
  profile = {
    ...profile,
    chordProRenderSamplesMs: samples,
    chordProSlow: slow,
    updatedAt: Date.now(),
  };
  persistProfile(profile);

  const nextSnapshot = toSnapshot(profile);
  if (
    nextSnapshot.chordProSlow === snapshot.chordProSlow &&
    nextSnapshot.chordProMeasured === snapshot.chordProMeasured &&
    nextSnapshot.chordProMedianRenderMs === snapshot.chordProMedianRenderMs &&
    nextSnapshot.chordProSampleCount === snapshot.chordProSampleCount
  ) {
    return;
  }
  snapshot = nextSnapshot;
  for (const listener of [...listeners]) listener();
}
