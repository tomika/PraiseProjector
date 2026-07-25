import type { PerformanceFeatureMode, ProjectionRenderQualityMode, Settings } from "../types";
import { readPersistedSettings } from "../services/settingsStore.ts";

export interface PerformancePreferences {
  fullViewChordProPageTurnMode: PerformanceFeatureMode;
  clientViewPageTurnMode: PerformanceFeatureMode;
  clientViewLivePitchPreviewMode: PerformanceFeatureMode;
  uiAnimationMode: PerformanceFeatureMode;
  playlistProjectionCheckMode: PerformanceFeatureMode;
  projectionRenderQualityMode: ProjectionRenderQualityMode;
  projectedImageCacheMode: PerformanceFeatureMode;
}

export const DEFAULT_PERFORMANCE_PREFERENCES: PerformancePreferences = {
  fullViewChordProPageTurnMode: "auto",
  clientViewPageTurnMode: "auto",
  clientViewLivePitchPreviewMode: "auto",
  uiAnimationMode: "auto",
  playlistProjectionCheckMode: "auto",
  projectionRenderQualityMode: "auto",
  projectedImageCacheMode: "auto",
};

export function normalizePerformanceFeatureMode(value: unknown, fallback: PerformanceFeatureMode = "auto"): PerformanceFeatureMode {
  return value === "off" || value === "auto" || value === "on" ? value : fallback;
}

export function normalizeProjectionRenderQualityMode(value: unknown): ProjectionRenderQualityMode {
  return value === "performance" || value === "auto" || value === "quality" ? value : "auto";
}

export function normalizePerformancePreferences(settings: Partial<Settings>): PerformancePreferences {
  return {
    fullViewChordProPageTurnMode: normalizePerformanceFeatureMode(settings.fullViewChordProPageTurnMode),
    clientViewPageTurnMode: normalizePerformanceFeatureMode(settings.clientViewPageTurnMode),
    clientViewLivePitchPreviewMode: normalizePerformanceFeatureMode(settings.clientViewLivePitchPreviewMode),
    uiAnimationMode: normalizePerformanceFeatureMode(settings.uiAnimationMode),
    playlistProjectionCheckMode: normalizePerformanceFeatureMode(
      settings.playlistProjectionCheckMode,
      settings.displayPlaylistUpdateInterval === -1 ? "off" : "auto"
    ),
    projectionRenderQualityMode: normalizeProjectionRenderQualityMode(settings.projectionRenderQualityMode),
    projectedImageCacheMode: normalizePerformanceFeatureMode(settings.projectedImageCacheMode),
  };
}

export function readPerformancePreferences(): PerformancePreferences {
  return normalizePerformancePreferences(readPersistedSettings());
}

export function resolvePerformanceFeature(mode: PerformanceFeatureMode, automaticallyDisabled: boolean): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return !automaticallyDisabled;
}

export function capRenderDimensions(width: number, height: number, maxLongEdge = 1920): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const longEdge = Math.max(safeWidth, safeHeight);
  if (longEdge <= maxLongEdge) return { width: safeWidth, height: safeHeight };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

export function resolveProjectionRenderDimensions(
  mode: ProjectionRenderQualityMode,
  projectionSlow: boolean,
  width: number,
  height: number
): { width: number; height: number } {
  return mode === "performance" || (mode === "auto" && projectionSlow)
    ? capRenderDimensions(width, height)
    : { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

export function projectedImageCacheBudget(mode: PerformanceFeatureMode, renderWidth: number, renderHeight: number): number {
  if (mode === "off") return 0;
  if (mode === "on") return 128 * 1024 * 1024;

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memoryBudget = deviceMemory !== undefined && deviceMemory <= 4 ? 24 : deviceMemory !== undefined && deviceMemory >= 8 ? 64 : 40;
  const pixelCount = Math.max(1, renderWidth * renderHeight);
  const resolutionFactor = Math.max(1, pixelCount / (1920 * 1080));
  return Math.max(12, Math.round(memoryBudget / Math.sqrt(resolutionFactor))) * 1024 * 1024;
}

let animationCleanup: (() => void) | null = null;

/** Applies the renderer-local UI animation preference in both the full and standalone client views. */
export function installUiAnimationPreference(): () => void {
  animationCleanup?.();
  if (typeof window === "undefined") return () => {};

  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => {
    const mode = readPerformancePreferences().uiAnimationMode;
    const reduce = mode === "off" || (mode === "auto" && media.matches);
    document.documentElement.toggleAttribute("data-pp-reduce-motion", reduce);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === "pp-settings") apply();
  };
  apply();
  window.addEventListener("pp-settings-changed", apply);
  window.addEventListener("storage", onStorage);
  media.addEventListener?.("change", apply);

  const cleanup = () => {
    window.removeEventListener("pp-settings-changed", apply);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener?.("change", apply);
    if (animationCleanup === cleanup) animationCleanup = null;
  };
  animationCleanup = cleanup;
  return cleanup;
}
