import { icon, makeEmbeddedSvgTransparent } from "./assets";

export function StartupScanIndicator({ address }: { address?: string }) {
  return (
    <div className="cv-startup-scan" aria-live="polite" aria-label="Scanning sessions">
      <object type="image/svg+xml" data={icon("scan.svg")} aria-label="Scanning" onLoad={(e) => makeEmbeddedSvgTransparent(e.currentTarget)} />
      {address && <span>{address}</span>}
    </div>
  );
}
