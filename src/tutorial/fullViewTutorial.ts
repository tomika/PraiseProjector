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
  version: 3,
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
            )
          ),
          s(
            "sync-main",
            ".user-sync-group .user-sync-main-btn",
            tx(
              "Szinkronizálás indítása",
              "A főgomb elindítja az egyeztetést. Nem mentett dalszerkesztés esetén az alkalmazás előbb megerősítést kér.",
              "Start synchronization",
              "The main button starts synchronization. If a song has unsaved edits, the app asks for confirmation first."
            ),
            { actions: [{ id: "sync-now", label: tl("Szinkronizálás most", "Synchronize now"), command: "sync-now" }] }
          ),
          s(
            "sync-badges",
            ".user-sync-group",
            tx(
              "Állapotjelvények",
              "Az ↑ a helyi, feltöltésre váró, a ↓ a letöltendő változatokat jelzi. A piros jelvény ellenőrzendő dalra, a hibajel az online funkciók elérésének hiányára figyelmeztet.",
              "Status badges",
              "↑ marks local changes waiting to upload and ↓ marks downloads. A red badge means songs need review; an error badge warns you about a lack of online access."
            )
          ),
          s(
            "sync-menu",
            [".sync-dropdown-menu", ".sync-menu-toggle"],
            tx(
              "Szinkronizálási menü",
              "A menüben dalellenőrzés, exportálás, importálás és teljes adatbáziscsere is található.",
              "Synchronization menu",
              "The menu also contains song review, export, import and complete database replacement."
            ),
            { prepare: () => clickVisible(".sync-menu-toggle") }
          ),
          s(
            "profiles-leader-settings",
            "[data-tutorial-id='full-leader-settings']",
            tx(
              "Dicsőítésvezető és vezető mód",
              "Saját munkamenetben a gomb közvetlenül a Beállítások Dicsőítésvezetők oldalára visz. PPD-munkamenet követésekor, ha a házigazda engedélyezte, ugyanez a gomb a követő és vezető mód között vált; a kék kiemelés jelzi az aktív vezető módot.",
              "Worship leader and leader mode",
              "In your own session, the button opens the Leaders page in Settings. While following a PPD session, the same button switches between follower and leader mode when the host permits it; a blue highlight marks active leader mode."
            )
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
              "Ez a vezérlő helyi, webes és felhős kapcsolatok más eszközökkel való indítására és követésére szolgál.",
              "Sessions",
              "Start or follow local, web and cloud sessions with other devices."
            )
          ),
          s(
            "profiles-settings",
            ".user-sync-height-btn[aria-label='Settings']",
            tx(
              "Profil- és alkalmazásbeállítások",
              "A felület, vetítés, adatkezelés, stílusok és kapcsolatok részletes beállításai itt érhetők el.",
              "Profile and application settings",
              "Detailed interface, projection, data, style and connection settings are available here."
            )
          ),
        ],
      }
    ),
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
              "Ez a vezérlő az összes dal, a kedvelt dalok és a figyelmen kívül hagyott dalokat is megjelenítő nézet között vált.",
              "Preference filter",
              "Switch between all songs, preferred songs and a view that also includes ignored songs."
            )
          ),
          s(
            "song-search",
            ".song-filter-input",
            tx(
              "Keresés",
              "A keresés címre, dalszövegre, valamint a beállított módtól függően más metaadatra is kiterjedhet.",
              "Search",
              "Search by title, lyrics or other metadata, depending on your search settings."
            )
          ),
          s(
            "song-search-options",
            ".song-search-toggle-btn",
            tx(
              "Keresés finomítása",
              "A hagyományos keresésnél külön kapcsolható a hasonló szöveg, a kis- és nagybetű érzékenysége és a teljes szavak egyezése.",
              "Search options",
              "Traditional search can match similar text, respect letter case and require complete words."
            )
          ),
          s(
            "song-items",
            [".song-list-panel .song-item", ".song-list-panel"],
            tx(
              "Dalok és csoportok",
              "A mappák összetartozó változatokat jelölnek; a dalok csoportosítására és műsortárhoz adására is lehetőséget adnak.",
              "Songs and groups",
              "Folders represent related versions. Songs can be grouped with another song or added to the playlist."
            )
          ),
          s(
            "song-drag-and-drop",
            ".song-list-panel",
            tx(
              "Áthúzás és fájlimportálás",
              "A dal Műsortárba húzásával a kívánt pozícióba a listához adható. Külső fájl is behúzható a Dalkönyvtárba: az importáló a .chp, .txt, .pdf, .docx, .htm és .html formátumokat támogatja. Dalok egymásra vagy csoportmappára húzásával csoportok is létrehozhatók.",
              "Drag and drop",
              "Drag a song to the playlist to add it quickly. You can also drop external files into the song library: the importer supports .chp, .txt, .pdf, .docx, .htm and .html files. Drag songs onto another song or a group folder to group them."
            )
          ),
          s(
            "song-context",
            ".song-list-panel",
            tx(
              "Helyi menü",
              "A helyi menüben verzióelőzmények, csoportbontás, törlés, megosztás és vágólapos importálás érhető el.",
              "Context menu",
              "The context menu provides version history, ungrouping, deletion, sharing and clipboard import."
            )
          ),
          s(
            "song-keyboard",
            ".song-list-panel",
            tx(
              "Billentyűzet",
              "A nyilak, Page Up/Down, Szóköz, Home és End navigálnak. Enter megnyitja az alapértelmezett dalműveletet, Delete csoportot bont, Ctrl+V pedig vágólapról importál.",
              "Keyboard",
              "Use the arrows, Page Up/Down, Space, Home and End to navigate. Enter opens the default song action, Delete ungroups and Ctrl+V imports from the clipboard."
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
        "Itt állítható össze az előadás sorrendje. A dalonkénti transzponálás, capo, egyedi cím és instrukciók em módosítják az eredeti dalt.",
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
              "A Betöltés gomb vezetői profilhoz tartozó ütemezett lista vagy mentett fájl megnyitására szolgál. A Mentés a munkalistát az aktív módtól függően a vezetői profilhoz vagy fájlba tárolja.",
              "Load and save playlists",
              "Use Load to open a scheduled leader playlist or a saved file. Save stores the working list in the leader profile or in a file, depending on the active mode."
            ),
            {
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
            { highlightTargets: [".playlist-buttons button[aria-label='Move Up']", ".playlist-buttons button[aria-label='Move Down']"] }
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
            { highlightTargets: [".playlist-buttons button[aria-label='Capo Up']", ".playlist-buttons button[aria-label='Capo Down']"] }
          ),
          s(
            "playlist-remove",
            ".playlist-buttons button[aria-label='Remove']",
            tx(
              "Eltávolítás",
              "A kijelölt tételeket az aktuális műsortárból távolítja el; az adatbázis dalait nem törli.",
              "Remove",
              "Remove selected entries from the current playlist without deleting database songs."
            )
          ),
          s(
            "playlist-edit",
            ".playlist-buttons button[aria-label='Edit']",
            tx(
              "Műsortétel szerkesztése",
              "Ez a vezérlő a kijelölt műsortétel egyedi címének szerkesztésére szolgál.",
              "Edit playlist entry",
              "Edit the selected entry's custom title."
            )
          ),
          s(
            "playlist-add",
            ".playlist-buttons button[aria-label='Add']",
            tx(
              "Dal hozzáadása",
              "A dalkönyvtárban kijelölt dalt hozzáadja az aktuális műsortárhoz.",
              "Add song",
              "Add the selected library song to the current playlist."
            )
          ),
          s(
            "playlist-instructions",
            ".playlist-items-container",
            tx(
              "Cím és instrukciók",
              "A műsortétel saját címet és előadási instrukciót kaphat az adatbázisban lévő dal átírása nélkül. Az instrukciók szerkesztése sorvégi dupla kattintással is megnyitható.",
              "Title and instructions",
              "A playlist entry can have its own title and performance instructions without changing the database song. The instructions editor can be opened by double-clicking at the end of lines."
            )
          ),
          s(
            "playlist-context",
            ".playlist-items-container",
            tx(
              "Helyi menü és előzmények",
              "A jobb gombos menü transzponálást, capo-választást, kijelölést, visszavonást, ismétlést és – mentett listánál – megosztást kínál.",
              "Context menu and history",
              "The context menu offers transpose, capo, selection, undo, redo and sharing for saved lists."
            )
          ),
          s(
            "playlist-instruction-editor",
            ".playlist-items-container",
            tx(
              "Instrukciószerkesztő",
              "A Forrás, Szerkesztő és Előnézet panelek összecsukhatók. A szöveg törölhető, visszaállítható és menthető, a változat pedig a vezető profiljában is tárolható.",
              "Instructions editor",
              "Source, Editor and Preview panes can be collapsed. Clear, reset and save the text, optionally storing it in the leader profile."
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
        "Ez az eszköztár az aktuálus dal újratöltésére és mentésére, új dal vagy importálás indítására, nyomtatásra, kliens nézetre váltásra és a beállítások megnyitására szolgál.",
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
            )
          ),
          s(
            "toolbar-save",
            ".btn-toolbar button[aria-label='Save Song']",
            tx("Dal mentése", "Rögzíti az aktuális szerkesztést a dal adatbázisban.", "Save song", "Store the current edit in the song database.")
          ),
          s(
            "toolbar-new",
            ".btn-toolbar button[aria-label='New Song']",
            tx(
              "Új dal",
              "Ez a vezérlő új, üres dalt hoz létre, amely közvetlenül a szerkesztőben szerkeszthető.",
              "New song",
              "Create an empty song and start working directly in the editor."
            )
          ),
          s(
            "toolbar-import",
            ".btn-toolbar button[aria-label='Import from Word']",
            tx(
              "Importálás",
              "Szöveg-, ChordPro-, Word- vagy PDF-forrásból az importáló varázslót indít.",
              "Import",
              "Start the import wizard from text, ChordPro, Word or PDF sources."
            )
          ),
          s(
            "toolbar-print",
            ".btn-toolbar button[aria-label='Print']",
            tx("Nyomtatás", "Az aktuális dal nyomtatható ki itt.", "Print", "The current song can be printed here.")
          ),
          s(
            "toolbar-client",
            ".btn-toolbar button[aria-label='Mobile View']",
            tx(
              "Kliens nézet",
              "Az előadás közbeni használatra készült, egyszerűsített kliens nézetre vált. A lenti gombbal a bemutató közvetlenül ott folytatódik.",
              "Client view",
              "Switch to the streamlined client view for use during a performance. The action below continues the tutorial there."
            ),
            { actions: [{ id: "switch-client", label: tl("Kliens nézetre váltás", "Switch to client view"), command: "switch-client" }] }
          ),
          s(
            "toolbar-settings",
            ".btn-toolbar button[aria-label='Settings']",
            tx(
              "Beállítások",
              "A keresés, vetítés, képek, vezetők, szakaszok, ChordPro-stílusok, kliens jogosultság kezelés és hálózati funkciók itt szabhatók személyre.",
              "Settings",
              "Customize search, projection, images, leaders, sections, ChordPro styles, client controls and network features."
            )
          ),
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
              "A ceruza vált az olvasási és szerkesztési mód között. Kilépéskor az alkalmazás ellenőrzi a változásokat.",
              "Edit mode",
              "The pencil switches between reading and editing. On exit, the app checks for changes."
            )
          ),
          s(
            "editor-wysiwyg",
            ".editor-tabs-header .nav-item:nth-child(1) .nav-link",
            tx(
              "Dal szerkesztő",
              "A vizuális nézetben a dalszöveg és az akkordok a kész megjelenéshez hasonló formában szerkeszthetők.",
              "Song editor",
              "Edit lyrics and chords in a visual layout that resembles the finished song."
            )
          ),
          s(
            "editor-title",
            ".editor-toolbar button:nth-child(1)",
            tx("Cím", "A kijelölt szöveget a dal címévé alakítja.", "Title", "Turn the selected text into the song title.")
          ),
          s(
            "editor-verse",
            ".editor-toolbar button:nth-child(2)",
            tx("Versszak", "A kijelölt sorokat számozott versszakként jelöli.", "Verse", "Mark the selected lines as a numbered verse.")
          ),
          s(
            "editor-chorus",
            ".editor-toolbar button:nth-child(3)",
            tx("Refrén", "A kijelölt sorokat refrénként jelöli.", "Chorus", "Mark the selected lines as a chorus.")
          ),
          s(
            "editor-bridge",
            ".editor-toolbar button:nth-child(4)",
            tx("Híd", "A kijelölt sorokat hídként jelöli.", "Bridge", "Mark the selected lines as a bridge.")
          ),
          s(
            "editor-grid",
            ".editor-toolbar button:nth-child(5)",
            tx(
              "Akkordrács",
              "A kijelölt sorokat csak hangszeres akkordmenetként jelöli.",
              "Chord grid",
              "Mark the selected lines as an instrumental chord grid."
            )
          ),
          s(
            "editor-comment",
            ".editor-toolbar button:nth-child(6)",
            tx(
              "Megjegyzés",
              "A kijelölt, akkordot nem tartalmazó sorokat megjegyzéssé alakítja, illetve visszaalakítja normál dalszöveggé. Akkordos kijelölésnél a gomb le van tiltva.",
              "Comment",
              "Toggle selected chord-free lines between comments and normal lyrics. The button is disabled when the selection contains chords."
            )
          ),
          s(
            "editor-abc",
            ".editor-toolbar button:nth-child(7)",
            tx(
              "ABC-kotta",
              "A kurzornál új ABC-kottablokkot szúr be. A már meglévő ABC-blokk azon dupla kattintással megnyitva tovább szerkeszthető.",
              "ABC notation",
              "Insert a new ABC notation block at the caret. Existing ABC blocks can be opened for further editing by double-clicking them."
            )
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
            ".editor-tabs-header .nav-item:nth-child(2) .nav-link",
            tx(
              "Meta adatok",
              "Itt kezelhető többek között a cím, előadó, szerző, hangnem, tempó, ütem és capo. Mentéshez a cím kitöltése szükséges.",
              "Metadata",
              "Edit title, artist, author, key, tempo, time signature, capo and other metadata here. A title is required before saving."
            )
          ),
          s(
            "editor-chordpro",
            ".editor-tabs-header .nav-item:nth-child(3) .nav-link",
            tx(
              "ChordPro kód",
              "A nyers ChordPro nézet teljes hozzáférést ad a dal direktíváihoz és jelöléseihez, amikor a vizuális nézetnél pontosabb vezérlés szükséges.",
              "ChordPro source",
              "The raw ChordPro view gives complete access to directives and notation when you need more control than the visual editor provides."
            )
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
            )
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
            )
          ),
          s(
            "sections-keys",
            ".preview-sections-list",
            tx(
              "Billentyűzet",
              "A nyilak, Page Up/Down, Szóköz, Home és End navigálnak; a számok közvetlenül választanak, az Esc törli a kijelölést.",
              "Keyboard",
              "Arrows, Page Up/Down, Space, Home and End navigate; number keys select directly and Escape clears selection."
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
            )
          ),
          s(
            "projection-text",
            ".preview-button-column button[aria-label='Display Text']",
            tx("Dalszöveg", "A dalszöveg kivetítését kapcsolja be vagy ki.", "Lyrics", "Toggle lyrics on the projection output.")
          ),
          s(
            "projection-image",
            ".preview-button-column button[aria-label='Display Image']",
            tx(
              "Háttérkép",
              "A kiválasztott háttérkép megjelenítését kapcsolja be vagy ki.",
              "Background image",
              "Toggle the selected background image on the output."
            )
          ),
          s(
            "projection-background",
            ".preview-button-column [aria-label='Background Color']",
            tx("Háttérszín", "A kép nélküli háttér színét választja ki.", "Background color", "Choose the background color used without an image.")
          ),
          s(
            "projection-content-format",
            ".preview-button-column button[aria-label='Content Based Format']",
            tx(
              "Tartalomalapú formázás",
              "A vetítés szakasztördelését automatikusan, a dal tartalma alapján végzi.",
              "Content-based formatting",
              "Apply automatic section breaks according to the song's content."
            )
          ),
          s(
            "projection-instructions",
            ".preview-button-column button[aria-label='Project Instructions']",
            tx(
              "Instrukciók szerinti lista",
              "Az előadási instrukciókból felépített sorrendet kapcsolja a szakaszlistára.",
              "Instruction-based list",
              "Use performance instructions to build the order shown in the section list."
            )
          ),
          s(
            "projection-remote-control",
            ".preview-button-column button[aria-label='Remote Control']",
            tx(
              "Távoli irányítás",
              "Engedélyezi vagy letiltja, hogy egy jogosult kliens távolról váltson a vetített szakaszok között. A kliens aktivitását jelző tablet kikapcsolt állapotban is látható marad; közvetlen kérésnél az időtúllépés a Vetítés beállításainak végén módosítható.",
              "Remote control",
              "Allow or block an authorized client from changing projected sections remotely. The tablet activity indicator remains visible while this switch is off; its direct-request timeout is configurable at the end of Projecting settings."
            )
          ),
          s(
            "projection-freeze",
            ".preview-button-column button[aria-label='Freeze']",
            tx(
              "Fagyasztás",
              "A vetítőn megtartja a jelenlegi képet, miközben az alkalmazásban előkészíthető a következő tartalom.",
              "Freeze",
              "Keep the current output visible while preparing the next content in the app."
            )
          ),
          s(
            "projection-message",
            ".preview-button-column button[aria-label='Message']",
            tx(
              "Üzenet",
              "A Formátum terület Üzenet lapján megadott rövid szöveget kapcsolja a kimenetre.",
              "Message",
              "Toggle the short text entered on the Message tab onto the output."
            )
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
            { prepare: () => activatePreviewTab(0) }
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
            { prepare: () => activatePreviewTab(1) }
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
            { prepare: () => activatePreviewTab(2) }
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
            { prepare: () => activatePreviewTab(3) }
          ),
          s(
            "format-collapse",
            ".preview-layout-cycle-btn",
            tx(
              "Panel elrendezése",
              "Ezzel több lépésben összecsukhatók a beállítások vagy az előnézet, hogy több hely maradjon a fontos területnek.",
              "Panel layout",
              "Cycle through collapsed layouts to give more room to either settings or the preview."
            )
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
