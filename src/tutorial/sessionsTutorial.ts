import { tutorialStep as s, tutorialText as tx } from "./tutorialDefinitionHelpers";
import type { HelpIcon, TutorialStep } from "./tutorialTypes";

const cloud = "[data-tutorial-id='cloud-session']";
const lan = "[data-tutorial-id='iweb-session']";
const nearby = "[data-tutorial-id='ppd-session']";
const qrIcons = [`${cloud} .session-toggle-image-wrap`, `${lan} .session-toggle-image-wrap`];

export function sessionsTutorial(target: string, entryIcon: HelpIcon, prepare: TutorialStep["prepare"]): TutorialStep {
  return s(
    "sessions",
    target,
    tx(
      "Munkamenetek megosztása és követése",
      "A Munkamenetek ablak felső listájából más eszközök vetítéséhez csatlakozhatsz. A saját vetítésedet az alsó kapcsolókkal oszthatod meg. A sorrend Felhő, LAN (Hoszt mód), Nearby (Közeli mód).",
      "Share and follow sessions",
      "Use the list at the top of the Sessions window to join a projection from another device. Use the switches at the bottom to share your own projection. The switch order is Cloud, LAN (Host mode), then Nearby mode."
    ),
    {
      helpIcons: [entryIcon, "images/cloud-session.svg", "images/iweb-session.svg", "images/ppd-session.svg"],
      prepare,
      detailSurface: "sessions",
      details: [
        s(
          "sessions-follow",
          "[data-tutorial-id='sessions-results']",
          tx(
            "Csatlakozás és visszatérés",
            "Az ablak megnyitásakor a keresés automatikusan elindul. Ugyanaz a vetítés több sorban is megjelenhet, ha többféle kapcsolaton elérhető. Kattints vagy koppints a kívánt sorra vagy a dugó ikonra. Ha követés közben megnyitod a Munkamenetek ablakot, a kapcsolat megszakad, és visszakapod a saját műsortáradat. A megosztott kliensnézetből a házikóval térhetsz vissza, ha látható.",
            "Join a session and return",
            "Discovery starts automatically when you open Sessions. The same projection can appear on multiple rows if it is available through several connection types. Click or tap the row or its plug icon to connect. Opening Sessions while following ends the connection and restores your own playlist. In a shared client view, use the Home button to return when it is available."
          ),
          { helpIcons: ["images/radar.svg", { label: "🔌" }, "images/home.svg"] }
        ),
        s(
          "sessions-broadcast-address",
          "[data-tutorial-id='sessions-broadcast-address']",
          tx(
            "Broadcast cím",
            "A Broadcast cím a helyi munkamenetek keresésének elsődleges IPv4 broadcast címe. Ha több hálózati csatolód van, a mező melletti nyíllal válaszd ki annak a helyi hálózatnak a címét, amelyen a vetítést keresed. A címet kézzel is beírhatod. Az Alapértelmezett gomb visszaállítja az automatikusan kiválasztott címet.",
            "Broadcast address",
            "The Broadcast address is the primary IPv4 broadcast address used to discover local sessions. If you have several network adapters, use the arrow beside the field to select the address for the local network where you expect to find the projection. You can also type the address. Use Default to restore the automatically selected address."
          ),
          { helpIcons: [{ label: "▾" }] }
        ),
        s(
          "sessions-cloud",
          cloud,
          tx(
            "Felhő (internet)",
            "A Felhő módot akkor válaszd, ha a vetítő és minden követő eszköz eléri az internetet. Ez különösen akkor hasznos, ha külön hálózaton vagy más helyszínen vagytok. A vetítő eszközön kapcsold be a Felhő módot. A követők a WWW ikonnal jelölt sorból vagy a megosztott linkkel csatlakozhatnak.",
            "Cloud (internet)",
            "Use Cloud when the projecting device and all following devices have internet access. It is especially useful across different networks or locations. Enable Cloud on the projecting device. Followers can join from the row with the WWW icon or use the shared link."
          ),
          { helpIcons: ["images/cloud-session.svg", "images/www.svg"] }
        ),
        s(
          "sessions-lan",
          lan,
          tx(
            "LAN (Hoszt mód)",
            "A Hoszt mód csak akkor működik, ha az eszközök ugyanazon a helyi hálózaton vannak, és a hálózati beállítások engedik, hogy a követők elérjék a vetítő eszközt. A Wi-Fi kliensizoláció (AP isolation) vagy a tűzfal még azonos Wi-Fi-n is blokkolhatja a keresést vagy a csatlakozást. A kapcsolat internet nélkül is működik. Kapcsold be a Hoszt módot a vetítő eszközön. A követők a Wi-Fi ikonnal jelölt sorból vagy a megosztott helyi linkkel nyithatják meg a vetítést a böngészőjükben.",
            "LAN (Host mode)",
            "Host mode only works when the devices are on the same local network and the network settings allow followers to reach the projecting device. Wi-Fi client isolation (AP isolation) or firewall rules can block discovery or connection even on the same Wi-Fi network. This works without internet access. Enable Host mode on the projecting device. Followers can open the projection in their browser from the row with the Wi-Fi icon or by using the shared local link."
          ),
          { helpIcons: ["images/iweb-session.svg", "images/wifi.svg"] }
        ),
        s(
          "sessions-nearby",
          nearby,
          tx(
            "Nearby (Közeli mód)",
            "A Közeli mód elsősorban egymás Bluetooth-hatótávolságán belüli Android-eszközökhöz ajánlott. Mindkét eszközön kapcsold be a Bluetooth-t, és add meg a PraiseProjectornak a kért engedélyeket. Így közös Wi-Fi és internet nélkül is csatlakozhattok. Kapcsold be a Közeli módot a vetítő eszközön. A követő a tablet ikonnal jelölt sort válassza a PraiseProjectorban. Ugyanez a kapcsoló a helyi hálózaton is elérhetővé teszi a vetítést más PraiseProjector-alkalmazások számára.",
            "Nearby mode",
            "Nearby mode is mainly for Android devices within Bluetooth range of each other. Turn on Bluetooth on both devices and grant the permissions PraiseProjector requests. This works without a shared Wi-Fi network or internet access. Enable Nearby mode on the projecting device and choose the row with the tablet icon in PraiseProjector on the following device. The same switch also makes the projection available to other PraiseProjector apps on the local network."
          ),
          { helpIcons: ["images/ppd-session.svg", "images/tablet.svg"] }
        ),
        s(
          "sessions-qr",
          qrIcons,
          tx(
            "Csatlakozás QR-kóddal vagy linkkel",
            "Ha a Felhő vagy a LAN (Hoszt mód) aktív, vidd az egeret a kapcsoló ikonjára, vagy koppints egyszer az ikonra a QR-kód megjelenítéséhez. Kattints az ikonra vagy koppints rá ismét a nagyításhoz. A követők beolvashatják a kódot, vagy elküldheted nekik a mellette kimásolható linket.",
            "Join with a QR code or link",
            "When Cloud or LAN (Host mode) is active, hover over the switch icon or tap it once to reveal the QR code. Click the icon or tap it again to enlarge the code. Followers can scan the code, or you can copy the link next to it and send it to them."
          ),
          { helpIcons: ["images/cloud-session.svg", "images/iweb-session.svg", { label: "📋" }], highlightTargets: qrIcons }
        ),
      ],
    }
  );
}
