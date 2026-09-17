import React, { useEffect, useState } from "react";
import { useLocalization } from "../../localization/LocalizationContext";
import type { WebAppBundleEventDetail, WebAppBundleStatus, WebAppUpdateActivity } from "../../types/hostDevice";

type CheckPhase = "idle" | "checking" | "downloading" | "done" | "timeout";

/**
 * The bridge call only acknowledges the request — every completion arrives as a native
 * event. A coalesced, crashed or silently dropped check emits none, and without a deadline
 * the section would sit on "checking…" with both buttons disabled for the rest of the
 * session.
 *
 * Each activity report pushes the deadline out, and current APKs heartbeat on elapsed time
 * as well as on percentage (`PROGRESS_HEARTBEAT_MS` in `WebAppBundleManager.kt`).
 */
const CHECK_TIMEOUT_MS = 60_000;

/**
 * A download gets a far more generous deadline than the check that precedes it. This bundle
 * updates independently of the store binary, so it also runs on APKs that report progress
 * only when the whole percentage changes — at a few KB/s a ~17 MB release stays inside one
 * percent for minutes, and calling that healthy transfer dead is much worse than noticing a
 * genuinely stalled one late, especially while the progress bar is still on screen.
 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function parseStatus(raw: string | null | undefined): WebAppBundleStatus | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WebAppBundleStatus;
    return typeof parsed?.runningReleaseId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The detail line is the technical cause, so the `Error:` prefix of `String(error)` is noise. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Android serves the frontend from a native-managed bundle that updates independently of
 * the store binary, so "the app is up to date" says nothing about the UI actually running.
 * This section makes that layer visible and lets the user drive it, alongside the desktop
 * app-update controls in the same about box.
 *
 * Renders nothing unless the native bridge exposes the bundle API — Electron and plain
 * browser runtimes have no such layer.
 */
