// Where a double-clicked ABC score starts playing. Kept free of abcjs runtime
// and DOM globals so the choice is testable off-browser.
import type { NoteTimingEvent } from "abcjs";

/** A point in an SVG's own user units, in which abcjs reports note positions. */
export interface AbcScorePoint {
  readonly x: number;
  readonly y: number;
}

/** The parts of an `<svg>` element the conversion reads. */
export interface AbcScoreSvg {
  getBoundingClientRect(): { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  getAttribute(name: string): string | null;
  readonly viewBox?: { readonly baseVal: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null };
}

/**
 * Converts client coordinates into the score's user units. The bounding rect
 * already contains every CSS transform (the renderer's ABC scale, the client
 * view's fit), and the viewBox maps the rest. Without a viewBox (Chrome reports
 * a zero rect, Firefox null) the width/height attributes are the user units.
 */
export function abcScorePoint(svg: AbcScoreSvg, clientX: number, clientY: number): AbcScorePoint | null {
  const rect = svg.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const box = svg.viewBox?.baseVal ?? null;
  const hasWidth = !!box && box.width > 0;
  const hasHeight = !!box && box.height > 0;
  const width = hasWidth ? box.width : Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = hasHeight ? box.height : Number.parseFloat(svg.getAttribute("height") ?? "");
  if (!(width > 0 && height > 0)) return null;
  return {
    x: (hasWidth ? box.x : 0) + ((clientX - rect.left) * width) / rect.width,
    y: (hasHeight ? box.y : 0) + ((clientY - rect.top) * height) / rect.height,
  };
}

type PlacedNote = NoteTimingEvent & { left: number; top: number; height: number };

/**
 * The playback position (ms) for a double-click at `point`: the note nearest
 * to it on the staff system under it, or the nearest system when the point is
 * between or below them. Above the first system (title, composer) the whole
 * score plays. A repeated passage starts at its first pass.
 */
export function abcStartMilliseconds(timings: readonly NoteTimingEvent[], point: AbcScorePoint): number {
  const systems = new Map<number, { top: number; bottom: number; notes: PlacedNote[] }>();
  for (const event of timings) {
    if (event.type !== "event" || typeof event.left !== "number" || typeof event.top !== "number" || typeof event.height !== "number") continue;
    const note = event as PlacedNote;
    const line = note.line ?? 0;
    const system = systems.get(line);
    if (system) {
      system.top = Math.min(system.top, note.top);
      system.bottom = Math.max(system.bottom, note.top + note.height);
      system.notes.push(note);
    } else systems.set(line, { top: note.top, bottom: note.top + note.height, notes: [note] });
  }
  const ordered = [...systems.values()].sort((a, b) => a.top - b.top);
  if (!ordered.length || point.y < ordered[0].top) return 0;

  let system = ordered[0];
  let systemDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ordered) {
    const distance = point.y < candidate.top ? candidate.top - point.y : Math.max(0, point.y - candidate.bottom);
    if (distance < systemDistance) {
      system = candidate;
      systemDistance = distance;
    }
  }

  let best: PlacedNote | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const note of system.notes) {
    const distance = Math.abs(note.left + (note.width ?? 0) / 2 - point.x);
    if (distance < bestDistance || (distance === bestDistance && best && note.milliseconds < best.milliseconds)) {
      best = note;
      bestDistance = distance;
    }
  }
  return Math.max(0, best?.milliseconds ?? 0);
}

/** The note sounding at `milliseconds`: the last one that started by then. */
export function abcEventAt(timings: readonly NoteTimingEvent[], milliseconds: number): NoteTimingEvent | null {
  let current: NoteTimingEvent | null = null;
  for (const event of timings) {
    if (event.milliseconds > milliseconds) break;
    if (event.type === "event") current = event;
  }
  return current;
}
