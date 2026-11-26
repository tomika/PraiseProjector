import { IconType } from "../services/IconService";
import { sessionsTutorial } from "./sessionsTutorial";
import type { TutorialDefinition } from "./tutorialTypes";
import {
  activateEditorTab,
  activateFullPanel,
  activatePreviewTab,
  clickVisible,
  closeFullTutorialPopovers,
  tutorialLabel as tl,
  tutorialStep as s,
  tutorialText as tx,
} from "./tutorialDefinitionHelpers";

const side = () => {
  closeFullTutorialPopovers();
  activateFullPanel("side");
};
const editor = () => {
  closeFullTutorialPopovers();
  activateFullPanel("editor");
  activateEditorTab(0);
};
const preview = () => {
  closeFullTutorialPopovers();
  activateFullPanel("preview");
};

export const fullViewTutorial: TutorialDefinition = {
  view: "full",
  version: 5,
  cleanup: closeFullTutorialPopovers,
  steps: [
    s(
      "profile-database",
      "[data-tutorial-id='full-profile-database']",
      tx(
        "Profil és adatbázis",
        "A felhasználói fiók választja ki a helyi és felhős daladatbázist; a vezetői profil az egyéni előadási beállításokat tárolja. Innen indítható a szinkronizálás és a munkamenetek kezelése is.",
        "Profile and database",
        "Your account selects the local and cloud song database, while the leader profile stores personal performance settings. Synchronization and sessions are also available here."
      ),
      {
        helpIcons: [IconType.USER, IconType.SYNC, IconType.LEADER, IconType.SESSIONS],
        prepare: side,
        actions: [{ id: "sync-now", label: tl("Szinkronizálás most", "Synchronize now"), command: "sync-now" }],
        details: [
          s(
            "sync-account",
            ".user-login-input-wrapper",
            tx(
              "Felhasználói fiók",
              "A fiók választja ki a helyi és felhős adatbázist. A felhasználói vezérlő bejelentkezésre, fiókváltásra és kijelentkezésre szolgál.",
              "User account",
              "Your account selects the local and cloud database. Use the user control to sign in, switch account or sign out."
            ),
            { helpIcons: [IconType.USER] }
          ),
          s(
            "sync-main",
            ".user-sync-group .user-sync-main-btn",
            tx(
              "Szinkronizálás indítása",
              "A szinkronizálás főgombja elindítja az egyeztetést. Ha mentetlen dalszerkesztés van folyamatban, az Elvetés és szinkronizálás eldobja ezeket a módosításokat. Ha meg szeretnéd tartani őket, zárd be a kérdést, mentsd el a dalt, majd indítsd újra a szinkronizálást. Vendégmódban a Publikus dalok letöltése a letöltést indítja el.",
              "Start synchronization",
              "The main Sync button starts synchronization. If you have unsaved song edits, Discard & Sync drops those edits. To keep them, dismiss the prompt, save the song, and start Sync again. In guest mode, Download Public Songs starts the download."
            ),
            { helpIcons: [IconType.SYNC], actions: [{ id: "sync-now", label: tl("Szinkronizálás most", "Synchronize now"), command: "sync-now" }] }
          ),
          s(
            "sync-badges",
            ".user-sync-group",
            tx(
              "Állapotjelvények",
              "Az ↑ a helyi, feltöltésre váró, a ↓ a letöltendő változatokat jelzi. A piros szám ellenőrzendő dalokat mutat. A felhőhibajel internetkapcsolati hibát vagy újrabejelentkezést igénylő állapotot is jelenthet.",
              "Status badges",
              "↑ marks local changes waiting to upload and ↓ marks downloads. A red count means songs need review. A cloud error can indicate either a lost connection or a session that needs a new sign-in."
            ),
            { helpIcons: [{ label: "↑" }, { label: "↓" }, IconType.CLOUD_ACCESS_FAILED] }
          ),
          s(
            "sync-attention-colors",
            "[data-tutorial-id='full-profile-database']",
            tx(
              "Színes teendőjelzések",
              "A nézetváltó és a kliensnézet színes pontjai a teendő típusát jelzik: zöld a feltöltés, kék a letöltés, türkiz mindkettő, narancs az offline állapot. A piros további teendőt jelez, például dalellenőrzést, frissítést vagy újrabejelentkezést.",
              "Attention badge colors",
              "Dots on the view switcher and in client view identify the task: green for upload, blue for download, turquoise for both, and orange for offline. Red indicates another task, such as song review, an app update or signing in again."
            ),
            { helpIcons: [IconType.VIEWER, "images/menu.svg"] }
          ),
          s(
            "sync-menu",
            [".sync-dropdown-menu", ".sync-menu-toggle"],
            tx(
              "Szinkronizálási menü",
              "A szinkronizálás mellett a menüben az Adatbázis exportálása, az Adatbázis importálása és az Adatbázis cseréje online-ra művelet érhető el. Bejelentkezve itt nyithatod meg az Ellenőrizendő dalok ablakát. Egy dal vagy kotta importálásához használd a dalkezelő eszköztár importálásgombját.",
              "Synchronization menu",
              "The Sync menu also offers Export database, Import database and Replace database with online. When signed in, open Songs to Review here. To import a song or score, use the import button on the song toolbar."
            ),
            { helpIcons: [{ label: "▾" }], prepare: () => clickVisible(".sync-menu-toggle") }
          ),
          s(
            "profiles-leader-settings",
            "[data-tutorial-id='full-leader-settings']",
            tx(
              "Dicsőítésvezető és vezető mód",
              "Saját munkamenetben a gomb közvetlenül a Beállítások Dicsőítésvezetők oldalára visz. PPD-munkamenet követésekor, ha a házigazda engedélyezte, ugyanez a gomb a követő és vezető mód között vált; a kék kiemelés jelzi az aktív vezető módot.",
              "Worship leader and leader mode",
              "In your own session, the button opens the Leaders page in Settings. While following a PPD session, the same button switches between follower and leader mode when the host permits it; a blue highlight marks active leader mode."
            ),
            { helpIcons: [IconType.LEADER] }
          ),
          s(
            "profiles-leader",
            ".user-leader-select-wrapper",
            tx(
              "Dicsőítésvezetői profil",
              "A vezetői profil tárolja a dalpreferenciákat, transzponálást, capo-beállítást, instrukciókat és ütemezett műsortárakat.",
              "Worship leader profile",
              "The leader profile stores song preferences, transpose, capo, instructions and scheduled playlists."
            )
          ),
          s(
            "profiles-session",
            ".user-session-btn",
            tx(
              "Munkamenetek",
              "Ezzel a gombbal nyithatod meg a Munkamenetek ablakot, ahol saját vetítést oszthatsz meg, vagy más eszköz vetítéséhez csatlakozhatsz.",
              "Sessions",
              "This button opens the Sessions window, where you can share your projection or join one from another device."
            ),
            { helpIcons: [IconType.SESSIONS] }
          ),
          s(
            "profiles-settings",
            ".user-sync-height-btn[aria-label='Settings']",
            tx(
              "Profil- és alkalmazásbeállítások",
              "A felület, vetítés, adatkezelés, stílusok és kapcsolatok részletes beállításai itt érhetők el.",
              "Profile and application settings",
              "Detailed interface, projection, data, style and connection settings are available here."
            ),
            { helpIcons: [IconType.SETTINGS] }
          ),
        ],
      }
    ),
    sessionsTutorial(".user-session-btn", IconType.SESSIONS, side),
    s(
      "song-tree",
      ".song-list-panel",
      tx(
        "Dalkönyvtár",
        "A dalkönyvtár keresésre, szűrésre és csoportosításra szolgál. A kiválasztott dal szerkeszthető, a műsortárhoz adható és vetíthető.",
        "Song library",
        "Search, filter and group songs here. A selected song can be edited, added to the playlist and projected."
      ),
      {
        prepare: side,
        details: [
          s(
            "song-preference",
            ".preferred-filter-btn",
            tx(
              "Kedveltségi szűrő",
              "Ha kiválasztasz egy dicsőítésvezetőt, a kereső melletti szív gomb három nézet között vált. Az alapnézet a kedvelt és a semleges dalokat mutatja. A második nézetben csak a kedvelt dalok jelennek meg. A harmadik a figyelmen kívül hagyott dalokat is megjeleníti. A többi aktív szűrő mindhárom nézetben érvényben marad.",
              "Preference filter",
              "With a worship leader selected, the heart button next to Search cycles through three views. The default view shows preferred and neutral songs. The second shows preferred songs only. The third also includes ignored songs. Other active filters apply in all three views."
            ),
            { helpIcons: [IconType.BIG_HEART_EMPTY, IconType.BIG_HEART_FILLED, IconType.EYE] }
          ),
          s(
            "song-preference-status",
            [".song-heart", ".song-list-panel"],
            tx(
              "Kedvelt dal megjelölése",
              "Válassz vezetői profilt. A dal melletti szívvel Kedvelt állapotot adhatsz a dalnak, a telt szívre kattintva pedig Semlegesre válthatsz. A dal helyi menüjének Preferencia sorában a Semleges, a Kedvelt és a Figyelmen kívül hagyott állapot is választható. A keresőmező melletti szűrő üres szívvel a figyelmen kívül hagyottakat rejti el, telt szívvel csak a kedvelteket mutatja, szem ikonnal a figyelmen kívül hagyottakat is megjeleníti.",
              "Mark a song as preferred",
              "Select a leader profile. Click the heart next to a song to mark it Preferred, or click a filled heart to make the song Neutral. The song's context menu has a Preference row with Neutral, Preferred and Ignored. The filter beside the search box hides ignored songs with the empty heart, shows only preferred songs with the filled heart, and includes ignored songs with the eye icon."
            ),
            { helpIcons: [IconType.HEART_EMPTY, IconType.HEART_FILLED, IconType.HEART_IGNORED] }
          ),
          s(
            "song-search",
            ".song-filter-input",
            tx(
              "Keresés",
              "A keresés címre, dalszövegre, valamint a beállított módtól függően más metaadatra is kiterjedhet.",
              "Search",
              "Search by title, lyrics or other metadata, depending on your search settings."
            ),
            { helpIcons: [IconType.CLEAR] }
          ),
          s(
            "song-search-options",
            ".song-search-toggle-btn",
            tx(
              "Keresés finomítása",
              "A hagyományos keresésnél külön kapcsolható a hasonló szöveg, a kis- és nagybetű érzékenysége és a teljes szavak egyezése.",
              "Search options",
              "Traditional search can match similar text, respect letter case and require complete words."
            ),
            { helpIcons: [IconType.SEARCH_FUZZY, IconType.SEARCH_CASE, IconType.SEARCH_WHOLE_WORD] }
          ),
          s(
            "song-content-filters",
            ".song-list-panel",
            tx(
              "Tartalmi és nyelvi szűrők",
              "Alapértelmezésben minden daltípus engedélyezett. A helyi menü Szűrő almenüjében külön kapcsolhatók az akkordos, csak szöveges, csak kottás és megjelölt elemek. Az Általános beállítások dalnyelvi szűrője is szűkít; hiányzó dalnál ezeket és a kedveltségi szűrőt is ellenőrizd.",
              "Content and language filters",
              "All song types are enabled by default. The context menu's Filter submenu separately includes songs with chords, text-only, score-only and marked entries. General settings also has a song-language filter; if a song is missing, check these and the preference filter."
            ),
            { helpIcons: ["fa fa-filter", IconType.CHECKBOX_CHECKED, IconType.CHECKBOX_EMPTY] }
          ),
          s(
            "song-active-filter",
            [".song-tree-filter-watermark", ".song-list-panel"],
            tx(
              "Aktív szűrés jelzése",
              "A tölcsér akkor jelenik meg, ha ki van kapcsolva valamelyik tartalmi szűrőbeállítás, aktív a dalnyelvi szűrő, vagy a kedveltségi nézet csak a kedvelt dalokat mutatja. Ha egy figyelmen kívül hagyott dalt keresel, a szív gombbal válts arra a nézetre, amely ezeket a dalokat is megjeleníti. A keresőmező törlése egyik szűrőbeállítást sem módosítja.",
              "Active filter indicator",
              "The funnel appears when a content category is turned off, the song-language filter is set, or the preference view shows only preferred songs. To find an ignored song, use the heart button to switch to the view that includes ignored songs. Clearing the search field leaves these filter settings in place."
            ),
            { helpIcons: ["fa fa-filter"] }
          ),
          s(
            "song-items",
            [".song-list-panel .song-item", ".song-list-panel"],
            tx(
              "Dalok és csoportok",
              "A mappák összetartozó változatokat jelölnek; a dalok csoportosítására és műsortárhoz adására is lehetőséget adnak.",
              "Songs and groups",
              "Folders represent related versions. Songs can be grouped with another song or added to the playlist."
            ),
            { helpIcons: [IconType.FOLDER, IconType.MUSIC, IconType.TEXT_ONLY, IconType.SCORE] }
          ),
          s(
            "song-drag-and-drop",
            ".song-list-panel",
            tx(
              "Áthúzás és fájlimportálás",
              "Húzd a dalt a Műsortár kívánt helyére. Dalokat úgy csoportosíthatsz, hogy egy dalt egy másik dalra vagy egy csoportmappára húzol. A Dalkönyvtárba húzott külső fájl megnyitja az importálót. Támogatott kiterjesztések a .chp, .abc, .musicxml, .xml, .mxl, .txt, .pdf, .docx, .htm és .html.",
              "Drag and drop",
              "Drag a song to the desired position in the playlist. To group songs, drop a song onto another song or a group folder. Dropping an external file into the song library opens the importer. It supports .chp, .abc, .musicxml, .xml, .mxl, .txt, .pdf, .docx, .htm and .html."
            )
          ),
          s(
            "song-context",
            ".song-list-panel",
            tx(
              "Helyi menü",
              "Nyisd meg a dal helyi menüjét jobb kattintással vagy hosszan nyomva. Kiválasztott dalnál itt érhető el a megosztás. Vendégmódban itt törölheted a dalt, fiókkal pedig a verzióelőzményeket nézheted meg. A csoportbontás csoportba tartozó dalnál jelenik meg. A vágólapos importálás akkor választható, ha a vágólap olvasható, importálható tartalmat ad.",
              "Context menu",
              "Right-click or press and hold a song to open its context menu. Use it to share the selected song. In guest mode you can delete the song here. With an account you can open its version history. Ungroup appears for songs in a group. Import from clipboard is available when the app can read importable clipboard content."
            ),
            { helpIcons: ["fa fa-filter", "fa fa-sort", "fa fa-history", "fa fa-clipboard", "fa fa-share-alt"] }
          ),
          s(
            "song-keyboard",
            ".song-list-panel",
            tx(
              "Billentyűzet",
              "Ha a dalkönyvtár listája van fókuszban, a Fel és Le nyíl egy dallal, a Page Up, Page Down és Szóköz egy oldalnyival léptet. A Shift+Szóköz visszafelé léptet. A Home az első, az End az utolsó dalra ugrik. Az Enter a dupla kattintáshoz hasonlóan a műsortárhoz adja a kijelölt dalt. A Delete a kijelölt dalt kiveszi a csoportjából. A Ctrl+V vagy a Shift+Insert a vágólapról importál.",
              "Keyboard",
              "With the song library list focused, Up and Down move by one song. Page Up, Page Down and Space move by a page. Shift+Space moves back a page. Home and End go to the first and last songs. Enter adds the selected song to the playlist, just like double-clicking. Delete removes the selected song from its group. Ctrl+V or Shift+Insert imports from the clipboard."
            )
          ),
        ],
      }
    ),
    s(
      "playlist",
      ".playlist-panel-container",
      tx(
        "Műsortár",
        "Itt állítható össze az előadás sorrendje. A dalonkénti transzponálás, capo, egyedi cím és instrukciók nem módosítják az eredeti dalt.",
        "Playlist",
        "Build the running order here. Per-entry transpose, capo, custom title and instructions do not modify the original song."
      ),
      {
        prepare: side,
        details: [
          s(
            "playlist-items",
            ".playlist-items-container",
            tx(
              "Műsortári sorok",
              "A kiválasztott dal megjelenik; több sor együtt is kijelölhető és átrendezhető. A dalokhoz egyesével definiálható egyedi cím, hangnem, capo beállítás és instrukciók.",
              "Playlist rows",
              "The selected song is displayed; multiple rows can be selected together and reordered. An individual title, key, capo setting and instructions can be defined separately for each song."
            )
          ),
          s(
            "playlist-load-save",
            ".playlist-buttons button[aria-label='Load Playlist'], .playlist-buttons button[aria-label='Save Playlist']",
            tx(
              "Műsortár betöltése és mentése",
              "Ha van kiválasztott vezető, a Betöltés és a Mentés a naptárával és a kedvenceivel dolgozik; vezető nélkül fájlba ment és fájlból tölt be. Betöltéskor a vezetőválasztó három csoportja: a saját vezetők; a Csoportom, vagyis a csoportodban és az alatta levő csoportokban (adminként az általad kezelt csoportok alatt) levő vezetők, akiknek minden listája látszik, de csak olvasható; végül más vezetők nyilvános listái. A választó melletti fa gombbal az utóbbi két csoport a csoportfa szerint rendezve látszik (a csoportnevek nem választhatók; a Csoportom csak akkor, ha a vezetői nem mind ugyanabban a csoportban vannak); a beállítás megmarad. A munkalista másolat: amíg vissza nem mented, a módosítása nem változtatja meg a tárolt listát. Betöltéskor a saját listák sorában a földgömb mutatja, hogy a lista nyilvános-e: halványan privát, kiemelve nyilvános; rákattintva átállíthatod. A nyilvános listát mások is látják és megnyithatják a linkjét; privát csoport vezetőjénél ez csak a csoport tagjaira érvényes. A megosztás gomb nyilvánossá teszi a listát és linket ad hozzá, a kuka törli a listát.",
              "Load and save playlists",
              "With a leader selected, Load and Save work with the leader's calendar and favorites; with no leader selected, they use a playlist file. When loading, the leader select has three groups: your own leaders; My group, the leaders in your group and the groups below it (as an admin, below the groups you administer), whose every list is shown read-only; and other leaders' public lists. The tree button next to the select arranges the last two groups by the group tree (group names cannot be selected; My group only when its leaders are not all in the same group); the choice is kept. The working list is a copy: changing it does not change the stored list until you save it there. When loading, the globe in an own list's row shows whether the list is public: faint is private, highlighted is public; click it to switch. Others can see a public list and open its link; for a leader in a private group, this applies to the group's members only. The share button makes the list public and gives a link to it; the trash can deletes the list."
            ),
            {
              helpIcons: [IconType.LOAD, IconType.SAVE, "images/group-tree.svg", "images/public-list.svg", "images/share.svg", "images/trashcan.svg"],
              highlightTargets: [".playlist-buttons button[aria-label='Load Playlist']", ".playlist-buttons button[aria-label='Save Playlist']"],
            }
          ),
          s(
            "playlist-move",
            ".playlist-buttons button[aria-label='Move Up'], .playlist-buttons button[aria-label='Move Down']",
            tx(
              "Műsortételek mozgatása",
              "A kijelölt műsortételek a fel és le nyilakkal egy pozícióval előrébb vagy hátrébb helyezhetők.",
              "Move playlist entries",
              "Use the up and down arrows to move the selected playlist entries one position earlier or later."
            ),
            {
              helpIcons: [IconType.MOVE_UP, IconType.MOVE_DOWN],
              highlightTargets: [".playlist-buttons button[aria-label='Move Up']", ".playlist-buttons button[aria-label='Move Down']"],
            }
          ),
          s(
            "playlist-transpose",
            ".playlist-buttons button[aria-label='Transpose Up'], .playlist-buttons button[aria-label='Transpose Down']",
            tx(
              "Transzponálás",
              "A kijelölt műsortételek egyedi transzponálási értéke a fel és le nyilakkal félhangonként módosítható.",
              "Transpose",
              "Use the up and down arrows to raise or lower the selected playlist entries' per-entry transpose by one semitone."
            ),
            {
              helpIcons: [IconType.TRANSPOSE_UP, IconType.TRANSPOSE_DOWN],
              highlightTargets: [".playlist-buttons button[aria-label='Transpose Up']", ".playlist-buttons button[aria-label='Transpose Down']"],
            }
          ),
          s(
            "playlist-capo",
            ".playlist-buttons button[aria-label='Capo Up'], .playlist-buttons button[aria-label='Capo Down']",
            tx(
              "Capo",
              "A kijelölt műsortételek capoértéke a fel és le nyilakkal módosítható.",
              "Capo",
              "Use the up and down arrows to increase or decrease the capo value of selected playlist entries."
            ),
            {
              helpIcons: [IconType.CAPO_UP, IconType.CAPO_DOWN],
              highlightTargets: [".playlist-buttons button[aria-label='Capo Up']", ".playlist-buttons button[aria-label='Capo Down']"],
            }
          ),
          s(
            "playlist-remove",
            ".playlist-buttons button[aria-label='Remove']",
            tx(
              "Eltávolítás",
              "A kijelölt tételeket az aktuális műsortárból távolítja el; az adatbázis dalait nem törli.",
              "Remove",
              "Remove selected entries from the current playlist without deleting database songs."
            ),
            { helpIcons: [IconType.REMOVE] }
          ),
          s(
            "playlist-edit",
            ".playlist-buttons button[aria-label='Edit']",
            tx(
              "Műsortétel szerkesztése",
              "Ez a vezérlő a kijelölt műsortétel egyedi címének szerkesztésére szolgál.",
              "Edit playlist entry",
              "Edit the selected entry's custom title."
            ),
            { helpIcons: [IconType.EDIT] }
          ),
          s(
            "playlist-add",
            ".playlist-buttons button[aria-label='Add']",
            tx(
              "Dal hozzáadása",
              "A dalkönyvtárban kijelölt dalt hozzáadja az aktuális műsortárhoz.",
              "Add song",
              "Add the selected library song to the current playlist."
            ),
            { helpIcons: [IconType.ADD] }
          ),
          s(
            "playlist-instructions",
            ".playlist-items-container",
            tx(
              "Cím és instrukciók",
              "A műsortétel saját címet és előadási instrukciót kaphat. A cím szerkesztéséhez kattints duplán a címre. Az instrukciószerkesztőt a sor jobb szélén lévő instrukciócellában nyithatod meg dupla kattintással, érintőképernyőn egy koppintással. Ezek a beállítások a műsortételhez tartoznak.",
              "Title and instructions",
              "Each playlist entry can have its own title and performance instructions. Double-click the title to edit it. Open the instructions editor in the rightmost cell with a double-click, or with one tap on a touchscreen. These settings belong to the playlist entry."
            ),
            { helpIcons: [IconType.CHECKBOX_EMPTY, IconType.CHECKBOX_CHECKED] }
          ),
          s(
            "playlist-context",
            ".playlist-items-container",
            tx(
              "Helyi menü és előzmények",
              "A jobb gombos menü transzponálást, capo-választást, kijelölést, visszavonást, ismétlést és – mentett listánál – megosztást kínál. A megosztás nyilvánossá teszi a saját vezető listáját.",
              "Context menu and history",
              "The context menu offers transpose, capo, selection, undo, redo and sharing for saved lists. Sharing makes an own leader's list public."
            ),
            { helpIcons: ["fa fa-undo", "fa fa-repeat", "fa fa-share-alt"] }
          ),
          s(
            "playlist-instruction-editor",
            ".playlist-items-container",
            tx(
              "Instrukciószerkesztő",
              "A Forrás, Szerkesztő és Előnézet panelek összecsukhatók. A szöveg törölhető, visszaállítható és menthető, a változat pedig a vezető profiljában is tárolható.",
              "Instructions editor",
              "Source, Editor and Preview panes can be collapsed. Clear, reset and save the text, optionally storing it in the leader profile."
            ),
            { helpIcons: [IconType.CHECKBOX_EMPTY, IconType.CHECKBOX_CHECKED] }
          ),
          s(
            "playlist-score-instructions",
            ".playlist-items-container",
            tx(
              "Instrukciók kottás dalokhoz",
              "A feldolgozható, dalszöveget tartalmazó ABC-kotta részei és versszakai is használhatók az előadási sorrendben. Az instrukciószerkesztőben az egész kottablokk mellett annak kibontott részei is megjelenhetnek. Ez az előadási nézetet alakítja, az eredeti kottát nem írja át.",
              "Instructions for songs with notation",
              "Parts and verses from supported ABC scores with lyrics can be used in the performance order. The instructions editor may show expanded parts as well as the whole score block. This changes the performance view without rewriting the original notation."
            )
          ),
          s(
            "playlist-keyboard",
            ".playlist-items-container",
            tx(
              "Billentyűzet",
              "A Shift bővíti a kijelölést, a Ctrl/Cmd+A mindent kijelöl. A Delete töröl, a Ctrl+Fel/Le átrendez, az Alt+Fel/Le transzponál; a műveletek visszavonhatók.",
              "Keyboard",
              "Extend selection with Shift or select all with Ctrl/Cmd+A. Delete removes, Ctrl+Up/Down reorders and Alt+Up/Down transposes; edits can be undone."
            )
          ),
        ],
      }
    ),
    s(
      "song-toolbar",
      ".btn-toolbar",
      tx(
        "Dalkezelő eszköztár",
        "Ez az eszköztár az aktuális dal újratöltésére és mentésére, új dal vagy importálás indítására, nyomtatásra, kliens nézetre váltásra és a beállítások megnyitására szolgál.",
        "Song toolbar",
        "Reload and save songs, create or import a song, print, switch to client view and open settings from here."
      ),
      {
        prepare: editor,
        details: [
          s(
            "toolbar-load",
            ".btn-toolbar button[aria-label='Load Song']",
            tx(
              "Dal újratöltése",
              "Visszaállítja az adatbázisban mentett változatot; nem mentett módosításnál előbb megerősítést kérhet.",
              "Reload song",
              "Restore the database version; the app may ask before discarding unsaved changes."
            ),
            { helpIcons: [IconType.LOAD] }
          ),
          s(
            "toolbar-save",
            ".btn-toolbar button[aria-label='Save Song']",
            tx("Dal mentése", "Rögzíti az aktuális szerkesztést a daladatbázisban.", "Save song", "Store the current edit in the song database."),
            { helpIcons: [IconType.SAVE] }
          ),
          s(
            "toolbar-new",
            ".btn-toolbar button[aria-label='New Song']",
            tx(
              "Új dal",
              "Ez a vezérlő új, üres dalt hoz létre, amely közvetlenül a szerkesztőben szerkeszthető.",
              "New song",
              "Create an empty song and start working directly in the editor."
            ),
            { helpIcons: [IconType.NEW] }
          ),
          s(
            "toolbar-import",
            "[data-tutorial-id='full-toolbar-import']",
            tx(
              "Importálás",
              "Az importálót a dalkezelő eszköztár importálásgombjával nyithatod meg. A ChordPro- és ABC-fájl közvetlenül a szerkesztési lépésre kerül, a MusicXML-fájl ABC-kottává alakul. A felismert, beillesztett ABC-szöveg importálása előtt az alkalmazás megerősítést kér.",
              "Import",
              "Open the importer from the song toolbar. ChordPro and ABC files go straight to the editing step. MusicXML files are converted to ABC notation. When pasted text is recognized as ABC, the app asks before importing it as notation."
            ),
            { helpIcons: [IconType.IMPORT] }
          ),
          s(
            "toolbar-print",
            ".btn-toolbar button[aria-label='Print']",
            tx("Nyomtatás", "Az aktuális dal nyomtatható ki itt.", "Print", "The current song can be printed here."),
            { helpIcons: [IconType.PRINT] }
          ),
          s(
            "toolbar-client",
            ".btn-toolbar button[aria-label='Mobile View']",
            tx(
              "Kliens nézet",
              "A teljes nézet eszköztárán a Mobil nézetre váltás gomb nyitja meg az előadáshoz készült kliensnézetet. A beépített bemutató Kliens nézetre váltás gombjával ott folytathatod a bemutatót.",
              "Client view",
              "In the full-view toolbar, Switch to mobile view opens the streamlined client view for performances. In the built-in tutorial, use Switch to client view to continue the tour there."
            ),
            {
              helpIcons: [IconType.VIEWER],
              actions: [{ id: "switch-client", label: tl("Kliens nézetre váltás", "Switch to client view"), command: "switch-client" }],
            }
          ),
          s(
            "toolbar-settings",
            ".btn-toolbar button[aria-label='Settings']",
            tx(
              "Beállítások",
              "A Beállítások gomb nyitja meg a keresés, a dalnyelvek, a vetítés, a kotta, a hardveres vezérlés, a vezetők, a stílusok, a kliensjogosultságok és a hálózati funkciók beállításait. A dalnyelvhez az Általános, a billentyű- és MIDI-kiosztáshoz a Hardveres vezérlés, a kotta alapbeállításaihoz a Kotta lapot válaszd.",
              "Settings",
              "Open Settings to configure search, song languages, projection, scores, hardware controls, leaders, styles, client permissions and networking. Use General for song language, Hardware control for keyboard and MIDI mappings, and Score for notation defaults."
            ),
            { helpIcons: [IconType.SETTINGS] }
          ),
        ],
        branches: [
          {
            id: "application-settings",
            label: tl("Nyelv, hardver, kotta és MI-asszisztens", "Language, hardware, scores and AI assistant"),
            steps: [
              s(
                "settings-song-language",
                ".btn-toolbar button[aria-label='Settings']",
                tx(
                  "Dalnyelv és nyelvi szűrés",
                  "A Beállítások Általános lapján az alapértelmezett dalnyelv az új dalok kiinduló nyelvét adja meg. A dalnyelvi szűrő a könyvtárat és a kapcsolódó kereséseket szűkíti. Ez a felület nyelvétől külön beállítás; a dal saját nyelve a Metaadatok lapon módosítható.",
                  "Song language and filtering",
                  "In Settings → General, default song language supplies the initial language for new songs. The song-language filter restricts the library and related searches. This is separate from the interface language; edit an individual song's language on its Metadata tab."
                ),
                { helpIcons: [IconType.SETTINGS] }
              ),
              s(
                "settings-hardware-profiles",
                ".btn-toolbar button[aria-label='Settings']",
                tx(
                  "Hardveres vezérlési profilok",
                  "A Beállítások Hardveres vezérlés lapján először válaszd ki a teljes vagy a kliensnézetet: mindkettő saját billentyűzet- és MIDI-profilt használ. A gyári profil csak olvasható; saját kiosztáshoz készíts róla másolatot, és azt szerkeszd.",
                  "Hardware control profiles",
                  "In Settings → Hardware control, first select full or client view: each has its own keyboard and MIDI profile. The factory profile is read-only; copy it to create and edit your own mapping."
                ),
                { helpIcons: [IconType.SETTINGS] }
              ),
              s(
                "settings-hardware-learning",
                ".btn-toolbar button[aria-label='Settings']",
                tx(
                  "Billentyű és MIDI betanítása",
                  "A Hardveres vezérlés lapon a művelethez billentyűkombináció vagy MIDI-jel tanítható be, illetve kézzel is megadható a hozzárendelés. Az ütközésjelzés segít elkerülni az azonos bemeneteket. A MIDI használatához a környezet támogatása és hozzáférési engedély is szükséges lehet; a lap az állapotát is mutatja.",
                  "Learn keyboard and MIDI inputs",
                  "On the Hardware control page, learn a key combination or MIDI signal for an action, or enter the binding manually. Conflict indicators help avoid overlapping inputs. MIDI requires a supported runtime and may require permission; its status is shown on this page."
                ),
                { helpIcons: [IconType.SETTINGS] }
              ),
              s(
                "settings-hardware-scope",
                ".btn-toolbar button[aria-label='Settings']",
                tx(
                  "Billentyűk hatóköre",
                  "A teljes nézetben egy billentyű csak a fókuszban lévő szakaszlistára vagy a teljes nézet minden paneljére is érvényes lehet. A tutorial billentyűleírásai a gyári kiosztást ismertetik; saját profil más műveleteket rendelhet hozzájuk. Nyitott párbeszédablakban annak vezérlői élveznek elsőbbséget.",
                  "Keyboard scope",
                  "In full view a key can apply only while the section list has focus, or across all full-view panels. The tutorial's keyboard descriptions refer to factory mappings; a custom profile can assign different actions. An open dialog takes priority over hardware commands."
                ),
                { helpIcons: [IconType.SETTINGS] }
              ),
              s(
                "settings-score-defaults",
                ".btn-toolbar button[aria-label='Settings']",
                tx(
                  "Kotta-alapbeállítások",
                  "A Beállítások Kotta lapján a lejátszás hangszerei, kísérete és a kotta megjelenésének alapértékei állíthatók. A kotta saját beállításai elsőbbséget élveznek az alapértékekkel szemben. A változások a Beállítások mentése után érvényesek.",
                  "Score defaults",
                  "Settings → Score sets default playback instruments, accompaniment and notation appearance. A score's own options take priority over these defaults. Changes take effect after saving Settings."
                ),
                { helpIcons: [IconType.SETTINGS] }
              ),
              s(
                "settings-mcp",
                ".btn-toolbar button[aria-label='Settings']",
                tx(
                  "MI-asszisztens (MCP)",
                  "Az asztali alkalmazásban a Beállítások MI-asszisztens (MCP) lapján kapcsolható be a beépített MCP-szerver. Rajta keresztül egy általad választott MI-asszisztens a beépített útmutató alapján válaszol, dalokat keres és lejátszási listát készít elő. A kapcsolat csak ezen a számítógépen működik, és a lapon látható hozzáférési kulcs kell hozzá; az Új kulcs gomb minden korábban beállított asszisztens hozzáférését megszünteti. Alapból az asszisztens csak olvas: a Módosítások engedélyezése és az Élő vezérlés engedélyezése ad neki több jogot, és kérheted, hogy minden módosítás előtt rákérdezzen. A Csatlakozás módja szerinti beállítást a Másolás gombbal viheted át az asszisztens konfigurációjába. A változások a Beállítások mentése után érvényesek.",
                  "AI assistant (MCP)",
                  "In the desktop app, Settings → AI assistant (MCP) turns on the built-in MCP server. Through it an AI assistant of your choice answers from the built-in guide, searches songs and prepares playlists. The connection works only on this computer and needs the access token shown on the page; Regenerate revokes every assistant set up earlier. By default the assistant can only read: Allow changes and Allow live control give it more, and you can have the app ask before each change. Copy the setup for the method chosen under Connect with into the assistant's configuration. Changes take effect after saving Settings."
                ),
                { helpIcons: [IconType.SETTINGS] }
              ),
            ],
          },
        ],
      }
    ),
    s(
      "editor",
      ".editor-panel-wrapper",
      tx(
        "Szerkesztő",
        "A dal vizuális, metaadat- és ChordPro-kód nézetben szerkeszthető. A módosítások a mentésig helyi szerkesztési állapotban maradnak.",
        "Editor",
        "Edit the song visually, through metadata or as ChordPro source. Changes remain in local editor state until saved."
      ),
      {
        prepare: editor,
        details: [
          s(
            "editor-mode",
            ".edit-toggle-button",
            tx(
              "Szerkesztési mód",
              "A ceruza vált az olvasási és szerkesztési mód között. Módosítás után kilépéskor választható a Mentés, a Kilépés mentés nélkül vagy a Szerkesztés folytatása; az utóbbi a szerkesztőben tartja a munkát.",
              "Edit mode",
              "The pencil switches between reading and editing. After changes, choose Save, Leave without saving or Continue editing when leaving; the last choice keeps your work in edit mode."
            ),
            { helpIcons: [IconType.EDIT] }
          ),
          s(
            "editor-wysiwyg",
            "[data-tutorial-id='full-editor-tab-wysiwyg']",
            tx(
              "Dal szerkesztő",
              "A vizuális nézetben a dalszöveg és az akkordok a kész megjelenéshez hasonló formában szerkeszthetők.",
              "Song editor",
              "Edit lyrics and chords in a visual layout that resembles the finished song."
            ),
            { helpIcons: ["fa fa-music"] }
          ),
          s(
            "editor-title",
            "[data-tutorial-id='full-editor-title']",
            tx("Cím", "A kijelölt szöveget a dal címévé alakítja.", "Title", "Turn the selected text into the song title."),
            { helpIcons: [IconType.TITLE] }
          ),
          s(
            "editor-verse",
            "[data-tutorial-id='full-editor-verse']",
            tx("Versszak", "A kijelölt sorokat számozott versszakként jelöli.", "Verse", "Mark the selected lines as a numbered verse."),
            { helpIcons: [IconType.VERSE] }
          ),
          s(
            "editor-chorus",
            "[data-tutorial-id='full-editor-chorus']",
            tx("Refrén", "A kijelölt sorokat refrénként jelöli.", "Chorus", "Mark the selected lines as a chorus."),
            { helpIcons: [IconType.CHORUS] }
          ),
          s(
            "editor-bridge",
            "[data-tutorial-id='full-editor-bridge']",
            tx("Híd", "A kijelölt sorokat hídként jelöli.", "Bridge", "Mark the selected lines as a bridge."),
            { helpIcons: [IconType.BRIDGE] }
          ),
          s(
            "editor-grid",
            "[data-tutorial-id='full-editor-grid']",
            tx(
              "Akkordrács",
              "A kijelölt sorokat csak hangszeres akkordmenetként jelöli.",
              "Chord grid",
              "Mark the selected lines as an instrumental chord grid."
            ),
            { helpIcons: [IconType.GRID] }
          ),
          s(
            "editor-comment",
            "[data-tutorial-id='full-editor-comment']",
            tx(
              "Megjegyzés",
              "A kijelölt, akkordot nem tartalmazó sorokat megjegyzéssé alakítja, illetve visszaalakítja normál dalszöveggé. Akkordos kijelölésnél a gomb le van tiltva. A szakaszok közé írt, szakaszt megnevező megjegyzés (például „Refrén 2x”) annak ismétlését jelzi: olvasási módban a szakasz első sora jelenik meg „...” végződéssel, szürke címkével. Egy másik szakaszon belül ez nem számít instrukciónak, ezért piros hullámvonal jelöli.",
              "Comment",
              "Toggle selected chord-free lines between comments and normal lyrics. The button is disabled when the selection contains chords. A comment naming a section between sections (for example “Chorus 2x”) repeats it: read mode shows that section's first line ending in “...” under a grey label. Inside another section it is not an instruction, so a red wavy line marks it."
            ),
            { helpIcons: [IconType.COMMENT] }
          ),
          s(
            "editor-abc",
            "[data-tutorial-id='full-editor-abc']",
            tx(
              "ABC-kotta",
              "Szerkesztési módban a kurzornál új ABC-kottablokkot szúr be; meglévő kottára dupla kattintva a kottaszerkesztő nyílik meg. Olvasási módban a dupla kattintás vagy dupla koppintás ehelyett a kotta MIDI-lejátszását indítja vagy állítja le.",
              "ABC notation",
              "In edit mode, insert a new ABC block at the caret or double-click existing notation to open the score editor. In read mode, double-clicking or double-tapping notation instead starts or stops its MIDI playback."
            ),
            { helpIcons: [IconType.NOTATION] }
          ),
          s(
            "editor-abc-saving",
            "[data-tutorial-id='full-editor-abc']",
            tx(
              "A kottaszerkesztő használata",
              "A kottaszerkesztő Súgó gombja saját részletes bemutatót nyit. Az Alkalmazás a dal szerkesztési állapotába veszi át a kottát, a Mégse elveti a kottaszerkesztő módosításait. Alkalmazás után a teljes dalt is mentsd el a daladatbázisba.",
              "Using the score editor",
              "The score editor's Help button opens its own detailed tutorial. Apply transfers the notation into the song's editing state; Cancel discards the score editor's changes. After applying, also save the song to the song database."
            ),
            { helpIcons: [IconType.NOTATION] }
          ),
          s(
            "editor-context-menu",
            ".editor-iframe-container",
            tx(
              "A vizuális szerkesztő helyi menüje",
              "A helyi menüben visszavonás és ismétlés, vágólapműveletek, kijelölés, akkordbeszúrás, cím- és szakaszjelölések, megjegyzés, jelölés törlése, valamint a teljes dal félhangos transzponálása érhető el. A pillanatnyilag nem alkalmazható műveletek inaktívak.",
              "Visual editor context menu",
              "The context menu provides undo and redo, clipboard actions, selection, chord insertion, title and section tags, comments, tag clearing, and whole-song semitone transpose. Actions that do not apply to the current selection are disabled."
            )
          ),
          s(
            "editor-meta",
            "[data-tutorial-id='full-editor-tab-meta']",
            tx(
              "Metaadatok",
              "Itt kezelhető többek között a dal nyelve, címe, előadója, szerzője, hangneme, tempója, üteme és capója. Mentéshez a cím kitöltése szükséges.",
              "Metadata",
              "Edit song language, title, artist, author, key, tempo, time signature, capo and other metadata here. A title is required before saving."
            ),
            { helpIcons: ["fa fa-info-circle"] }
          ),
          s(
            "editor-song-language",
            "[data-tutorial-id='full-editor-song-language']",
            tx(
              "A dal nyelve",
              "Szerkesztési módban itt módosítható a dal saját nyelve. A módosítást a dallal együtt kell menteni. Ha az új nyelvet a könyvtár nyelvi szűrője kizárná, az alkalmazás felajánlja a szűrő bővítését.",
              "Song language",
              "Change this song's language here in edit mode, then save it with the song. If the library's language filter would exclude the new language, the app offers to add it to the filter."
            ),
            { prepare: () => activateEditorTab(1) }
          ),
          s(
            "editor-chordpro",
            "[data-tutorial-id='full-editor-tab-chordpro']",
            tx(
              "ChordPro kód",
              "A nyers ChordPro nézet teljes hozzáférést ad a dal direktíváihoz és jelöléseihez, amikor a vizuális nézetnél pontosabb vezérlés szükséges.",
              "ChordPro source",
              "The raw ChordPro view gives complete access to directives and notation when you need more control than the visual editor provides."
            ),
            { helpIcons: ["fa fa-code"] }
          ),
        ],
        branches: [
          {
            id: "editing-principles",
            label: tl("Online szerkesztés szabályai", "Online editing rules"),
            steps: [
              s(
                "principles-online",
                ".editor-panel-wrapper",
                tx(
                  "Online szerkesztés",
                  "A bejelentkezés szinkronizálást, valamint új dalok és javítások beküldését teszi lehetővé. A helyi felhasználói adatbázisban a változás azonnal megjelenik, a publikus adatbázisban viszont csak üzemeltetői jóváhagyás után.",
                  "Online editing",
                  "After signing in you can synchronize and submit new songs or corrections. Changes apply to your own database immediately and reach the public database only after operator approval."
                )
              ),
              s(
                "principle-key",
                ".editor-panel-wrapper",
                tx(
                  "1. Eredeti hangnem",
                  "Nem saját szerzemények rögzítése az eredeti hangnemben történjen; az előadási hangnemet transzponálási beállítás és vezetői profil kezelje.",
                  "1. Original key",
                  "Store songs you did not write in their original key. Use transpose and leader profiles for your performance key."
                )
              ),
              s(
                "principle-chords",
                ".editor-panel-wrapper",
                tx(
                  "2. Akkordmenet",
                  "Lehetőség szerint a dalszöveg mellett a teljes akkordmenet is kerüljön rögzítésre, hogy a közösségi adatbázis jól használható maradjon.",
                  "2. Chord progression",
                  "Whenever possible, enter the complete chord progression as well as the lyrics so the shared database remains useful."
                )
              ),
              s(
                "principle-existing",
                ".editor-panel-wrapper",
                tx(
                  "3. Meglévő dal",
                  "Egyéni használat miatt az adatbázis dala ne kapjon más transzponálást vagy címet. Ilyen javítást csak az eredeti szerző szerinti adatok helyreállítása indokol.",
                  "3. Existing songs",
                  "Do not transpose or rename a database song for personal use. Such a correction is appropriate only when restoring the author's original data."
                )
              ),
              s(
                "principle-duplicate",
                ".editor-panel-wrapper",
                tx(
                  "4. Ismétlődő dalrészek nélkül",
                  "Az ismétlések és az előadási sorrend leírására instrukciók szolgálnak; a dalrészek másolása kerülendő.",
                  "4. Do not duplicate sections",
                  "Describe repeats and performance order with instructions instead of copying song sections."
                )
              ),
              s(
                "principle-lyrics",
                ".editor-panel-wrapper",
                tx(
                  "5. Csak dalszöveg",
                  "A dalszövegmező csak dalszöveget tartalmazzon. Az előadási utasítások és megjegyzések az instrukciókban szerepeljenek.",
                  "5. Lyrics only",
                  "Keep only lyrics in lyric fields. Put performance directions and notes in instructions."
                )
              ),
              s(
                "principle-ellipsis",
                ".editor-panel-wrapper",
                tx(
                  "6. Ismétlődő sorvégek teljes kiírása",
                  "Az ismétlődő sorvégek ne legyenek „…” jellel helyettesítve; az előzővel egyező sor vagy dalrész is teljesen kiírandó.",
                  "6. Avoid ellipses",
                  "Do not replace repeated line endings with ‘…’; write the complete line or section even when it matches the previous one."
                )
              ),
              s(
                "principle-repeat-chords",
                ".editor-panel-wrapper",
                tx(
                  "7. Ismétlődő akkordok",
                  "A helyes pozíciókban az előzővel egyező akkordmenetet is rögzíteni kell. Az alkalmazás az ismétlést el tudja rejteni, de hiányzó pozíciókat nem képes kitalálni.",
                  "7. Repeated chords",
                  "Enter repeated chord progressions at their correct positions. The app can hide them, but cannot infer missing positions."
                )
              ),
              s(
                "principle-format",
                ".editor-panel-wrapper",
                tx(
                  "8. Ismert akkordformátum",
                  "Csak felismert akkordjelölés használható, különben a transzponálás és a capo kezelése hibás lesz. Hiányzó, szabályos akkordtípust a fejlesztőnek kell jelezni.",
                  "8. Recognized chord syntax",
                  "Use recognized chord notation so transpose and capo work correctly. Report a valid but unsupported chord type to the operator."
                )
              ),
            ],
          },
        ],
      }
    ),
    s(
      "sections",
      ".preview-sections-container",
      tx(
        "Szakaszlista",
        "A feldolgozott dal vetíthető egységei itt jelennek meg. Egy szakasz kijelölhető vetítéshez, a jelölőnégyzettel pedig részek zárhatóak ki a navigációból.",
        "Section list",
        "The projectable sections of the processed song appear here. Select a section for projection or use checkboxes to omit sections."
      ),
      {
        prepare: preview,
        details: [
          s(
            "projection-settings",
            ".preview-button-column button[aria-label='Settings']",
            tx(
              "Vetítési beállítások",
              "A vetítési kimenet részletes beállításait nyitja meg, amikor ez a gomb az aktuális elrendezésben látható.",
              "Projection settings",
              "Open detailed projection output settings when this button is present in the current layout."
            ),
            { helpIcons: [IconType.SETTINGS] }
          ),
          s(
            "sections-items",
            ".preview-sections-list",
            tx(
              "Szakaszok",
              "A színek a szakasz típusát és vetítési módját jelzik; az ismétlésjelző az aktuális kör helyét mutatja.",
              "Sections",
              "Colors indicate section type and projection mode; the repeat indicator shows the current pass."
            )
          ),
          s(
            "sections-checkbox",
            ".section-checkbox",
            tx(
              "Kihagyás",
              "A jelölőnégyzettel egy szakasz az adatbázis módosítása nélkül kihagyható a vetítésből.",
              "Omit",
              "Uncheck a section to omit it from projection without modifying the database song."
            ),
            { helpIcons: [{ label: "☑" }, { label: "☐" }] }
          ),
          s(
            "sections-keys",
            ".preview-sections-list",
            tx(
              "Billentyűzet",
              "A gyári kiosztásban a fókuszban lévő szakaszlistán a nyilak, Page Up/Down, Szóköz, Home és End navigálnak; a számok közvetlenül választanak, az Esc törli a kijelölést. A Hardveres vezérlés lapon saját profil és eltérő billentyűhatókör is választható.",
              "Keyboard",
              "With the factory mapping and section-list focus, arrows, Page Up/Down, Space, Home and End navigate; number keys select directly and Escape clears selection. Hardware control settings allow custom profiles and keyboard scope."
            )
          ),
        ],
      }
    ),
    s(
      "projection",
      ".preview-button-column",
      tx(
        "Vetítési kapcsolók",
        "A kijelző, szöveg, kép, háttér, tartalomalapú formázás, instrukciók, távoli irányítás, fagyasztás és üzenet gyorskapcsolói.",
        "Projection switches",
        "Quick controls for display output, text, image, background, content formatting, instructions, remote control, freeze and message."
      ),
      {
        prepare: preview,
        details: [
          s(
            "projection-display",
            ".preview-button-column button[aria-label='Display Enabled']",
            tx(
              "Kijelző engedélyezése",
              "Be- vagy kikapcsolja a külső vetítési kimenetet. Egyetlen monitor esetén korlátozott lehet.",
              "Enable display",
              "Turn the external projection output on or off. It may be limited on a single-monitor system."
            ),
            { helpIcons: [IconType.DISPLAY] }
          ),
          s(
            "projection-text",
            ".preview-button-column button[aria-label='Display Text']",
            tx("Dalszöveg", "A dalszöveg kivetítését kapcsolja be vagy ki.", "Lyrics", "Toggle lyrics on the projection output."),
            { helpIcons: [IconType.TEXT] }
          ),
          s(
            "projection-image",
            ".preview-button-column button[aria-label='Display Image']",
            tx(
              "Háttérkép",
              "A kiválasztott háttérkép megjelenítését kapcsolja be vagy ki.",
              "Background image",
              "Toggle the selected background image on the output."
            ),
            { helpIcons: [IconType.IMAGE] }
          ),
          s(
            "projection-background",
            ".preview-button-column [aria-label='Background Color']",
            tx("Háttérszín", "A kép nélküli háttér színét választja ki.", "Background color", "Choose the background color used without an image."),
            { helpIcons: [IconType.BG_COLOR] }
          ),
          s(
            "projection-content-format",
            ".preview-button-column button[aria-label='Content Based Format']",
            tx(
              "Tartalomalapú formázás",
              "A vetítés szakasztördelését automatikusan, a dal tartalma alapján végzi.",
              "Content-based formatting",
              "Apply automatic section breaks according to the song's content."
            ),
            { helpIcons: [IconType.CONTENT_FORMAT] }
          ),
          s(
            "projection-instructions",
            ".preview-button-column button[aria-label='Project Instructions']",
            tx(
              "Instrukciók szerinti lista",
              "Az előadási instrukciókból felépített sorrendet kapcsolja a szakaszlistára.",
              "Instruction-based list",
              "Use performance instructions to build the order shown in the section list."
            ),
            { helpIcons: [IconType.INSTRUCTIONS] }
          ),
          s(
            "projection-remote-control",
            ".preview-button-column button[aria-label='Remote Control']",
            tx(
              "Távoli irányítás",
              "Engedélyezi vagy letiltja, hogy egy jogosult kliens távolról váltson a vetített szakaszok között. A kliens aktivitását jelző tablet kikapcsolt állapotban is látható marad; közvetlen kérésnél az időtúllépés a Vetítés beállításainak végén módosítható.",
              "Remote control",
              "Allow or block an authorized client from changing projected sections remotely. The tablet activity indicator remains visible while this switch is off; its direct-request timeout is configurable at the end of Projecting settings."
            ),
            { helpIcons: [IconType.REMOTE_CONTROL] }
          ),
          s(
            "projection-freeze",
            ".preview-button-column button[aria-label='Freeze']",
            tx(
              "Fagyasztás",
              "A vetítőn megtartja a jelenlegi képet, miközben az alkalmazásban előkészíthető a következő tartalom.",
              "Freeze",
              "Keep the current output visible while preparing the next content in the app."
            ),
            { helpIcons: [IconType.FREEZE] }
          ),
          s(
            "projection-message",
            ".preview-button-column button[aria-label='Message']",
            tx(
              "Üzenet",
              "A Formátum terület Üzenet lapján megadott rövid szöveget kapcsolja a kimenetre.",
              "Message",
              "Toggle the short text entered on the Message tab onto the output."
            ),
            { helpIcons: [IconType.MESSAGE] }
          ),
        ],
      }
    ),
    s(
      "format",
      ".projecting-formats-container",
      tx(
        "Formátum és tartalom",
        "A Formátum, Kép, Üzenet és Vezérlők lapok a kivetített tartalom megjelenésének és kiegészítő elemeinek beállítására szolgálnak.",
        "Format and content",
        "Use the Format, Image, Message and Controls tabs to configure projected appearance and additional content."
      ),
      {
        prepare: preview,
        details: [
          s(
            "format-text",
            [".format-columns", ".preview-tab-content"],
            tx(
              "Szövegformátum",
              "Betűtípus, méret, stílus, szín és igazítás állítható. Ezek a megjelenést változtatják, nem a dal szövegét.",
              "Text format",
              "Set font, size, style, color and alignment. These affect presentation, not the song text."
            ),
            {
              helpIcons: [
                "fa fa-paint-brush",
                IconType.BOLD,
                IconType.ITALIC,
                IconType.UNDERLINE,
                IconType.ALIGN_LEFT,
                IconType.ALIGN_CENTER,
                IconType.ALIGN_RIGHT,
              ],
              prepare: () => activatePreviewTab(0),
            }
          ),
          s(
            "format-image",
            ".preview-tab-content",
            tx(
              "Kép",
              "Háttér, illesztési mód és képhez kapcsolódó beállítások választhatók.",
              "Image",
              "Choose a background, fit mode and image-related settings."
            ),
            { helpIcons: ["fa fa-picture-o"], prepare: () => activatePreviewTab(1) }
          ),
          s(
            "format-message",
            [".message-textarea", ".preview-tab-content"],
            tx(
              "Üzenet",
              "Itt írható be a dal helyett megjelenő rövid üzenet, amely a külön Üzenet kapcsolóval jeleníthető meg.",
              "Message",
              "Write a short message here and show it with the separate Message toggle."
            ),
            { helpIcons: ["fa fa-comment-o"], prepare: () => activatePreviewTab(2) }
          ),
          s(
            "format-controls",
            [".preview-controls-grid", ".preview-tab-content"],
            tx(
              "Vezérlők",
              "A kivetítési és kijelzővezérlők ezen a lapon jelennek meg, a gombok a szakaszlistán használható billentyűzet gombok funkcióit implementálják.",
              "Controls",
              "Projection and display controls appear on this tab; the buttons implement the functions of the keyboard controls available in the section list."
            ),
            {
              helpIcons: [
                "fa fa-arrows",
                "fa fa-step-backward",
                "fa fa-angle-double-up",
                "fa fa-arrow-up",
                "fa fa-undo",
                "fa fa-step-forward",
                "fa fa-angle-double-down",
                "fa fa-arrow-down",
                "fa fa-sign-in",
              ],
              prepare: () => activatePreviewTab(3),
            }
          ),
          s(
            "format-collapse",
            ".preview-layout-cycle-btn",
            tx(
              "Panel elrendezése",
              "Ezzel több lépésben összecsukhatók a beállítások vagy az előnézet, hogy több hely maradjon a fontos területnek.",
              "Panel layout",
              "Cycle through collapsed layouts to give more room to either settings or the preview."
            ),
            { helpIcons: ["fa fa-columns fa-rotate-90", "fa fa-window-maximize", "fa fa-window-minimize"] }
          ),
        ],
      }
    ),
    s(
      "preview",
      ".preview-display-container",
      tx(
        "Vetítési előnézet",
        "Az előnézet a kivetítésre kerülő kép ellenőrzésére szolgál; megosztható cím esetén QR-kódot is megjeleníthet.",
        "Projection preview",
        "Check the exact projected image here. When a shareable address exists, the preview can also show a QR code."
      ),
      {
        prepare: preview,
        details: [
          s(
            "preview-content",
            ".preview-display-container",
            tx(
              "Renderelt kép",
              "Az előnézet a pillanatnyi szakaszt, formázást, hátteret, kiemelést és üzenetet együtt mutatja.",
              "Rendered output",
              "The preview combines the current section, formatting, background, highlight and message."
            )
          ),
          s(
            "preview-qr",
            [".qr-code-overlay", ".preview-display-container"],
            tx(
              "QR-kód",
              "A QR-kód helyzete és mérete az előnézeten állítható; a részletes méretvezérlő külön is megnyitható.",
              "QR code",
              "The QR code's position and size can be adjusted on the preview; a detailed size control is also available."
            )
          ),
          s(
            "preview-resize",
            ".preview-display-container",
            tx(
              "Terület méretezése",
              "A vízszintes elválasztóval a szakaszlista és az előnézet területaránya állítható.",
              "Resize area",
              "Use the horizontal divider to change the space allocated to the section list and preview."
            )
          ),
        ],
      }
    ),
  ],
};
