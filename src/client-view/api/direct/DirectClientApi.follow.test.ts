import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Display, OnlineSessionEntry } from "../../../../common/pp-types";
import type { PlaylistApi, SessionApi } from "../ClientApi";
import { DirectDisplaySource } from "./DirectDisplaySource.ts";

// Exercise the real adapter methods with isolated transport/host dependencies.
// Only the adapter is transpiled: its desktop imports cannot run directly in
// Node. DirectDisplaySource itself is imported by the strip-only runner above.
const adapterCode = ts.transpileModule(readFileSync(new URL("./DirectClientApi.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const song = (songId: string, transpose: number): Display => ({ songId, song: songId, system: "G", from: 0, to: 0, transpose });

function fixture() {
  let hostDisplay = song("local", 0);
  const hostListeners = new Set<(display: Display) => void>();
  const source = new DirectDisplaySource(
    () => hostDisplay,
    (listener) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    }
  );
  const updateHost = (display: Display) => {
    hostDisplay = display;
    for (const listener of hostListeners) listener(display);
  };
  const queries: { seed: Display; leaderId?: string }[] = [];
  const scheduled: { items: NonNullable<Display["playlist"]> }[] = [];
  const modules: Record<string, unknown> = {
    "../../../state/CurrentSongStore": { getCurrentDisplay: () => hostDisplay },
    "../../../services/hostDevicePpd": {
      isHostDevicePpdAvailable: () => true,
      stopHostDeviceWatching: () => undefined,
      startHostDeviceWatching: async () => false,
    },
    "../../../../common/cloudApi": {
      cloudApi: {
        fetchDisplayQuery: (seed: Display, options: { leaderId?: string; signal: AbortSignal }) => {
          queries.push({ seed, leaderId: options.leaderId });
          return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        },
      },
    },
    "../../../../db-common/Database": {
      Database: {
        getInstance: () => ({ schedule: (_leader: unknown, _date: Date, playlist: (typeof scheduled)[number]) => scheduled.push(playlist) }),
      },
    },
    "../../../../db-common/PlaylistEntry": { PlaylistEntry: { fromJSON: (entry: unknown) => entry } },
    "../../../../db-common/Playlist": {
      Playlist: class {
        readonly items: NonNullable<Display["playlist"]>;
        constructor(_label: string, items: NonNullable<Display["playlist"]>) {
          this.items = items;
        }
      },
    },
    "../../../../common/date-only": { formatLocalDateLabel: () => "2026.09.12" },
  };
  const exports: { DirectClientApi?: { prototype: object } } = {};
  runInNewContext(adapterCode, { exports, require: (id: string) => modules[id] ?? {}, AbortController });
  // Skip unrelated database/auth/UI startup, retaining all production follow
  // methods (including stopFollow, watch, startCloudFollow and startPpdFollow).
  const adapter = Object.assign(Object.create(exports.DirectClientApi!.prototype), {
    displaySource: source,
    followToken: 0,
    followAbort: null,
    ppdWatching: true,
    ppdAccess: null,
    ppdSongCache: new Map(),
    localSessions: new Map(),
    networkListeners: new Set(),
    lastFollow: { kind: "cloud", leaderId: "old-session" },
    refreshHostState: () => undefined,
    getSelectedLeader: () => ({ getSchedule: () => [] }),
    releaseFollowedSession: () => assert.fail("Session switch/reconnect must not require releaseFollowedSession"),
  }) as {
    stopFollow(): void;
    createSessionApi(): SessionApi;
    createPlaylistApi(): PlaylistApi;
    localSessions: Map<string, { id: string; address: string; port: number }>;
    networkState: { status: string };
  };
  const session = adapter.createSessionApi();
  return { adapter, session, source, updateHost, queries, scheduled };
}

test("switching cloud sessions clears the old snapshot before seeding the next query", async () => {
  const { adapter, session, source, updateHost, queries } = fixture();
  source.follow(song("old-remote", -5));
  const local = song("local-current", -2);
  updateHost(local);
  try {
    await session.watch({ id: "new-session", name: "New session" } as OnlineSessionEntry);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].leaderId, "new-session");
    assert.equal(queries[0].seed, local);
    assert.equal(source.getCurrent(), local);
  } finally {
    adapter.stopFollow();
  }
});

test("reconnect clears the followed snapshot without releasing the session", async () => {
  const { adapter, session, source, updateHost, queries } = fixture();
  source.follow(song("old-remote", -5));
  const local = song("local-current", -2);
  updateHost(local);
  try {
    await session.reconnect();
    assert.equal(queries.length, 1);
    assert.equal(queries[0].leaderId, "old-session");
    assert.equal(queries[0].seed, local);
    assert.equal(source.getCurrent(), local);
  } finally {
    adapter.stopFollow();
  }
});

test("a failed PPD session switch leaves local display notifications visible", async () => {
  const { adapter, session, source, updateHost } = fixture();
  source.follow(song("old-remote", -5));
  adapter.localSessions.set("new-ppd", { id: "new-ppd", address: "192.0.2.1", port: 1974 });
  const received: Display[] = [];
  source.subscribe((display) => received.push(display));
  await session.watch({ id: "new-ppd", name: "Unavailable PPD" } as OnlineSessionEntry);
  assert.equal(adapter.networkState.status, "offline");
  const local = song("local-after-failure", -2);
  updateHost(local);
  assert.equal(source.getCurrent(), local);
  assert.deepEqual(received, [local]);
});

test("upload saves the same followed playlist returned by getPlaylist", async () => {
  const { adapter, source, updateHost, scheduled } = fixture();
  updateHost({ ...song("local", 0), playlist: [{ songId: "local", title: "Local" }] });
  const playlist = [{ songId: "remote", title: "Remote", transpose: -5 }];
  source.follow({ ...song("remote", -5), playlist });
  const api = adapter.createPlaylistApi();
  assert.equal(api.getPlaylist(), playlist);
  assert.equal(await api.upload({ scheduled: new Date(2026, 8, 12) }), "OK");
  assert.deepEqual(scheduled[0].items, playlist);
});
