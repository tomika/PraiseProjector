import type { TutorialCleanup, TutorialDetailSurface, TutorialView } from "./tutorialTypes";

/** Opens an application surface (e.g. a dialog) for a step's details; the returned cleanup closes it again. */
export type TutorialDetailSurfaceOpener = (surface: TutorialDetailSurface) => void | TutorialCleanup;

// Tutorial step definitions are static data without access to React state, so
// the view that owns a surface lends its opener here. Both the tutorial host and
// the MCP spotlight reach the surface through this one channel.
const openers = new Map<TutorialView, TutorialDetailSurfaceOpener>();

/** Lend the view's surface opener; the returned function withdraws it (only if still the registered one). */
export function registerTutorialDetailSurfaceOpener(view: TutorialView, opener: TutorialDetailSurfaceOpener): () => void {
  openers.set(view, opener);
  return () => {
    if (openers.get(view) === opener) openers.delete(view);
  };
}

/** Open a detail surface of the given view. Returns its cleanup, or nothing if no opener is registered or it declined. */
export function openTutorialDetailSurface(view: TutorialView, surface: TutorialDetailSurface): void | TutorialCleanup {
  return openers.get(view)?.(surface);
}
