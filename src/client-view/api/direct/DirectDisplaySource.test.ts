import assert from "node:assert/strict";
import { test } from "node:test";
import type { Display } from "../../../../common/pp-types";
import { DirectDisplaySource } from "./DirectDisplaySource.ts";

const song = (songId: string, transpose: number): Display => ({ songId, song: songId, system: "G", from: 0, to: 0, transpose });

function fixture() {
  let hostDisplay = song("local", 0);
  const listeners = new Set<(display: Display) => void>();
  const source = new DirectDisplaySource(
    () => hostDisplay,
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  );
  const updateHost = (display: Display) => {
    hostDisplay = display;
    for (const listener of listeners) listener(display);
  };
  return { source, updateHost };
}

test("PPD page turns preserve each remote transpose through intermediate host updates", () => {
  const { source, updateHost } = fixture();
  const received: Display[] = [];
  source.subscribe((display) => received.push(display));
  const playlist = [
    { songId: "before", title: "Before", transpose: -2 },
    { songId: "hatalmas", title: "Hatalmas vagy", transpose: -5 },
    { songId: "after", title: "After", transpose: -2 },
  ];
  let previousTranspose = 0;
  for (const index of [1, 2, 1, 0, 1]) {
    const entry = playlist[index];
    const remote = { ...song(entry.songId, entry.transpose), playlist };
    source.follow(remote);
    // The host can publish the new song with the previous local preference
    // while processing the follow event, then settle to the remote preference.
    updateHost(song(entry.songId, previousTranspose));
    updateHost(remote);
    assert.equal(source.getCurrent(), remote);
    assert.equal(received.at(-1), remote);
    assert.deepEqual(source.getCurrent().playlist, playlist);
    previousTranspose = entry.transpose;
  }
  assert.deepEqual(
    received.map((display) => display.transpose),
    [-5, -2, -5, -2, -5]
  );
});

test("stopping follow restores local updates and unsubscribing removes both sources", () => {
  const { source, updateHost } = fixture();
  const received: Display[] = [];
  const unsubscribe = source.subscribe((display) => received.push(display));
  updateHost(song("local", -1));
  source.follow(song("remote", -5));
  updateHost(song("stale", -2));
  source.stopFollowing();
  updateHost(song("restored", 0));
  assert.equal(source.getCurrent().songId, "restored");
  assert.deepEqual(
    received.map((display) => display.songId),
    ["local", "remote", "restored"]
  );
  unsubscribe();
  source.follow(song("remote-again", -5));
  source.stopFollowing();
  updateHost(song("local-again", 0));
  assert.equal(received.length, 3);
});
