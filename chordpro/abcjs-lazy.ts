/**
 * Lazy loader for abcjs (~495 KB minified).
 *
 * abcjs is only needed to render / transpose / synth-play ABC-notation blocks and
 * the chord selector's music-staff box — features absent from the overwhelming
 * majority of songs. Keeping it behind a dynamic import lets Rollup split it into
 * its own chunk so the initial client-view payload stays small enough for old
 * Android WebViews (Phase C "bundle diet").
 *
 * The consuming call sites are synchronous (the chord-pro layout is layout-coupled
 * to the measured ABC height), so they read the cached module through `abcjs()` and
 * must guard with `isAbcjsLoaded()`. When abcjs is not yet loaded they kick off
 * `loadAbcjs()` and render a zero-height placeholder, then re-render once it
 * resolves (see ChordProEditor.ensureAbcjsLoaded). Songs without ABC never load it.
 */
import type * as Abcjs from "abcjs";

type AbcjsModule = typeof Abcjs;

let cached: AbcjsModule | null = null;
let loading: Promise<AbcjsModule> | null = null;

/** True once the abcjs chunk has finished loading and `abcjs()` is safe to call. */
export function isAbcjsLoaded(): boolean {
  return cached !== null;
}

/** Dynamically import abcjs, caching the module. Idempotent / de-duplicated. */
export function loadAbcjs(): Promise<AbcjsModule> {
  if (cached) return Promise.resolve(cached);
  if (!loading) {
    loading = import("abcjs").then((mod) => {
      const ns = mod as AbcjsModule & { default?: AbcjsModule };
      // Prefer the live namespace (matches the prior static named imports); fall
      // back to `default` for CJS-interop builds that nest the exports there.
      const hasNamedExports = typeof (ns as { renderAbc?: unknown }).renderAbc === "function";
      cached = hasNamedExports ? ns : (ns.default ?? ns);
      return cached;
    });
  }
  return loading;
}

/** Return the loaded abcjs module. Throws if accessed before `loadAbcjs()` resolves. */
export function abcjs(): AbcjsModule {
  if (!cached) throw new Error("abcjs accessed before load; guard with isAbcjsLoaded()/loadAbcjs()");
  return cached;
}
