import { useEffect, useRef, useState } from "react";
import type { WebAppBundleEventDetail, WebAppUpdateActivity } from "../types/hostDevice";
import "./WebAppUpdateActivityBar.css";

type VisibleActivity =
  | { phase: "checking" }
  | {
      phase: "downloading";
      progress: number;
    };

const COMPLETION_DISPLAY_MS = 500;

function parseActivity(raw: string): WebAppUpdateActivity | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WebAppUpdateActivity>;
    if (parsed.phase !== "idle" && parsed.phase !== "checking" && parsed.phase !== "downloading") return null;
    return {
      phase: parsed.phase,
      downloadedBytes: typeof parsed.downloadedBytes === "number" ? parsed.downloadedBytes : 0,
      totalBytes: typeof parsed.totalBytes === "number" ? parsed.totalBytes : 0,
    };
  } catch {
    return null;
  }
}

function visibleActivity(activity: WebAppUpdateActivity): VisibleActivity | null {
  if (activity.phase === "checking") return { phase: "checking" };
  if (activity.phase !== "downloading") return null;
  const progress = activity.totalBytes > 0 ? activity.downloadedBytes / activity.totalBytes : 0;
  return { phase: "downloading", progress: Math.max(0, Math.min(1, progress)) };
}

/** Thin Android-only activity indicator for the native-managed webapp bundle updater. */
export const WebAppUpdateActivityBar = () => {
  const [activity, setActivity] = useState<VisibleActivity | null>(null);
  const activityRef = useRef<VisibleActivity | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supported = typeof window.hostDevice?.getWebAppUpdateActivity === "function";

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;
    let hasSeenEvent = false;

    const clearCompletionTimer = () => {
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    };
    const publish = (next: VisibleActivity | null) => {
      activityRef.current = next;
      setActivity(next);
    };
    const hide = () => {
      clearCompletionTimer();
      publish(null);
    };
    const showCompletedDownload = () => {
      clearCompletionTimer();
      publish({ phase: "downloading", progress: 1 });
      completionTimerRef.current = setTimeout(() => {
        completionTimerRef.current = null;
        publish(null);
      }, COMPLETION_DISPLAY_MS);
    };

    const bridge = window.hostDevice;
    if (bridge?.getWebAppUpdateActivity) {
      void Promise.resolve(bridge.getWebAppUpdateActivity())
        .then((raw) => {
          if (cancelled || hasSeenEvent) return;
          const snapshot = parseActivity(raw);
          if (snapshot) publish(visibleActivity(snapshot));
        })
        .catch(() => undefined);
    }

    const onBundleEvent = (event: Event) => {
      const detail = (event as CustomEvent<WebAppBundleEventDetail>).detail;
      if (!detail) return;
      hasSeenEvent = true;
      clearCompletionTimer();
      if (detail.phase === "checking") {
        publish({ phase: "checking" });
        return;
      }
      if (detail.phase === "downloading") {
        publish(
          visibleActivity({
            phase: "downloading",
            downloadedBytes: detail.downloadedBytes ?? 0,
            totalBytes: detail.totalBytes ?? 0,
          })
        );
        return;
      }
      if (detail.phase === "result" && activityRef.current?.phase === "downloading") {
        showCompletedDownload();
        return;
      }
      hide();
    };

    window.addEventListener("pp-webapp-bundle-event", onBundleEvent);
    return () => {
      cancelled = true;
      clearCompletionTimer();
      window.removeEventListener("pp-webapp-bundle-event", onBundleEvent);
    };
  }, [supported]);

  if (!activity) return null;

  return (
    <div className="webapp-update-activity" aria-hidden="true">
      <div
        className={`webapp-update-activity-bar webapp-update-activity-bar-${activity.phase}`}
        style={activity.phase === "downloading" ? { width: `${activity.progress * 100}%` } : undefined}
      />
    </div>
  );
};
