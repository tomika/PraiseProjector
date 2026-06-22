/**
 * AboutDialog — in-app About box for the client view.
 *
 * Mirrors the legacy praiseprojector.ts about box (app version + open-source
 * license references + a link to the project website) shown as a dismissible
 * modal, rather than navigating the user away to the website. Links are opened
 * through the host (device.openExternal) so native shells use the system browser.
 */

import { useClientViewStore } from "../controller/ClientViewContext";
import { getClientWebAppLicenseSections } from "../../../client/about-licenses";

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_SHOW_COMMIT__: boolean;

const WEBSITE_URL = "https://praiseprojector.com";

export function AboutDialog() {
  const store = useClientViewStore();

  const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
  const commit = typeof __APP_COMMIT__ !== "undefined" ? __APP_COMMIT__ : "";
  const showCommit = typeof __APP_SHOW_COMMIT__ !== "undefined" ? __APP_SHOW_COMMIT__ : false;
  const versionDisplay = showCommit && commit ? `${version} (${commit})` : version;
  const sections = getClientWebAppLicenseSections();

  const openUrl = (url: string) => store.openExternalUrl(url);

  return (
    <div className="cv-modal-backdrop" onClick={() => store.closeAbout()}>
      <div className="cv-dialog cv-about-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cv-dialog-head">
          <h2 className="cv-dialog-title">About</h2>
        </div>

        <div className="cv-about-body">
          <p className="cv-about-version">Client app version: {versionDisplay}</p>

          <p className="cv-about-section-title">Open source license references:</p>
          {sections.map((section) => (
            <div key={section.id} className="cv-about-section">
              <p className="cv-about-section-name">{section.title}:</p>
              <ul className="cv-about-list">
                {section.entries.map((entry) => (
                  <li key={entry.name}>
                    <button type="button" className="cv-about-link" onClick={() => openUrl(entry.url)}>
                      {entry.name}
                    </button>{" "}
                    (
                    <button type="button" className="cv-about-link" onClick={() => openUrl(entry.licenceUrl)}>
                      {entry.licence}
                    </button>
                    )
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <p className="cv-about-thanks">Thanks to everyone who shared their code and/or contributed to the project.</p>
          <p>
            For more information about usage and licensing visit{" "}
            <button type="button" className="cv-about-link" onClick={() => openUrl(WEBSITE_URL)}>
              PraiseProjector&apos;s website
            </button>
            .
          </p>
        </div>

        <div className="cv-dialog-actions">
          <button type="button" className="cv-dialog-ok" onClick={() => store.closeAbout()}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
