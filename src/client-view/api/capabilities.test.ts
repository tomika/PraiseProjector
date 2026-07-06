/**
 * Unit tests for {@link deriveCapabilities} — the single capability derivation.
 *
 * No test framework is configured in this repo, so these run on Node's built-in
 * runner with native TypeScript type-stripping (zero new dependencies):
 *
 *   cd public
 *   node --experimental-strip-types --test src/client-view/api/capabilities.test.ts
 *
 * The file is also type-checked + linted by the normal gate (it lives under
 * src/client-view, which tsc and eslint already cover).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCapabilities, type CapabilityInputs, type ClientRole } from "./capabilities.ts";

/** Build a fully-false input set for `role`, overriding only what a test cares about. */
function inputs(role: ClientRole, over: Partial<CapabilityInputs> = {}): CapabilityInputs {
  return {
    role,
    hasHostBridge: false,
    hasHostHome: false,
    hasWebServerBackend: false,
    isPwa: false,
    onlineSession: false,
    authed: false,
    hasAuthBridge: false,
    hasSelectedLeader: false,
    externalWebDisplayEnabled: false,
    ppdSessionEnabled: false,
    leaderRight: false,
    leaderMode: false,
    lockedToSession: false,
    ...over,
  };
}

// ── environment passthrough (every role) ─────────────────────────────────────

test("environment flags are echoed verbatim for every role", () => {
  for (const role of ["AppDirect", "AppRest", "ClientServed"] as const) {
    const caps = deriveCapabilities(inputs(role, { isPwa: true, hasHostBridge: true, hasHostHome: true, hasWebServerBackend: true }));
    assert.equal(caps.isPwa, true, `${role} isPwa`);
    assert.equal(caps.hasHostBridge, true, `${role} hasHostBridge`);
    assert.equal(caps.hasHostHome, true, `${role} hasHostHome`);
    assert.equal(caps.hasWebServerBackend, true, `${role} hasWebServerBackend`);
  }
});

// ── the reported bug: canPersistPlaylist diverges by role ────────────────────

test("canPersistPlaylist: AppRest always true, ClientServed always false", () => {
  // No flag toggles this in these roles — exactly why editing one branch couldn't
  // make the web client hide the Save button.
  for (const over of [{}, { hasSelectedLeader: true }, { authed: true }, { leaderMode: true, leaderRight: true }]) {
    assert.equal(deriveCapabilities(inputs("AppRest", over)).canPersistPlaylist, true);
    assert.equal(deriveCapabilities(inputs("ClientServed", over)).canPersistPlaylist, false);
  }
});

test("canPersistPlaylist: AppDirect follows hasSelectedLeader", () => {
  // This is why the desktop embed hid the Save button — no leader selected.
  assert.equal(deriveCapabilities(inputs("AppDirect")).canPersistPlaylist, false);
  assert.equal(deriveCapabilities(inputs("AppDirect", { hasSelectedLeader: true })).canPersistPlaylist, true);
});

// ── ClientServed: control gated on leaderRight AND leaderMode ─────────────────

test("ClientServed: control requires both the granted right and leader mode on", () => {
  const matrix: Array<[boolean, boolean, boolean]> = [
    // leaderRight, leaderMode, expected controllable
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ];
  for (const [leaderRight, leaderMode, expected] of matrix) {
    const caps = deriveCapabilities(inputs("ClientServed", { leaderRight, leaderMode }));
    assert.equal(caps.leaderModeAvailable, leaderRight, `leaderModeAvailable@(${leaderRight},${leaderMode})`);
    assert.equal(caps.canControlDisplay, expected, `canControlDisplay@(${leaderRight},${leaderMode})`);
    assert.equal(caps.canEditWorkingPlaylist, expected, `canEditWorkingPlaylist@(${leaderRight},${leaderMode})`);
  }
});

test("ClientServed: no login / change-leader / hosting / full editor", () => {
  const caps = deriveCapabilities(inputs("ClientServed", { leaderRight: true, leaderMode: true }));
  assert.equal(caps.canLogin, false);
  assert.equal(caps.canChangeLeader, false);
  assert.equal(caps.canHostLocalSession, false);
  assert.equal(caps.canHostOnlineSession, false);
  assert.equal(deriveCapabilities(inputs("ClientServed", { hasHostBridge: false })).canOpenFullEditor, false);
  assert.equal(deriveCapabilities(inputs("ClientServed", { hasHostBridge: true })).canOpenFullEditor, false);
  assert.equal(deriveCapabilities(inputs("ClientServed", { lockedToSession: true, hasHostBridge: false })).canOpenFullEditor, false);
});

