import React, { useEffect, useState } from "react";
import { useLocalization } from "../../localization/LocalizationContext";
import type { WebAppBundleEventDetail, WebAppBundleStatus } from "../../types/hostDevice";

type CheckPhase = "idle" | "checking" | "done";

function parseStatus(raw: string | undefined): WebAppBundleStatus | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WebAppBundleStatus;
    return typeof parsed?.runningReleaseId === "string" ? parsed : null;
  } catch {
    return null;
  }
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
  const supported = typeof window.hostDevice?.getWebAppBundleStatus === "function";

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;

    const refreshStatus = async () => {
      const bridge = window.hostDevice;
      if (!bridge?.getWebAppBundleStatus) return;
      try {
        // Called on the bridge object, never through a detached reference: Android rejects
        // an injected Java method invoked with a foreign receiver ("Java bridge method can't
        // be invoked on a non-injected object"), and that throw would leave the status
        // unknown for the whole session.
        const next = parseStatus(await Promise.resolve(bridge.getWebAppBundleStatus()));
        if (!cancelled) setStatus(next);
      } catch (error) {
        // The bridge really can disappear during a bundle switch and the next event
        // refreshes it — but swallowing this silently is what hid the receiver bug above,
        // so a failure has to leave a trace.
        console.warn("Cannot read the webapp bundle status", error);
      }
    };
    void refreshStatus();

    const onBundleEvent = (event: Event) => {
      const detail = (event as CustomEvent<WebAppBundleEventDetail>).detail;
      if (!detail) return;
      setPhase(detail.phase === "checking" ? "checking" : "done");
      if (detail.phase !== "checking") setOutcome(detail);
      const pushed = parseStatus(detail.status);
      if (pushed) setStatus(pushed);
      else void refreshStatus();
    };

    window.addEventListener("pp-webapp-bundle-event", onBundleEvent);
    return () => {
      cancelled = true;
      window.removeEventListener("pp-webapp-bundle-event", onBundleEvent);
    };
  }, [supported]);

  if (!supported) return null;

  const checkNow = () => {
    setPhase("checking");
    setOutcome(null);
    void Promise.resolve(window.hostDevice?.checkWebAppUpdateNow?.())?.catch(() => setPhase("done"));
  };

  const applyPending = () => {
    void Promise.resolve(window.hostDevice?.applyPendingWebAppUpdate?.())?.catch(() => undefined);
  };

  // An unreadable status must not be dressed up as a running downloaded release: the
  // optional-chained `runningIsFactory` of a null status is falsy, which used to render the
  // "downloaded update (?)" line on a device that was plainly running the factory bundle.
  const renderRunning = () => {
    if (!status) return <p className="text-muted mb-1">{t("WebAppBundleStatusUnknown")}</p>;
    const version = status.runningVersion ?? "?";
    const label = status.runningIsFactory
      ? t("WebAppBundleRunningFactory").replace("{version}", version)
      : t("WebAppBundleRunningDownloaded").replace("{version}", version);
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
    if (outcome.result === "UPDATED") {
      // UPDATED also covers retiring the stored release in favour of the bundle already
      // inside the APK, where nothing was fetched at all — claiming a download there is
      // simply false. A pending release is the only case that really downloaded something.
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
      {renderOutcome()}
      <p>
        {canApply ? (
          <button type="button" className="btn btn-primary btn-sm me-2" onClick={applyPending}>
            {t("WebAppBundleApply")}
          </button>
        ) : null}
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={checkNow} disabled={phase === "checking"}>
          {t("UpdateCheckNow")}
        </button>
      </p>
      <p className="text-muted small mb-0">{t("WebAppBundleExplanation")}</p>
    </div>
  );
};

export default WebAppBundleSettings;
