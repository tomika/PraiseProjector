import assert from "node:assert/strict";
import { test } from "node:test";
import { hotStableContext } from "../hotStableContext";

test("without hot reload (production) every call is a plain createContext", () => {
  const first = hotStableContext(undefined, "settings", "default");
  const second = hotStableContext(undefined, "settings", "default");
  assert.notEqual(first, second);
  assert.equal((first as unknown as { _currentValue: string })._currentValue, "default");
});

test("a re-evaluated module gets back the context its mounted provider still feeds", () => {
  const hot = { data: {} as Record<string, unknown> };
  const before = hotStableContext(hot, "settings", undefined);
  const after = hotStableContext(hot, "settings", undefined);
  assert.equal(after, before);
  assert.notEqual(hotStableContext(hot, "theme", undefined), before, "each key is its own context");
});
