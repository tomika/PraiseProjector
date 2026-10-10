import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudApi } from "../../../common/cloudApi";
import { buildPlaylistShareUrl, buildSongShareUrl } from "../shareService";

test("share links from the retired .com origin point at the .hu website", () => {
  // Web builds use a page-relative API base, so on .com the base is the .com origin.
  cloudApi.setBaseUrl("https://praiseprojector.com/praiseprojector");
  assert.equal(buildSongShareUrl("review-song"), "https://praiseprojector.hu/public.html?s=review-song");
  assert.equal(buildPlaylistShareUrl("leader", "list"), "https://praiseprojector.hu/public.html?l=leader%2Flist");
});

test("share links from a local server keep the local host", () => {
  cloudApi.setBaseUrl("http://localhost:8080/praiseprojector");
  assert.equal(buildSongShareUrl("s1"), "http://localhost:8080/public.html?s=s1");
});
