import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocateFavoriteDate,
  favoriteLabel,
  favoriteNameFromLabel,
  hasFavoriteLabel,
  isFavoritePlaylist,
  isFavoriteScheduleDate,
  restoreFavoriteLabels,
  sameFavoriteName,
  validateFavoriteName,
} from "../favorite-playlists";

test("favorite dates are the positive timestamps before 1990", () => {
  assert.equal(isFavoriteScheduleDate(new Date(1980, 0, 1)), true);
  assert.equal(isFavoriteScheduleDate(new Date(1989, 11, 30)), true);
  assert.equal(isFavoriteScheduleDate(new Date(2026, 10, 14)), false);
  assert.equal(isFavoriteScheduleDate(0), false);
  assert.equal(isFavoriteScheduleDate(-1000), false);
  assert.equal(isFavoriteScheduleDate(new Date(Number.NaN)), false);
  assert.equal(isFavoriteScheduleDate(undefined), false);
});

test("a playlist without a date is a favorite only by its label", () => {
  assert.equal(isFavoritePlaylist({ scheduled: new Date(1980, 0, 2), label: "1980.01.02" }), true);
  assert.equal(isFavoritePlaylist({ scheduled: new Date(2026, 0, 2), label: "★ Easter" }), false);
  assert.equal(isFavoritePlaylist({ label: "★ Easter" }), true);
  assert.equal(isFavoritePlaylist({ label: "2026.01.02" }), false);
});

test("favorite labels carry the star prefix", () => {
  assert.equal(favoriteLabel("  Easter "), "★ Easter");
  assert.equal(favoriteNameFromLabel("★ Easter"), "Easter");
  assert.equal(favoriteNameFromLabel("★Easter"), "Easter");
  assert.equal(favoriteNameFromLabel("1980.01.03"), "");
  assert.equal(hasFavoriteLabel("★ Easter"), true);
  assert.equal(hasFavoriteLabel("Easter"), false);
});

test("legacy label sorting puts favorites after the dates", () => {
  const labels = ["★ Karácsony", "2026.11.14", "★ Alap", "2025.01.01"];
  const sorted = [...labels].sort((a, b) => -a.localeCompare(b));
  assert.deepEqual(sorted.slice(0, 2), ["2026.11.14", "2025.01.01"]);
});

test("favorite names are validated", () => {
  assert.equal(validateFavoriteName("  "), "empty");
  assert.equal(validateFavoriteName("a/b"), "slash");
  assert.equal(validateFavoriteName("x".repeat(81)), "tooLong");
  assert.equal(validateFavoriteName("Húsvét 2"), null);
  assert.equal(sameFavoriteName("Húsvét", " husvet "), true);
  assert.equal(sameFavoriteName("Húsvét", "Karácsony"), false);
});

test("favorite dates are allocated on a free local day from a random start", () => {
  const first = () => 0;
  assert.equal(allocateFavoriteDate([], first).getTime(), new Date(1980, 0, 1).getTime());
  const used = [new Date(1980, 0, 1), new Date(1980, 0, 2), new Date(2026, 0, 3), new Date(1980, 0, 4)];
  assert.equal(allocateFavoriteDate(used, first).getTime(), new Date(1980, 0, 3).getTime());

  // The last slot is taken: the search wraps around to the first free one.
  const last = () => 0.9999999;
  const lastSlot = allocateFavoriteDate([], last);
  assert.equal(allocateFavoriteDate([lastSlot, new Date(1980, 0, 1)], last).getTime(), new Date(1980, 0, 2).getTime());

  for (let i = 0; i < 50; i++) {
    const allocated = allocateFavoriteDate(used);
    assert.equal(allocated.getHours(), 0);
    assert.equal(isFavoriteScheduleDate(allocated), true);
    assert.equal(
      used.some((date) => date.getTime() === allocated.getTime()),
      false
    );
  }
});

test("names replaced by an older client are restored from the stored profile", () => {
  const stored = [
    { scheduled: new Date("1980-01-01T23:00:00.000Z"), label: "★ Easter" },
    { scheduled: new Date("1980-01-02T23:00:00.000Z"), label: "★ Christmas" },
    { scheduled: new Date("2026-11-13T23:00:00.000Z"), label: "2026.11.14" },
  ];
  const incoming = [
    // Re-sent in another time zone by an older client, with a date label.
    { scheduled: new Date("1980-01-03T00:00:00.000Z"), label: "1980.01.03" },
    // A rename made by a new client stays.
    { scheduled: new Date("1980-01-01T23:00:00.000Z"), label: "★ Pentecost" },
    { scheduled: new Date("2026-11-13T23:00:00.000Z"), label: "2026.11.14" },
    // No stored favorite on that day: left alone.
    { scheduled: new Date("1980-02-01T00:00:00.000Z"), label: "1980.02.01" },
  ];
  assert.equal(restoreFavoriteLabels(incoming, stored), 1);
  assert.equal(incoming[0].label, "★ Christmas");
  assert.equal(incoming[0].scheduled.toISOString(), "1980-01-02T23:00:00.000Z");
  assert.equal(incoming[1].label, "★ Pentecost");
  assert.equal(incoming[2].label, "2026.11.14");
  assert.equal(incoming[3].label, "1980.02.01");
});
