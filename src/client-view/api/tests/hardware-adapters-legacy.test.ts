/**
 * Characterization of the transpose/capo preview/commit split per adapter (R14):
 * Direct applies on preview and skips commit; REST previews locally and pushes a
 * minimal preference on commit (controllers only); the PPD follow branch sends a
 * song_update on commit. Recorded against the pre-refactor adapters. Also: a
 * projection superseded before the display changes lands in neither adapter.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { cloudApi } from "../../../../common/cloudApi";
import type { Display } from "../../../../common/pp-types";
import type { DisplayApi } from "../ClientApi";
import { createDisplayApi } from "../rest/restPorts";
import type { RestCore } from "../rest/RestCore";

const display = (songId: string, extra: Partial<Display> = {}): Display => ({
  songId,
  song: songId,
  system: "G",
  from: 2,
  to: 5,
  transpose: 0,
  ...extra,
});

function restFixture(
  options: {
    canControl?: boolean;
    ppd?: boolean;
    leaderId?: string;
    loadSongData?: (songId: string) => Promise<{ text: string; system: string }>;
  } = {}
) {
  let current = display("projected");
  const ppd: unknown[] = [];
  const preferences: unknown[][] = [];
  const updates: unknown[][] = [];
  const core = {
    mode: "App",
    leader: options.leaderId ? { id: options.leaderId, name: "Leader" } : null,
    config: {},
    getDisplay: () => current,
    setDisplay: (next: Display) => {
      current = next;
    },
    loadSongData: options.loadSongData ?? (async (songId: string) => ({ text: songId, system: "G" })),
    patchDisplay: (patch: Partial<Display>) => {
      current = { ...current, ...patch };
    },
    canControlDisplay: () => options.canControl ?? true,
    isFollowingPpd: () => !!options.ppd,
    sendPpdDisplayUpdate: async (update: unknown) => {
      ppd.push(update);
    },
  } as unknown as RestCore;
  const api = cloudApi as unknown as Record<string, unknown>;
  const original = { sendDisplayPreference: api.sendDisplayPreference, sendDisplayUpdate: api.sendDisplayUpdate };
  api.sendDisplayPreference = async (...args: unknown[]) => {
    preferences.push(args);
    return "OK";
  };
  api.sendDisplayUpdate = async (...args: unknown[]) => {
    updates.push(args);
    return "OK";
  };
  return {
    display: createDisplayApi(core),
    current: () => current,
    ppd,
    preferences,
    updates,
    restore: () => Object.assign(api, original),
  };
}

test("REST: preview patches only the local display, commit pushes a minimal preference", async () => {
  const f = restFixture({ leaderId: "leader-1" });
  try {
    await f.display.setTranspose(3, false);
    await f.display.setCapo(4, false);
    assert.equal(f.current().transpose, 3);
    assert.equal(f.current().capo, 4);
    assert.deepEqual(f.preferences, []);
    await f.display.setTranspose(0, true);
    await f.display.setCapo(-1, true);
    assert.deepEqual(f.preferences, [
      [{ id: "projected", transpose: 0 }, { leaderId: "leader-1" }],
      [{ id: "projected", capo: -1 }, { leaderId: "leader-1" }],
    ]);
    assert.deepEqual(f.updates, [], "no full display_update for a preference");
  } finally {
    f.restore();
  }
});

test("REST: a follower keeps transpose/capo local even on commit", async () => {
  const f = restFixture({ canControl: false });
  try {
    await f.display.setTranspose(5, true);
    await f.display.setCapo(2, true);
    assert.equal(f.current().transpose, 5);
    assert.equal(f.current().capo, 2);
    assert.deepEqual(f.preferences, []);
    assert.deepEqual(f.ppd, []);
  } finally {
    f.restore();
  }
});

test("REST: following PPD sends song_update on commit only", async () => {
  const f = restFixture({ ppd: true });
  try {
    await f.display.setTranspose(-2, false);
    assert.deepEqual(f.ppd, []);
    await f.display.setTranspose(-2, true);
    await f.display.setCapo(3, true);
    assert.deepEqual(f.ppd, [
      { command: "song_update", id: "projected", from: 2, to: 5, transpose: -2 },
      { command: "song_update", id: "projected", from: 2, to: 5, capo: 3 },
    ]);
    assert.deepEqual(f.preferences, []);
  } finally {
    f.restore();
  }
});

// The Direct adapter imports desktop modules that cannot load in Node; transpile
// just the adapter and run its real display port with isolated dependencies.
const directCode = ts.transpileModule(readFileSync(new URL("../direct/DirectClientApi.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function directFixture(options: { ppd?: boolean } = {}) {
  const dispatched: Record<string, unknown>[] = [];
  const conditions: unknown[] = [];
  const hostPpd: unknown[] = [];
  const modules: Record<string, unknown> = {
    "../../../services/hostDevicePpd": {
      isHostDevicePpdAvailable: () => true,
      sendHostDevicePpdDisplayUpdate: async (update: unknown) => {
        hostPpd.push(JSON.parse(JSON.stringify(update)));
      },
    },
  };
  const exports: { DirectClientApi?: { prototype: object } } = {};
  runInNewContext(directCode, { exports, require: (id: string) => modules[id] ?? {}, AbortController });
  const adapter = Object.assign(Object.create(exports.DirectClientApi!.prototype), {
    displaySource: { getCurrent: () => display("host-song") },
    lastFollow: options.ppd ? { kind: "ppd", sessionId: "s" } : null,
    ppdWatching: !!options.ppd,
    chordProStyles: null,
    // Objects created inside the VM realm have foreign prototypes; compare plain copies.
    dispatchDisplayUpdate: (detail: Record<string, unknown>, isCurrent?: () => boolean) => {
      dispatched.push(JSON.parse(JSON.stringify(detail)));
      conditions.push(isCurrent);
    },
  }) as { createDisplayApi(): DisplayApi };
  return { display: adapter.createDisplayApi(), dispatched, conditions, hostPpd };
}

test("Direct: preview applies to the in-process host, commit is a no-op", async () => {
  const f = directFixture();
  await f.display.setTranspose(3, false);
  await f.display.setTranspose(3, true);
  await f.display.setCapo(0, false);
  await f.display.setCapo(0, true);
  assert.deepEqual(f.dispatched, [
    { command: "song_update", id: "host-song", transpose: 3 },
    { command: "song_update", id: "host-song", capo: 0 },
  ]);
  assert.deepEqual(f.hostPpd, []);
});

test("Direct: following PPD sends song_update to the host bridge on commit only", async () => {
  const f = directFixture({ ppd: true });
  await f.display.setTranspose(-4, false);
  await f.display.setCapo(6, false);
  assert.deepEqual(f.hostPpd, []);
  await f.display.setTranspose(-4, true);
  await f.display.setCapo(6, true);
  assert.deepEqual(f.hostPpd, [
    { command: "song_update", id: "host-song", from: 2, to: 5, transpose: -4 },
    { command: "song_update", id: "host-song", from: 2, to: 5, capo: 6 },
  ]);
  assert.deepEqual(f.dispatched, []);
});

test("REST: a projection superseded while its song loads changes neither the display nor the push", async () => {
  const loaded = new Map<string, () => void>();
  const f = restFixture({
    leaderId: "leader-1",
    loadSongData: (songId) => new Promise((resolve) => loaded.set(songId, () => resolve({ text: songId, system: "G" }))),
  });
  try {
    let latest = 0;
    const project = (songId: string) => {
      const request = ++latest;
      return f.display.project({ songId }, { isCurrent: () => request === latest });
    };
    const slow = project("p2");
    const newer = project("p3");
    loaded.get("p3")!();
    await newer;
    loaded.get("p2")!();
    await slow;
    assert.equal(f.current().songId, "p3", "the newer selection stays");
    assert.deepEqual(
      f.updates.map(([update]) => (update as { songId: string }).songId),
      ["p3"],
      "the superseded projection is never pushed"
    );
    const plain = f.display.project({ songId: "p4" });
    loaded.get("p4")!();
    await plain;
    assert.equal(f.current().songId, "p4", "without the option a projection always lands");
  } finally {
    f.restore();
  }
});

test("Direct: a projection that is no longer current dispatches nothing; a current one carries its condition to the host queue", async () => {
  const f = directFixture();
  await f.display.project({ songId: "stale" }, { isCurrent: () => false });
  assert.equal(f.dispatched.length, 0);
  const isCurrent = () => true;
  await f.display.project({ songId: "fresh" }, { isCurrent });
  assert.deepEqual(
    f.dispatched.map((update) => update.id),
    ["fresh"]
  );
  assert.equal(f.conditions[0], isCurrent, "the host re-checks it when the queued update runs");
});