test("ClientServed: locked-session home only for online sessions or host goHome", () => {
  assert.equal(deriveCapabilities(inputs("ClientServed", { lockedToSession: true })).canReturnHome, false);
  assert.equal(deriveCapabilities(inputs("ClientServed", { lockedToSession: true, onlineSession: true })).canReturnHome, true);
  assert.equal(deriveCapabilities(inputs("ClientServed", { lockedToSession: true, hasHostHome: true })).canReturnHome, true);
  assert.equal(deriveCapabilities(inputs("ClientServed", { lockedToSession: false, onlineSession: true, hasHostHome: true })).canReturnHome, false);
});

// ── App roles: always in control, no leader toggle ───────────────────────────

test("both App roles are always in control with no leader-mode toggle", () => {
  for (const role of ["AppDirect", "AppRest"] as const) {
    const caps = deriveCapabilities(inputs(role));
    assert.equal(caps.leaderModeAvailable, false, `${role} leaderModeAvailable`);
    assert.equal(caps.canControlDisplay, true, `${role} canControlDisplay`);
    assert.equal(caps.canEditWorkingPlaylist, true, `${role} canEditWorkingPlaylist`);
  }
});

// ── AppRest specifics ────────────────────────────────────────────────────────

test("AppRest: login + change-leader always on; online hosting follows authed", () => {
  assert.equal(deriveCapabilities(inputs("AppRest")).canLogin, true);
  assert.equal(deriveCapabilities(inputs("AppRest")).canChangeLeader, true);
  assert.equal(deriveCapabilities(inputs("AppRest", { authed: false })).canHostOnlineSession, false);
  assert.equal(deriveCapabilities(inputs("AppRest", { authed: true })).canHostOnlineSession, true);
});

test("AppRest: local hosting needs a host bridge AND the ppd toggle; full editor only outside locked native session", () => {
  assert.equal(deriveCapabilities(inputs("AppRest", { hasHostBridge: true, ppdSessionEnabled: true })).canHostLocalSession, true);
  assert.equal(deriveCapabilities(inputs("AppRest", { hasHostBridge: false, ppdSessionEnabled: true })).canHostLocalSession, false);
  assert.equal(deriveCapabilities(inputs("AppRest", { hasHostBridge: true, ppdSessionEnabled: false })).canHostLocalSession, false);
  assert.equal(deriveCapabilities(inputs("AppRest", { hasHostBridge: false })).canOpenFullEditor, true);
  assert.equal(deriveCapabilities(inputs("AppRest", { hasHostBridge: true })).canOpenFullEditor, false);
  assert.equal(deriveCapabilities(inputs("AppRest", { lockedToSession: true, hasHostBridge: false })).canOpenFullEditor, false);
});

// ── AppDirect specifics ──────────────────────────────────────────────────────

test("AppDirect: login follows the auth bridge; no change-leader; full editor only outside locked native session", () => {
  assert.equal(deriveCapabilities(inputs("AppDirect", { hasAuthBridge: false })).canLogin, false);
  assert.equal(deriveCapabilities(inputs("AppDirect", { hasAuthBridge: true })).canLogin, true);
  assert.equal(deriveCapabilities(inputs("AppDirect")).canChangeLeader, false);
  assert.equal(deriveCapabilities(inputs("AppDirect", { hasHostBridge: false })).canOpenFullEditor, true);
  assert.equal(deriveCapabilities(inputs("AppDirect", { hasHostBridge: true })).canOpenFullEditor, false);
  assert.equal(deriveCapabilities(inputs("AppDirect", { lockedToSession: true, hasHostBridge: false })).canOpenFullEditor, false);
});

test("AppDirect: online hosting follows the external-web-display toggle (not authed)", () => {
  assert.equal(deriveCapabilities(inputs("AppDirect", { externalWebDisplayEnabled: true, authed: false })).canHostOnlineSession, true);
  assert.equal(deriveCapabilities(inputs("AppDirect", { externalWebDisplayEnabled: false, authed: true })).canHostOnlineSession, false);
});
