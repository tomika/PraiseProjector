import { HostDevice } from "./host-device";
import { praiseProjectorOrigin } from "./praiseprojector";
import { getClientWebAppLicenseSections } from "./about-licenses";

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_SHOW_COMMIT__: boolean;

export function getAboutBoxHtml(info?: { login?: string }) {
  const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
  const commit = typeof __APP_COMMIT__ !== "undefined" ? __APP_COMMIT__ : "";
  const showCommit = typeof __APP_SHOW_COMMIT__ !== "undefined" ? __APP_SHOW_COMMIT__ : false;
  const versionDisplay = showCommit && commit ? `${version} (${commit})` : version;
  const licenseSections = [...getClientWebAppLicenseSections(), ...(HostDevice.hostDevice?.getThirdPartyLicenseSections() || [])];

  const sectionHtml = licenseSections
    .map(
      (section) =>
        `<tr><td>&nbsp;</td></tr>
    <tr><td><strong>${section.title}:</strong></td></tr>
    ${section.entries
      .map(
        (entry) =>
          `<tr>
      <td><a href="${entry.url}" target="_blank">${entry.name}</a> (<a href="${entry.licenceUrl}" target="_blank">${entry.licence}</a>)</td>
    </tr>`
      )
      .join("\n")}`
    )
    .join("\n");

  return `<table style="font-size: 1.2rem;">
    ${
      info?.login
        ? `<tr>
      <td>Currently logged in user: ${info.login}</td>
      </tr>`
        : ""
    }
    <tr>
        <td>&nbsp;</td>
    </tr>
    <tr>
      <td>Client app version: ${versionDisplay}</td>
    </tr>
    <tr>
      <td>&nbsp;</td>
    </tr>
    <tr>
        <td><strong>Open source license references:</strong></td>
    </tr>
    ${sectionHtml}
    <tr>
        <td>&nbsp;</td>
    </tr>
    <tr>
        <td><strong>Thanks for everyone who shared their code and/or contributed in project.</strong></td>
    </tr>
    <tr>
        <td>For more information about usage and licensing visit <a href="#" onclick="window.open('${praiseProjectorOrigin}')">PraiseProjector's website</a></td>
    </tr>
    ${(() => {
      const info = HostDevice.hostDevice?.info();
      const lines: string[] = [];
      let hasMem = false;
      if (info) {
        const fmtGb = (num: number) => {
          const gb = 1024 * 1024 * 1024;
          return (num / gb).toFixed(1).replace(/\.0+$/, "");
        };
        if (info.totalMemory && info.freeMemory) {
          lines.push(`<tr class="deviceinfo"><td>Free memory: ${fmtGb(info.freeMemory)}/${fmtGb(info.totalMemory)}G</td></tr>`);
          hasMem = true;
        }
        for (const key of Object.keys(info)) {
          const value = (info as Record<string, unknown>)[key];
          if (typeof value === "string")
            lines.push(`<tr class="deviceinfo"><td>${key.substring(0, 1).toUpperCase() + key.substring(1)}: ${value}</td></tr>`);
        }
      }
      const deviceMemory = (navigator as unknown as Record<string, number>)["deviceMemory"];
      if (!hasMem && deviceMemory) lines.push(`<tr class="deviceinfo"><td>Device memory: ${deviceMemory} GB</td></tr>`);
      return lines.length > 0
        ? `<tr><td>&nbsp;</td></tr>
        <tr class="deviceinfo"><td><strong>Device information:</strong></td></tr>
        ${lines.join("\n")}`
        : "";
    })()}
  </table>`;
}
