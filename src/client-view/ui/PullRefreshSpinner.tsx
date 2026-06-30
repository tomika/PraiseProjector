/**
 * PullRefreshSpinner — the visual for the pull-to-refresh gesture (see
 * usePullToRefresh), ported from the legacy loading circle: a filled white DISC
 * with a dark-blue reload arc inside (an SVG circle driven by `strokeDashoffset`),
 * NOT an outline ring. See #loading-circle in public/public/app/praiseprojector.css.
 *
 * While pulling below the arm distance the arc winds up as you pull down and
 * unwinds as you pull back up (`progress` 0..1, the legacy `perc`-driven
 * strokeDashoffset). Once the pull arms, the disc spins (legacy `animate` class)
 * and the DISC BACKGROUND escalates with the held level (white "refresh" → yellow
 * "replace" → orangered "clear"; the arc turns white on the top level).
 *
 * No text labels, by design: the two destructive levels (replace / clear) confirm
 * with their own animated-SVG dialog before acting, so the colour is just a danger
 * hint during the hold.
 */

import type { CSSProperties } from "react";
import type { PullPhase } from "./usePullToRefresh";

// Circumference of the r=16 arc circle (2π·16), so strokeDashoffset = C·(1−frac).
const ARC_CIRCUMFERENCE = 2 * Math.PI * 16;
// Arc length shown while spinning — a near-full circle with a small gap, so it
// reads as a reload glyph (legacy ~0.85 of the circumference).
const SPIN_ARC_FRACTION = 0.8;

export function PullRefreshSpinner({ phase, offset, progress, level }: { phase: PullPhase; offset: number; progress: number; level: number }) {
  if (phase === "idle") return null;
  const spinning = phase === "armed" || phase === "syncing";
  const frac = spinning ? SPIN_ARC_FRACTION : progress;
  return (
    <div className="cv-pull-wrap" style={{ "--cv-pull-offset": `${offset}px` } as CSSProperties} aria-hidden="true">
      <div className={`cv-pull-disc cv-pull-level-${level}${spinning ? " cv-pull-spinning" : ""}`}>
        <svg viewBox="0 0 36 36">
          <circle
            className="cv-pull-arc"
            cx="18"
            cy="18"
            r="16"
            style={{ strokeDasharray: ARC_CIRCUMFERENCE, strokeDashoffset: ARC_CIRCUMFERENCE * (1 - frac) }}
          />
        </svg>
      </div>
    </div>
  );
}
