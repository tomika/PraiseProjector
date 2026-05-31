const DEFAULT_SUPPRESSION_MS = 10_000;

let suppressUntil = 0;

export function suppressCloudNetworkToast(ms: number = DEFAULT_SUPPRESSION_MS): void {
  const next = Date.now() + Math.max(0, ms);
  suppressUntil = Math.max(suppressUntil, next);
}

export function shouldSuppressCloudNetworkToast(now: number = Date.now()): boolean {
  return now < suppressUntil;
}
