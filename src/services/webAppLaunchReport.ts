/**
 * Tells the native host that the frontend finished booting.
 *
 * On Android this is what promotes a downloaded bundle from trial to active, so the host has
 * to know which bundle is reporting. `window.ppWebAppLaunch` is injected per bundle launch
 * and therefore binds to exactly one document; `hostDevice.pageLoadedSuccessfully()` is
 * shared by every document and stays only as a fallback for hosts that predate the scoped
 * bridge. Elsewhere (Electron, plain browser) neither or only the latter exists.
 */
export function reportPageLoadedSuccessfully(): void {
  const scoped = window.ppWebAppLaunch;
  if (typeof scoped?.pageLoadedSuccessfully === "function") {
    scoped.pageLoadedSuccessfully();
    return;
  }
  window.hostDevice?.pageLoadedSuccessfully?.();
}
