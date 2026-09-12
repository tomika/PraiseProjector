/**
 * Unit tests for the unsaved-work registry that gates Android's shared-link prompt.
 *
 * No test framework is configured in this repo, so these run on Node's built-in
 * runner with native TypeScript type-stripping (zero new dependencies):
 *
 *   cd public
 *   node --experimental-strip-types --test src/services/unsavedChangesReport.test.ts
 *
 * The .ts import extension is required by type-stripping and allowed by
 * allowImportingTsExtensions in tsconfig.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createUnsavedChangesRegistry } from "./unsavedChangesReport.ts";

test("a clean page report cannot clear a mounted editor draft", () => {
  const reports: boolean[] = [];
  const registry = createUnsavedChangesRegistry((dirty) => reports.push(dirty));
  const instructions = Symbol("instructions");
  const page = Symbol("page");
  registry.set(instructions, true);
  registry.set(page, false);
  assert.deepEqual(reports, [true]);
  registry.remove(instructions);
  assert.equal(reports.at(-1), false);
});

test("saving or closing one editor preserves another editor's unsaved work", () => {
  const reports: boolean[] = [];
  const registry = createUnsavedChangesRegistry((dirty) => reports.push(dirty));
  const song = Symbol("song");
  const playlist = Symbol("playlist");
  registry.set(song, true);
  registry.set(playlist, true);
  registry.set(song, false);
  registry.remove(song);
  assert.ok(reports.every(Boolean));
  registry.set(playlist, false);
  assert.equal(reports.at(-1), false);
});

test("same-kind editor instances have independent lifetimes", () => {
  let dirty = false;
  const registry = createUnsavedChangesRegistry((value) => {
    dirty = value;
  });
  const first = Symbol("editor");
  const second = Symbol("editor");
  registry.set(first, true);
  registry.set(second, true);
  registry.remove(first);
  registry.remove(first); // Late/duplicate cleanup must not affect the second instance.
  assert.equal(dirty, true);
  registry.remove(second);
  assert.equal(dirty, false);
});

test("StrictMode cleanup and re-registration do not leave a stale draft", () => {
  let dirty = false;
  const registry = createUnsavedChangesRegistry((value) => {
    dirty = value;
  });
  const editor = Symbol("editor");
  registry.set(editor, true);
  registry.remove(editor);
  registry.set(editor, true);
  assert.equal(dirty, true);
  registry.set(editor, false);
  registry.remove(editor);
  assert.equal(dirty, false);
});
