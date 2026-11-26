import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Database } from "../Database";
import { Leader } from "../Leader";
import { Playlist } from "../Playlist";
import { PlaylistEntry } from "../PlaylistEntry";
import type { LeaderDBProfile } from "../../common/pp-types";

const db = Database.getInstance();
db.autoSave = false;
beforeEach(() => db.clear());

const date = new Date(2026, 10, 15);
const favorite = new Date(1980, 0, 1);

function playlist(name: string, songId = "song-1") {
  const entry = new PlaylistEntry(songId);
  entry.title = "Song";
  return new Playlist(name, [entry]);
}

function profile(leaderId: string, playlists: LeaderDBProfile["playlists"], extra: Partial<LeaderDBProfile> = {}): LeaderDBProfile {
  return { leaderId, leaderName: "Leader", version: 10, preferences: [], playlists, ...extra };
}

/** Private Database members reached by the tests. */
const internals = db as unknown as {
  applyCloudPublicFlags(profiles: LeaderDBProfile[]): void;
  mergeProfilesWithConflicts(profiles: LeaderDBProfile[], mode: "keep-local" | "overwrite" | "select"): { updated: number };
};

test("the cloud's public flag survives the local copy, but is not content", () => {
  const leader = Leader.fromJSON(profile("l1", [{ label: "2026.11.15", scheduled: date, songs: [{ songId: "s", title: "S" }], public: true }]));
  assert.equal(leader.getPlaylist(date)?.isPublic, true);
  const stored = Leader.fromJSON(JSON.parse(JSON.stringify(leader.toStorageJSON())));
  assert.equal(stored.getPlaylist(date)?.isPublic, true);

  const privateCopy = Leader.fromJSON(profile("l1", [{ label: "2026.11.15", scheduled: date, songs: [{ songId: "s", title: "S" }] }]));
  assert.equal(privateCopy.getPlaylist(date)?.isPublic, false);
  assert.equal(privateCopy.equals(leader), true, "the flag alone is no change");
  assert.equal((privateCopy.toJSON().playlists[0] as { public?: boolean }).public, undefined, "a private list carries no flag");
});

test("a mirrored leader keeps its listing tags locally (visibility, group path)", () => {
  const groupPath = [
    { id: "g1", name: "Root" },
    { id: "g2", name: "Sub" },
  ];
  const leader = Leader.fromJSON(profile("l2", [], { visibility: "group", groupPath }));
  assert.equal(leader.visibility, "group");
  assert.deepEqual(leader.groupPath, groupPath);
  assert.deepEqual(leader.listingTags(), { visibility: "group", groupPath });

  const stored = Leader.fromJSON(JSON.parse(JSON.stringify(leader.toStorageJSON())));
  assert.equal(stored.visibility, "group");
  assert.deepEqual(stored.groupPath, groupPath);
  assert.deepEqual(leader.clone().groupPath, groupPath);

  // Never sent back to the cloud: the sync format carries no listing tags.
  const upload = leader.toJSON() as LeaderDBProfile;
  assert.equal(upload.visibility, undefined);
  assert.equal(upload.groupPath, undefined);
});

test("saving over a list keeps its public flag while the label stays", () => {
  const leader = new Leader("l3", "Leader");
  db.schedule(leader, date, playlist("x"));
  const stored = leader.getPlaylist(date);
  assert.ok(stored);
  stored.isPublic = true;

  db.schedule(leader, date, playlist("x", "song-2"));
  assert.equal(leader.getPlaylist(date)?.isPublic, true);
});

test("renaming a favorite makes the copy private: the shared link names the old label", () => {
  const leader = new Leader("l4", "Leader");
  db.schedule(leader, favorite, playlist("x"), "Easter");
  const stored = leader.getPlaylist(favorite);
  assert.ok(stored);
  stored.isPublic = true;
  db.renameFavorite(leader, favorite, "Pentecost");
  assert.equal(leader.getPlaylist(favorite)?.isPublic, false);
});

test("recording the cloud's flag never marks the leader modified", () => {
  const leader = new Leader("l5", "Leader");
  db.schedule(leader, date, playlist("x"));
  leader.version = 42;
  assert.equal(db.setPlaylistPublic(leader, date, true), true);
  assert.equal(leader.getPlaylist(date)?.isPublic, true);
  assert.equal(leader.version, 42);
  assert.equal(db.setPlaylistPublic(leader, new Date(2000, 0, 1), true), false);
});

test("a listing updates the own lists' public flags without touching the leader", () => {
  const leader = new Leader("l6", "Leader");
  db.schedule(leader, date, playlist("x"));
  db.schedule(leader, favorite, playlist("x"), "Easter");
  leader.version = 7;
  db.addLeader(leader);

  internals.applyCloudPublicFlags([
    profile("l6", [
      { label: "2026.11.15", scheduled: date, songs: [], public: true },
      { label: "★ Easter", scheduled: favorite, songs: [] },
    ]),
  ]);
  const own = db.getLeaderById("l6");
  assert.equal(own?.getPlaylist(date)?.isPublic, true);
  assert.equal(own?.getPlaylist(favorite)?.isPublic, false);
  assert.equal(own?.version, 7);

  // Partial (group / public) entries never stand for an own leader.
  internals.applyCloudPublicFlags([profile("l6", [], { visibility: "public" })]);
  assert.equal(db.getLeaderById("l6")?.getPlaylist(date)?.isPublic, true);
});

test("an incremental merge skips partial profiles instead of overwriting an own leader", () => {
  const leader = new Leader("l7", "Leader", 3);
  leader.updatePreference("song-1", { title: "", transpose: 2, capo: -1, type: "", instructions: "" }, db);
  db.schedule(leader, date, playlist("x"));
  leader.version = 3;
  db.addLeader(leader);

  const result = internals.mergeProfilesWithConflicts([profile("l7", [], { visibility: "public", version: 20 })], "overwrite");
  assert.equal(result.updated, 0);
  const own = db.getLeaderById("l7");
  assert.equal(own?.getSchedule().length, 1, "the own lists stay");
  assert.equal(own?.version, 3);
});

test("a profile taken from the cloud keeps the public flags of its lists", () => {
  const leader = db.createLeaderFromProfile(
    profile("l8", [
      { label: "2026.11.15", scheduled: date, songs: [{ songId: "s", title: "S" }], public: true },
      { label: "★ Easter", scheduled: favorite, songs: [{ songId: "s", title: "S" }] },
    ])
  );
  assert.equal(leader.getPlaylist(date)?.isPublic, true);
  assert.equal(leader.getPlaylist(favorite)?.isPublic, false);
});