const WebAppBundleSettings: React.FC = () => {
  const { t } = useLocalization();
  const [status, setStatus] = useState<WebAppBundleStatus | null>(null);
  const [phase, setPhase] = useState<CheckPhase>("idle");
  const [outcome, setOutcome] = useState<WebAppBundleEventDetail | null>(null);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // Bumped by every activity report so the watchdog below restarts while the native side
  // is demonstrably still working.
  const [activityTick, setActivityTick] = useState(0);
  const supported = typeof window.hostDevice?.getWebAppBundleStatus === "function";
  const busy = phase === "checking" || phase === "downloading";

  useEffect(() => {
    if (!busy) return undefined;
    // No `t` in here on purpose: the localized text is picked in `renderOutcome`, so a
    // non-memoized `t` cannot restart the timer on every render and keep it from firing.
    const deadline = phase === "downloading" ? DOWNLOAD_TIMEOUT_MS : CHECK_TIMEOUT_MS;
    const timer = window.setTimeout(() => setPhase("timeout"), deadline);
    return () => window.clearTimeout(timer);
  }, [busy, phase, activityTick]);

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;
    let hasSeenEvent = false;

    const showActivity = (activity: WebAppUpdateActivity | WebAppBundleEventDetail) => {
      if (activity.phase !== "checking" && activity.phase !== "downloading") return;
      setPhase(activity.phase);
      setOutcome(null);
      setActivityTick((tick) => tick + 1);
      setProgress(
        activity.totalBytes && activity.totalBytes > 0
          ? Math.max(0, Math.min(100, ((activity.downloadedBytes ?? 0) / activity.totalBytes) * 100))
          : undefined
      );
    };

    let statusRead = 0;
    const refreshStatus = async () => {
      const read = ++statusRead;
      const bridge = window.hostDevice;
      if (!bridge?.getWebAppBundleStatus) return;
      try {
        // Called on the bridge object, never through a detached reference: Android rejects
        // an injected Java method invoked with a foreign receiver ("Java bridge method can't
        // be invoked on a non-injected object"), and that throw would leave the status
        // unknown for the whole session.
        const next = parseStatus(await Promise.resolve(bridge.getWebAppBundleStatus()));
        if (!cancelled && read === statusRead) setStatus(next);
      } catch (error) {
        // The bridge really can disappear during a bundle switch and the next event
        // refreshes it — but swallowing this silently is what hid the receiver bug above,
        // so a failure has to leave a trace.
        console.warn("Cannot read the webapp bundle status", error);
      }
    };
    const readActivity = async () => {
      try {
        const raw = await window.hostDevice?.getWebAppUpdateActivity?.();
        if (raw && !cancelled && !hasSeenEvent) showActivity(JSON.parse(raw) as WebAppUpdateActivity);
      } catch (error) {
        console.warn("Cannot read the webapp update activity", error);
      }
    };

    const onBundleEvent = (event: Event) => {
      const detail = (event as CustomEvent<WebAppBundleEventDetail>).detail;
      if (!detail) return;
      hasSeenEvent = true;
      const stillWorking = detail.phase === "checking" || detail.phase === "downloading";
      if (stillWorking) showActivity(detail);
      else {
        setPhase("done");
        setOutcome(detail);
      }
      const pushed = parseStatus(detail.status);
      if (pushed) {
        statusRead++;
        setStatus(pushed);
      } else if (!stillWorking) void refreshStatus();
    };

    window.addEventListener("pp-webapp-bundle-event", onBundleEvent);
    void refreshStatus();
    void readActivity();
    return () => {
      cancelled = true;
      window.removeEventListener("pp-webapp-bundle-event", onBundleEvent);
    };
  }, [supported]);

  if (!supported) return null;

  const checkNow = async () => {
    setPhase("checking");
    setOutcome(null);
    setApplyError(null);
    try {
      const bridge = window.hostDevice;
      // Unreachable while the button is disabled without the bridge — the message is a
      // technical detail line under the localized heading, never a second copy of it.
      if (!bridge?.checkWebAppUpdateNow) throw new Error("hostDevice.checkWebAppUpdateNow is unavailable");
      // The void return only acknowledges the request. Completion comes from native events.
      await bridge.checkWebAppUpdateNow();
    } catch (error) {
      setPhase("done");
      setOutcome({ phase: "error", message: describeError(error) });
    }
  };

  const applyPending = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const bridge = window.hostDevice;
      if (!bridge?.applyPendingWebAppUpdate) throw new Error("hostDevice.applyPendingWebAppUpdate is unavailable");
      await bridge.applyPendingWebAppUpdate();
    } catch (error) {
      setApplyError(describeError(error));
    } finally {
      setApplying(false);
    }
  };

  // An unreadable status must not be dressed up as a running downloaded release: the
  // optional-chained `runningIsFactory` of a null status is falsy, which used to render the
  // "downloaded update (?)" line on a device that was plainly running the factory bundle.
  const renderRunning = () => {
    if (!status) return <p className="text-muted mb-1">{t("WebAppBundleStatusUnknown")}</p>;
    const version = status.runningVersion ?? "?";
    const versionDisplay = status.runningCommit ? `${version} (${status.runningCommit})` : version;
    const label = status.runningIsFactory
      ? t("WebAppBundleRunningFactory").replace("{version}", versionDisplay)
      : t("WebAppBundleRunningDownloaded").replace("{version}", versionDisplay);
    return (
      <p className="mb-1">
        {label}
        {status.runningIsTrial ? <span className="badge text-bg-info ms-2">{t("WebAppBundleTrial")}</span> : null}
      </p>
    );
  };

  // A switch is not always a downloaded release: when the server serves exactly what the
  // APK ships, the native side retires the stored copy and the next launch reverts to the
  // factory bundle with nothing pending. Both cases are applicable right now.
  const canApply = Boolean(status?.pendingReleaseId || status?.activationPending);

  const renderOutcome = () => {
    if (phase === "checking") return <p className="text-muted mb-1">{t("UpdateChecking")}</p>;
    if (phase === "downloading") {
      return (
        <>
          <p className="mb-1">
            {t("UpdateDownloading")} {progress !== undefined ? `${Math.round(progress)}%` : ""}
          </p>
          <progress className="about-update-progress-native mb-2" aria-label={t("UpdateDownloading")} max={100} value={progress} />
        </>
      );
    }
    if (phase === "timeout") {
      return (
        <>
          <p className="text-danger mb-1">{t("WebAppBundleCheckFailed")}</p>
          <p className="text-muted small mb-1">{t("WebAppBundleCheckTimedOut")}</p>
        </>
      );
    }
    if (phase !== "done" || !outcome) return null;

    if (outcome.phase === "error") {
      // The native check fails for unreachable servers, malformed manifests, integrity
      // mismatches and storage errors alike, so the detail line is what actually tells
      // them apart — surface it instead of guessing a cause.
      return (
        <>
          <p className="text-danger mb-1">{t("WebAppBundleCheckFailed")}</p>
          {outcome.message ? <p className="text-muted small mb-1">{outcome.message}</p> : null}
        </>
      );
    }
    if (outcome.result === "INCOMPATIBLE") {
      return <p className="text-warning mb-1">{t("WebAppBundleIncompatible")}</p>;
    }
    if (outcome.result === "UPDATED" || canApply) {
      // `canApply` is not redundant next to UPDATED: a check can come back CURRENT while an
      // earlier release is still waiting to be applied, and "up to date" would be wrong there.
      // Which of the two messages fits is a separate question — UPDATED also covers retiring
      // the stored release in favour of the bundle already inside the APK, where nothing was
      // fetched at all. A pending release is the only case that really downloaded something.
      return <p className="text-success mb-1">{status?.pendingReleaseId ? t("WebAppBundleDownloaded") : t("WebAppBundleReadyToApply")}</p>;
    }
    return <p className="text-success mb-1">{t("WebAppBundleUpToDate")}</p>;
  };

  return (
    <div className="mb-3">
      <hr />
      <h5>{t("WebAppBundleTitle")}</h5>
      {renderRunning()}
      {status?.pendingReleaseId ? (
        <p className="text-warning mb-1">{t("WebAppBundlePending").replace("{version}", status.pendingVersion ?? "?")}</p>
      ) : canApply ? (
        <p className="text-warning mb-1">{t("WebAppBundleFactoryPending").replace("{version}", status?.factoryVersion ?? "?")}</p>
      ) : null}
      {status?.retryBlockedReleaseId ? <p className="text-muted small mb-1">{t("WebAppBundleRetryDeferred")}</p> : null}
      <div role="status">{renderOutcome()}</div>
      {applyError ? (
        <div role="alert" className="text-danger mb-1">
          {t("WebAppBundleApplyFailed")}
          <p className="small mb-1">{applyError}</p>
        </div>
      ) : null}
      <p>
        {canApply ? (
          <button
            type="button"
            className="btn btn-primary btn-sm me-2"
            onClick={applyPending}
            disabled={busy || applying || typeof window.hostDevice?.applyPendingWebAppUpdate !== "function"}
          >
            {t("WebAppBundleApply")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={checkNow}
          disabled={busy || applying || typeof window.hostDevice?.checkWebAppUpdateNow !== "function"}
        >
          {t("UpdateCheckNow")}
        </button>
      </p>
      <p className="text-muted small mb-0">{t("WebAppBundleExplanation")}</p>
    </div>
  );
};

export default WebAppBundleSettings;
