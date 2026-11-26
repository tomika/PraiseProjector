import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeaderGroupTree, leaderTreeOptionText, sharesOneGroupPath, type LeaderTreeItem } from "../leaderGroupTree.ts";

const root = { id: "g-root", name: "Magyar gyülekezetek" };
const szov = { id: "g-szov", name: "Szövétnek" };
const youth = { id: "g-youth", name: "Ifjúság" };
const eger = { id: "g-eger", name: "Egerszegi" };

const describe = (items: LeaderTreeItem[]) => buildLeaderGroupTree(items).map(leaderTreeOptionText);

test("groups come by name, each with its own leaders first and then its subgroups", () => {
  const rows = describe([
    { id: "l1", name: "Sas", groupPath: [root, szov] },
    { id: "l2", name: "Dés", groupPath: [root, szov] },
    { id: "l3", name: "Kata", groupPath: [root, szov, youth] },
    { id: "l4", name: "Lantos", groupPath: [root, eger] },
  ]);
  const i = (depth: number) => "   ".repeat(depth);
  assert.deepEqual(rows, [
    "▾ Magyar gyülekezetek",
    `${i(1)}▾ Egerszegi`,
    `${i(2)}Lantos`,
    `${i(1)}▾ Szövétnek`,
    `${i(2)}Dés`,
    `${i(2)}Sas`,
    `${i(2)}▾ Ifjúság`,
    `${i(3)}Kata`,
  ]);
});

test("leaders without a group path come last at the top level", () => {
  const rows = buildLeaderGroupTree([
    { id: "l1", name: "Zoltán" },
    { id: "l2", name: "Anna", groupPath: [eger] },
    { id: "l3", name: "Béla", groupPath: [] },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.name, row.depth]),
    [
      ["group", "Egerszegi", 0],
      ["leader", "Anna", 1],
      ["leader", "Béla", 0],
      ["leader", "Zoltán", 0],
    ]
  );
});

test("groups are told apart by id, not by name, and keys are unique", () => {
  const rows = buildLeaderGroupTree([
    { id: "l1", name: "A", groupPath: [{ id: "x", name: "Same" }] },
    { id: "l2", name: "B", groupPath: [{ id: "y", name: "Same" }] },
  ]);
  const groups = rows.filter((row) => row.kind === "group");
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups.map((row) => (row.kind === "group" ? row.key : ""))).size, 2);
});

test("no leaders, no rows", () => {
  assert.deepEqual(buildLeaderGroupTree([]), []);
});

test("leaders share one group path only when every path is the same", () => {
  assert.equal(
    sharesOneGroupPath([
      { id: "l1", name: "Sas", groupPath: [root, szov] },
      { id: "l2", name: "Dés", groupPath: [root, szov] },
    ]),
    true
  );
  assert.equal(
    sharesOneGroupPath([
      { id: "l1", name: "Sas", groupPath: [root, szov] },
      { id: "l3", name: "Kata", groupPath: [root, szov, youth] },
    ]),
    false
  );
  assert.equal(
    sharesOneGroupPath([
      { id: "l1", name: "Sas" },
      { id: "l2", name: "Dés", groupPath: [] },
    ]),
    true
  );
  assert.equal(
    sharesOneGroupPath([
      { id: "l1", name: "Sas" },
      { id: "l4", name: "Lantos", groupPath: [eger] },
    ]),
    false
  );
  assert.equal(sharesOneGroupPath([]), true);
});
