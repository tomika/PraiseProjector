import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudApiService } from "../cloudApi";
import { parseAbcRange, sameAbcRange } from "../abc-range";
import { cloneDisplay, compareDisplays, getEmptyDisplay } from "../pp-utils";
import { getCurrentDisplay, updateCurrentDisplay } from "../../src/state/CurrentSongStore";

test("display publish, query and remote highlight preserve ABC pages and explicitly clear them", async (context) => {
  const api = new CloudApiService();
  const requests: { url: URL; body: Record<string, string> }[] = [];
  const range = { source: 12, from: 2, to: 4 };
  const display = { ...getEmptyDisplay(), songId: "score", abcRange: range };
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "https://test.invalid");
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, string> });
    return new Response(
      url.pathname === "/display_query" ? JSON.stringify(display) : url.pathname === "/highlight" ? JSON.stringify("UPDATED") : "DONE"
    );
  });
  await api.sendDisplayUpdate(display);
  assert.deepEqual(JSON.parse(requests.at(-1)!.body.abcRange), range);
  assert.deepEqual((await api.fetchDisplayQuery(display)).display.abcRange, range);
  assert.deepEqual(JSON.parse(requests.at(-1)!.url.searchParams.get("abcRange")!), range);
  await api.sendHighlight({ from: 12, to: 13, abcRange: range, leader: "leader" });
  assert.deepEqual(JSON.parse(requests.at(-1)!.url.searchParams.get("abcRange")!), range);
  await api.sendDisplayUpdate({ ...display, abcRange: undefined });
  assert.equal(requests.at(-1)!.body.abcRange, "null");
  await api.sendHighlight({ from: 0, to: 0, leader: "leader" });
  assert.equal(requests.at(-1)!.url.searchParams.get("abcRange"), "null");
});

test("invalid wire ranges cannot select arbitrary or unbounded score rows", () => {
  for (const value of [
    null,
    "broken",
    {},
    { source: -1, from: 0, to: 1 },
    { source: 0, from: 1, to: 1 },
    { source: 0, from: 0.5, to: 2 },
    { source: 0, from: 0, to: Infinity },
  ])
    assert.equal(parseAbcRange(value), undefined);
  assert.deepEqual(parseAbcRange('{"source":4,"from":2,"to":3}'), { source: 4, from: 2, to: 3 });
  assert.equal(sameAbcRange({ source: 4, from: 2, to: 3 }, { source: 4, from: 3, to: 4 }), false);
});

test("snapshot equality includes ABC repeat ranges and ordinary selection clears stale ABC state", () => {
  const original = {
    ...getEmptyDisplay(),
    abcRange: { source: 5, from: 0, to: 1 },
    sectionRepeatCounts: [{ section: 0, from: 5, to: 6, multiplier: 2, abcRange: { source: 5, from: 0, to: 1 } }],
  };
  const snapshot = cloneDisplay(original);
  assert.equal(compareDisplays(original, snapshot), true);
  const other = { ...original, sectionRepeatCounts: [{ ...original.sectionRepeatCounts[0], abcRange: { source: 5, from: 1, to: 2 } }] };
  assert.equal(compareDisplays(original, other), false);
  updateCurrentDisplay(original);
  updateCurrentDisplay({ transpose: 2 });
  assert.deepEqual(getCurrentDisplay().abcRange, original.abcRange);
  updateCurrentDisplay({ from: 7, to: 8 });
  assert.equal(getCurrentDisplay().abcRange, undefined);
});
