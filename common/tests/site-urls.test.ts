import assert from "node:assert/strict";
import { test } from "node:test";
import { PRAISEPROJECTOR_WEBSITE_URL, publicWebRootFromBase } from "../site-urls";

test("retired .com aliases map to the canonical website", () => {
  for (const base of [
    "https://praiseprojector.com",
    "https://praiseprojector.com/",
    "https://praiseprojector.com/praiseprojector",
    "https://praiseprojector.com/praiseprojector/",
    "https://www.praiseprojector.com/praiseprojector",
    "https://PraiseProjector.com/praiseprojector",
    "http://praiseprojector.com",
  ]) {
    assert.equal(publicWebRootFromBase(base), PRAISEPROJECTOR_WEBSITE_URL, base);
  }
});

test("other hosts keep their own web root", () => {
  assert.equal(publicWebRootFromBase("https://praiseprojector.hu/praiseprojector"), "https://praiseprojector.hu");
  assert.equal(publicWebRootFromBase("http://localhost:8080/praiseprojector/"), "http://localhost:8080");
  assert.equal(publicWebRootFromBase("http://192.168.1.20:8080"), "http://192.168.1.20:8080");
  assert.equal(publicWebRootFromBase("https://praiseprojector.com.evil.test/praiseprojector"), "https://praiseprojector.com.evil.test");
});

test("relative or empty bases are only stripped", () => {
  assert.equal(publicWebRootFromBase("/praiseprojector"), "");
  assert.equal(publicWebRootFromBase(""), "");
});
