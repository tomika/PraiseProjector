/**
 * Group-tree arrangement of the leader pickers (the full-view load dialog and
 * the client view; see the `leaderTreeView` setting). The cloud sends every
 * listed leader's groups from the root down (`groupPath`); this turns them into
 * the rows of one native select, which cannot nest.
 *
 * Pure: no React, no Electron, no localization.
 */
import type { LeaderGroupRef } from "../../common/pp-types";

export interface LeaderTreeItem {
  id: string;
  name: string;
  groupPath?: readonly LeaderGroupRef[];
}

export type LeaderTreeRow = { kind: "group"; key: string; name: string; depth: number } | { kind: "leader"; id: string; name: string; depth: number };

interface GroupNode {
  name: string;
  groups: Map<string, GroupNode>;
  leaders: LeaderTreeItem[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * The rows of the group tree. Each group (sorted by name) is followed by its own
 * leaders (sorted by name) one level deeper, then by its subgroups. Only groups
 * with a leader somewhere below them appear. Leaders without a group path come
 * last, at the top level.
 */
export function buildLeaderGroupTree(items: readonly LeaderTreeItem[]): LeaderTreeRow[] {
  const root: GroupNode = { name: "", groups: new Map(), leaders: [] };
  for (const item of items) {
    let node = root;
    for (const group of item.groupPath ?? []) {
      let child = node.groups.get(group.id);
      if (!child) node.groups.set(group.id, (child = { name: group.name, groups: new Map(), leaders: [] }));
      node = child;
    }
    node.leaders.push(item);
  }

  const rows: LeaderTreeRow[] = [];
  const leaderRows = (leaders: LeaderTreeItem[], depth: number) =>
    [...leaders].sort(byName).forEach((leader) => rows.push({ kind: "leader", id: leader.id, name: leader.name, depth }));
  const visit = (node: GroupNode, depth: number, keyPrefix: string) => {
    const groups = [...node.groups.entries()].sort(([, a], [, b]) => byName(a, b));
    for (const [id, group] of groups) {
      const key = `${keyPrefix}/${id}`;
      rows.push({ kind: "group", key, name: group.name, depth });
      leaderRows(group.leaders, depth + 1);
      visit(group, depth + 1, key);
    }
  };
  visit(root, 0, "");
  leaderRows(root.leaders, 0);
  return rows;
}

/** True when every leader has the very same group path (no path counts as one
 *  too): a tree would only repeat the same headers above all of them. The
 *  "my group" section then stays a flat list even in tree mode. */
export function sharesOneGroupPath(items: readonly LeaderTreeItem[]): boolean {
  const pathKey = (item: LeaderTreeItem) => (item.groupPath ?? []).map((group) => group.id).join("/");
  const first = items[0];
  return !first || items.every((item) => pathKey(item) === pathKey(first));
}

const INDENT = "   ";

/** A row's text in a native select: indented by depth; a group carries a ▾. */
export function leaderTreeOptionText(row: LeaderTreeRow): string {
  return INDENT.repeat(row.depth) + (row.kind === "group" ? `▾ ${row.name}` : row.name);
}
