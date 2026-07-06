/**
 * deriveCapabilities — the SINGLE source of truth that turns a runtime role plus
 * a handful of context flags into a {@link ClientCapabilities} snapshot.
 *
 * Before this module the capability set was hand-declared in THREE independent
 * places (DirectClientApi, and the two branches of RestCore.computeCapabilities),
 * plus the NO_CAPABILITIES default — so the same flag (e.g. canPersistPlaylist)
 * was computed by four rules that silently diverged: a value changed in one place
 * had no effect in the others. Centralising the rules here makes that class of
 * bug structurally impossible: every adapter feeds its context in and reads the
 * same derivation out.
 *
 * The function is PURE (no `window`, no host bridge, no I/O) so it is trivially
 * unit-testable — all environment detection happens in the caller and arrives as
 * the boolean inputs below. See capabilities.test.ts.
 */

import type { ClientCapabilities } from "./ClientApi";

/**
 * The concrete runtime the adapter represents. Note this is FINER-GRAINED than
 * the public {@link ClientMode} ("App" | "Client"): the two App variants differ
 * in their cloud-identity affordances, which is exactly why a 2-value mode was
 * never enough to derive capabilities and they ended up hand-declared.
 *
 *  - `AppDirect`   — the Electron desktop embed (DirectClientApi). Always in
 *    control; login/identity belong to the surrounding host app; saves target the
 *    host's selected leader.
 *  - `AppRest`     — the standalone website / Android cloud app (RestClientApi,
 *    not host-served). Always in control; full cloud identity (login, leader
 *    choice, save) available.
 *  - `ClientServed`— a host-served LAN follower (RestClientApi with servedByHost).
 *    View-only unless the host grants leading AND the user switches leader mode on.
 *
 * Both App* roles map to ClientMode "App"; ClientServed maps to "Client".
 */
export type ClientRole = "AppDirect" | "AppRest" | "ClientServed";

/**
 * Everything that drives a capability decision, supplied by the adapter. Keeping
 * the full surface explicit here documents — in one place — precisely what a
 * capability can depend on. Inputs not relevant to a given role are simply not
 * read by that role's branch (callers may pass `false`).
 */
export interface CapabilityInputs {
  role: ClientRole;

  // ── environment (detected by the caller; passed in to keep this pure) ──
  /** A native host bridge (`window.hostDevice` / Android) is present. */
  hasHostBridge: boolean;
  /** The native host bridge can navigate to its launcher/home screen. */
  hasHostHome: boolean;
  /** A local webserver backend is reachable for iWeb-style browser clients. */
  hasWebServerBackend: boolean;
  /** Running as an installed PWA (standalone display-mode). */
  isPwa: boolean;
  /** This locked session is followed through the internet/cloud backend. */
  onlineSession: boolean;

  // ── App·Rest (standalone website / Android cloud app) ──
  /** Cloud auth state — gates online-session hosting in App·Rest. */
  authed: boolean;

  // ── App·Direct (Electron desktop embed) ──
  /** An auth bridge is wired (the surrounding app can log in) — Direct canLogin. */
  hasAuthBridge: boolean;
  /** A leader is selected, so a save has a target — Direct canPersistPlaylist. */
  hasSelectedLeader: boolean;
  /** Host app's "publish display to cloud" toggle — Direct canHostOnlineSession. */
  externalWebDisplayEnabled: boolean;

  // ── both App roles ──
  /** PPD session feature toggle — gates local-session hosting (needs a bridge). */
  ppdSessionEnabled: boolean;

  // ── Client (host-served follower) ──
  /** The host grants the right to lead (hostAccess ≠ GUEST, or the /display_query
   *  `leader-available` header) — surfaced so the UI can offer the leader switch. */
  leaderRight: boolean;
  /** The user's leader-mode choice (legacy chkAdmin); only a granted client that
   *  has ALSO switched this on actually controls the display. */
  leaderMode: boolean;
  /** This UI was opened as a concrete session viewer, so it must not expose the
   *  normal full-editor switch in the overflow menu. */
  lockedToSession: boolean;
}

/** Derive the capability snapshot for the given role + context. Pure. */
export function deriveCapabilities(input: CapabilityInputs): ClientCapabilities {
  const { hasHostBridge, hasHostHome, hasWebServerBackend, isPwa } = input;
  const env = {
    isPwa,
    hasHostBridge,
    hasHostHome,
    hasWebServerBackend,
    canReturnHome: input.lockedToSession && (input.onlineSession || hasHostHome),
  };

  if (input.role === "ClientServed") {
    // Host-served LAN follower: control is host-granted (leaderRight) and only
    // becomes effective once the user switches leader mode ON. No cloud login, no
    // session hosting, no named-playlist save. The full editor is served by the
    // same webserver but only makes sense on a real browser, not the native host.
    const controllable = input.leaderRight && input.leaderMode;
    return {
      ...env,
      leaderModeAvailable: input.leaderRight,
      canControlDisplay: controllable,
      canEditWorkingPlaylist: controllable,
      canLogin: false,
      canChangeLeader: false,
      canPersistPlaylist: false,
      canHostLocalSession: false,
      canHostOnlineSession: false,
      canOpenFullEditor: !input.lockedToSession && !hasHostBridge,
    };
  }

  // App roles: a full client — always in control, with no follower/leader toggle.
  // The desktop embed (AppDirect) and the web/cloud app (AppRest) differ only in
  // cloud-identity affordances. Full-editor navigation is runtime/session gated.
  const direct = input.role === "AppDirect";
  return {
    ...env,
    leaderModeAvailable: false,
    canControlDisplay: true,
    canEditWorkingPlaylist: true,
    // The desktop embed can log in only when the host wired an auth bridge; the
    // web/cloud app always offers login and leader choice.
    canLogin: direct ? input.hasAuthBridge : true,
    canChangeLeader: !direct,
    // The reported divergence lived here: the embed's save targets the host's
    // selected leader (so it's offered only while one is selected), whereas the
    // web/cloud app always allows saving to the authenticated profile.
    canPersistPlaylist: direct ? input.hasSelectedLeader : true,
    // Local PPD hosting needs a native transport in both App roles. Online hosting
    // is toggle-gated in the embed and auth-gated in the cloud app.
    canHostLocalSession: hasHostBridge && input.ppdSessionEnabled,
    canHostOnlineSession: direct ? input.externalWebDisplayEnabled : input.authed,
    canOpenFullEditor: !input.lockedToSession && !hasHostBridge,
  };
}
