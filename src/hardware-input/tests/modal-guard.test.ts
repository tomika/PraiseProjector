/** The full view's modal detection: any visible backdrop/overlay/modal blocks hardware commands. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppModalOpen } from "../modalGuard";

const root = (rects: number[], seen: string[] = []) => ({
  querySelectorAll: (selector: string) => {
    seen.push(selector);
    return rects.map((count) => ({ getClientRects: () => ({ length: count }) })) as unknown as NodeListOf<Element>;
  },
});

test("a visible backdrop, Bootstrap modal or app overlay counts as an open modal", () => {
  const seen: string[] = [];
  assert.equal(isAppModalOpen(root([1], seen)), true);
  for (const part of [
    "[class*='backdrop']",
    ".modal.d-block",
    ".modal.show",
    ".messagebox-overlay",
    ".loading-overlay",
    ".songlist-context-menu-overlay",
  ]) {
    assert.ok(seen[0].includes(part), part);
  }
});

test("hidden or absent elements do not block; no document means no modal", () => {
  assert.equal(isAppModalOpen(root([0, 0])), false);
  assert.equal(isAppModalOpen(root([])), false);
  assert.equal(isAppModalOpen(null), false);
});

test("the default root is the document (absent in Node) and elements without layout info count", () => {
  assert.equal(isAppModalOpen(), false);
  assert.equal(isAppModalOpen({ querySelectorAll: () => [{}] as unknown as NodeListOf<Element> }), true);
});

test("with a document present the default root is used", () => {
  const globals = globalThis as Record<string, unknown>;
  globals.document = { querySelectorAll: () => [{ getClientRects: () => ({ length: 1 }) }] };
  try {
    assert.equal(isAppModalOpen(), true);
  } finally {
    delete globals.document;
  }
});
