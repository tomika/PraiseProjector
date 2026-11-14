import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Database } from "../Database";
import { Leader } from "../Leader";
import { Playlist } from "../Playlist";
import { PlaylistEntry } from "../PlaylistEntry";

const db = Database.getInstance();
db.autoSave = false;
beforeEach(() => db.clear());

const favoriteDate = new Date(1980, 0, 1);
const datedDate = new Date(2026, 10, 15);

function playlist(name = "CurrentPlaylist") {
  const entry = new PlaylistEntry("song-1");
  entry.title = "Song";
  return new Playlist(name, [entry]);
}

test("saving a favorite stores the starred name; re-saving keeps it", () => {
  const leader = new Leader("leader-1", "Leader");
  db.schedule(leader, favoriteDate, playlist(), "Easter");
  db.schedule(leader, datedDate, playlist());
  assert.equal(leader.getPlaylist(favoriteDate)?.name, "★ Easter");
  assert.equal(leader.getPlaylist(datedDate)?.name, "2026.11.15");

  // An update without a name (e.g. the "update before sync" prompt) keeps it.
  db.schedule(leader, favoriteDate, playlist("CurrentPlaylist"));
  assert.equal(leader.getPlaylist(favoriteDate)?.name, "★ Easter");
});

test("a favorite survives the sync format and is compared by name", () => {
  const leader = new Leader("leader-1", "Leader", 5);
  db.schedule(leader, favoriteDate, playlist(), "Easter");
  const json = JSON.parse(JSON.stringify(leader.toJSON()));
  const restored = Leader.fromJSON(json);
  assert.equal(restored.getPlaylist(favoriteDate)?.name, "★ Easter");
  assert.equal(restored.equals(leader), true);

  db.renameFavorite(restored, favoriteDate, "Pentecost");
  assert.equal(restored.getPlaylist(favoriteDate)?.name, "★ Pentecost");
  assert.equal(restored.version, 0);
  assert.equal(restored.equals(leader), false, "a rename alone is a change");
});

test("deleting a playlist removes it and marks the profile modified", () => {
  const leader = new Leader("leader-1", "Leader");
  db.schedule(leader, favoriteDate, playlist(), "Easter");
  db.schedule(leader, datedDate, playlist());
  leader.version = 7;

  assert.equal(db.removeScheduledPlaylist(leader, new Date(datedDate.getTime())), true);
  assert.equal(leader.getPlaylist(datedDate), null);
  assert.equal(leader.version, 0);
  assert.deepEqual(
    leader.getSchedule().map((date) => date.getTime()),
    [favoriteDate.getTime()]
  );
  assert.equal(db.removeScheduledPlaylist(leader, datedDate), false);
});
