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
  version: 2,
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
              "A fiók választja ki a helyi és felhős adatbázist. A felhasználó vezérlővel bejelentkezhetsz, fiókot válthatsz vagy kijelentkezhetsz.",
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
              "Az ↑ a helyi, feltöltésre váró, a ↓ a letöltendő változatokat jelzi. A piros jelvény ellenőrzendő dalra, a hibajel új bejelentkezésre figyelmeztet.",
              "Status badges",
              "↑ marks local changes waiting to upload and ↓ marks downloads. A red badge means songs need review; an error badge asks you to sign in again."
            )
          ),
          s(
            "sync-menu",
            [".sync-dropdown-menu", ".sync-menu-toggle"],
            tx(
              "Szinkronizálási menü",
              "A menüben dalellenőrzés, exportálás, importálás és teljes adatbáziscsere is található. Az importálás és csere adatot módosít, ezért a bemutató ezeket nem indítja el.",
              "Synchronization menu",
              "The menu also contains song review, export, import and complete database replacement. Import and replacement modify data, so the tutorial never starts them."
            ),
            { prepare: () => clickVisible(".sync-menu-toggle") }
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
              "Helyi, webes és felhős kapcsolatokat indíthatsz vagy követhetsz más eszközökkel.",
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
        "A dalkönyvtárban kereshetsz, szűrhetsz és csoportosíthatsz. A kiválasztott dal szerkeszthető, illetve a műsortárhoz adható és vetíthető.",
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
              "Válts az összes, a kedvelt, illetve a figyelmen kívül hagyott dalokat is tartalmazó nézet között.",
              "Preference filter",
              "Switch between all songs, preferred songs and a view that also includes ignored songs."
            )
          ),
          s(
            "song-search",
            ".song-filter-input",
            tx(
              "Keresés",
              "Címre, dalszövegre vagy – a beállított módtól függően – más metaadatra is kereshetsz.",
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
              "A mappák összetartozó változatokat jelölnek. A dalokat másik dalhoz csoportosíthatod vagy a műsortárhoz adhatod.",
              "Songs and groups",
              "Folders represent related versions. Songs can be grouped with another song or added to the playlist."
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
        "Itt állíthatod össze az előadás sorrendjét. A dalonkénti transzponálás, capo, saját cím és instrukció nem írja át az eredeti dalt.",
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
              "A kiválasztott dal megjelenik; több sor együtt is kijelölhető és átrendezhető.",
              "Playlist rows",
              "The selected song is displayed; multiple rows can be selected together and reordered."
            )
          ),
          s(
            "playlist-load",
            ".playlist-buttons button[aria-label='Load Playlist']",
            tx(
              "Műsortár betöltése",
              "Vezetői profilnál ütemezett listát, más módban mentett fájlt tölthetsz be.",
              "Load playlist",
              "Load a scheduled leader list or a saved file, depending on the active mode."
            )
          ),
          s(
            "playlist-save",
            ".playlist-buttons button[aria-label='Save Playlist']",
            tx(
              "Műsortár mentése",
              "A munkalistát a vezetői profilhoz vagy fájlba menti az aktív módtól függően.",
              "Save playlist",
              "Save the working list to the leader profile or a file, depending on the active mode."
            )
          ),
          s(
            "playlist-up",
            ".playlist-buttons button[aria-label='Move Up']",
            tx(
              "Mozgatás felfelé",
              "A kijelölt műsortételeket egy hellyel előrébb mozgatja.",
              "Move up",
              "Move the selected playlist entries one position earlier."
            )
          ),
          s(
            "playlist-down",
            ".playlist-buttons button[aria-label='Move Down']",
            tx(
              "Mozgatás lefelé",
              "A kijelölt műsortételeket egy hellyel hátrébb mozgatja.",
              "Move down",
              "Move the selected playlist entries one position later."
            )
          ),
          s(
            "playlist-transpose-up",
            ".playlist-buttons button[aria-label='Transpose Up']",
            tx(
              "Transzponálás felfelé",
              "A kijelölt műsortételek saját transzponálását egy félhanggal emeli.",
              "Transpose up",
              "Raise the per-entry transpose of selected playlist items by one semitone."
            )
          ),
          s(
            "playlist-transpose-down",
            ".playlist-buttons button[aria-label='Transpose Down']",
            tx(
              "Transzponálás lefelé",
              "A kijelölt műsortételek saját transzponálását egy félhanggal csökkenti.",
              "Transpose down",
              "Lower the per-entry transpose of selected playlist items by one semitone."
            )
          ),
          s(
            "playlist-capo-up",
            ".playlist-buttons button[aria-label='Capo Up']",
            tx(
              "Capo növelése",
              "A kijelölt műsortételek capo-értékét növeli.",
              "Increase capo",
              "Increase the capo value of selected playlist entries."
            )
          ),
          s(
            "playlist-capo-down",
            ".playlist-buttons button[aria-label='Capo Down']",
            tx(
              "Capo csökkentése",
              "A kijelölt műsortételek capo-értékét csökkenti.",
              "Decrease capo",
              "Decrease the capo value of selected playlist entries."
            )
          ),
          s(
            "playlist-pitch",
            ".playlist-items-container",
            tx(
              "Transzponálás és capo",
              "A T és C érték műsortételenként tárolódik, így ugyanaz a dal alkalmonként más hangnemben használható.",
              "Transpose and capo",
              "T and C are stored per playlist entry, so the same song can use a different key for each event."
            )
          ),
          s(
            "playlist-instructions",
            ".playlist-items-container",
            tx(
              "Cím és instrukciók",
              "A műsortétel saját címet és előadási instrukciót kaphat az adatbázisban lévő dal átírása nélkül.",
              "Title and instructions",
              "A playlist entry can have its own title and performance instructions without changing the database song."
            )
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
              "A kijelölt tétel saját címét, transzponálását, capóját és instrukcióit szerkesztheted.",
              "Edit playlist entry",
              "Edit the selected entry's custom title, transpose, capo and instructions."
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
              "A Forrás, Szerkesztő és Előnézet panelek összecsukhatók. Törölhetsz, visszaállíthatsz, menthetsz, és a változatot a vezető profiljában is tárolhatod.",
              "Instructions editor",
              "Source, Editor and Preview panes can be collapsed. Clear, reset and save the text, optionally storing it in the leader profile."
            )
          ),
          s(
            "playlist-keyboard",
            ".playlist-items-container",
            tx(
              "Billentyűzet",
              "Shift-tel bővítheted a kijelölést, Ctrl/Cmd+A mindent kijelöl. Delete töröl, Ctrl+Fel/Le átrendez, Alt+Fel/Le transzponál; a műveletek visszavonhatók.",
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
        "Innen töltheted újra és mentheted a dalt, indíthatsz új dalt vagy importálást, nyomtathatsz, client-view-ra válthatsz és megnyithatod a beállításokat.",
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
            tx(
              "Dal mentése",
              "Rögzíti az aktuális szerkesztést a saját daladatbázisodban.",
              "Save song",
              "Store the current edit in your own song database."
            )
          ),
          s(
            "toolbar-new",
            ".btn-toolbar button[aria-label='New Song']",
            tx(
              "Új dal",
              "Egy új, üres dal létrehozásával közvetlenül a szerkesztőben kezdhetsz dolgozni.",
              "New song",
              "Create an empty song and start working directly in the editor."
            )
          ),
          s(
            "toolbar-import",
            ".btn-toolbar button[aria-label='Import from Word']",
            tx(
              "Importálás",
              "Szöveg-, ChordPro-, Word- vagy PDF-forrásból a többlépéses importáló készít ellenőrizhető dalbejegyzést.",
              "Import",
              "The multi-step importer builds a reviewable song from text, ChordPro, Word or PDF sources."
            )
          ),
          s(
            "toolbar-print",
            ".btn-toolbar button[aria-label='Print']",
            tx(
              "Nyomtatás",
              "Az aktuális dalt külön nyomtatási előnézetben nyithatod meg.",
              "Print",
              "Open the current song in a dedicated print preview."
            )
          ),
          s(
            "toolbar-client",
            ".btn-toolbar button[aria-label='Mobile View']",
            tx(
              "Client-view",
              "Válts az előadás közbeni, egyszerűsített client-view felületre. A lenti gombbal a bemutató közvetlenül ott folytatódik.",
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
              "A keresés, vetítés, képek, vezetők, szakaszok, ChordPro-stílusok, client-view vezérlés és hálózati funkciók itt szabhatók személyre.",
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
              "A vizuális nézetben a dalszöveget és az akkordokat a kész megjelenéshez hasonló formában szerkesztheted.",
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
              "A kijelölt sorokat hangszeres akkordrácsként jelöli.",
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
              "A kurzornál új ABC-kottablokkot szúr be. A már meglévő ABC-blokk megnyitva tovább szerkeszthető.",
              "ABC notation",
              "Insert a new ABC notation block at the caret. Existing ABC blocks can be opened for further editing."
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
          s(
            "editor-navigation",
            ".editor-iframe-container",
            tx(
              "Dalok lapozása",
              "Szerkesztési módon kívül a lapozási művelettel az előző vagy következő dalra léphetsz. Szerkesztés közben a dalváltás le van tiltva, hogy ne szakítsa meg a munkát.",
              "Song paging",
              "Outside edit mode, paging moves to the previous or next song. Song switching is disabled while editing so it cannot interrupt your work."
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
                  "Bejelentkezés után szinkronizálhatsz, új dalokat és javításokat küldhetsz be. Saját adatbázisodban a változás azonnal él; a publikus adatbázisba csak üzemeltetői jóváhagyás után kerül.",
                  "Online editing",
                  "After signing in you can synchronize and submit new songs or corrections. Changes apply to your own database immediately and reach the public database only after operator approval."
                )
              ),
              s(
                "principle-key",
                ".editor-panel-wrapper",
                tx(
                  "1. Eredeti hangnem",
                  "Nem saját szerzeményt az eredeti hangnemben rögzíts. A saját előadási hangnemhez transzponálást és vezetői profilt használj.",
                  "1. Original key",
                  "Store songs you did not write in their original key. Use transpose and leader profiles for your performance key."
                )
              ),
              s(
                "principle-chords",
                ".editor-panel-wrapper",
                tx(
                  "2. Akkordmenet",
                  "Ha lehetséges, a dalszöveg mellett a teljes akkordmenetet is rögzítsd, hogy a közösségi adatbázis jól használható legyen.",
                  "2. Chord progression",
                  "Whenever possible, enter the complete chord progression as well as the lyrics so the shared database remains useful."
                )
              ),
              s(
                "principle-existing",
                ".editor-panel-wrapper",
                tx(
                  "3. Meglévő dal",
                  "Egyéni használat miatt ne transzponáld és ne nevezd át az adatbázis dalát. Csak az eredeti szerző szerinti adat helyreállítása indokol ilyen javítást.",
                  "3. Existing songs",
                  "Do not transpose or rename a database song for personal use. Such a correction is appropriate only when restoring the author's original data."
                )
              ),
              s(
                "principle-duplicate",
                ".editor-panel-wrapper",
                tx(
                  "4. Ne duplikálj részeket",
                  "Az ismétléseket és az előadás sorrendjét instrukciókkal add meg, ne a dalrészek másolásával.",
                  "4. Do not duplicate sections",
                  "Describe repeats and performance order with instructions instead of copying song sections."
                )
              ),
              s(
                "principle-lyrics",
                ".editor-panel-wrapper",
                tx(
                  "5. Csak dalszöveg",
                  "A dalszövegmezőbe csak dalszöveg kerüljön. Előadási utasításokat és megjegyzéseket az instrukciókban tárolj.",
                  "5. Lyrics only",
                  "Keep only lyrics in lyric fields. Put performance directions and notes in instructions."
                )
              ),
              s(
                "principle-ellipsis",
                ".editor-panel-wrapper",
                tx(
                  "6. Ne használj három pontot",
                  "Ne helyettesíts ismétlődő sorvéget „…” jellel; akkor is írd ki a teljes sort vagy dalrészt, ha az előzővel megegyezik.",
                  "6. Avoid ellipses",
                  "Do not replace repeated line endings with ‘…’; write the complete line or section even when it matches the previous one."
                )
              ),
              s(
                "principle-repeat-chords",
                ".editor-panel-wrapper",
                tx(
                  "7. Ismétlődő akkordok",
                  "Az előzővel egyező akkordmenetet is add meg a helyes pozíciókban. Az alkalmazás elrejtheti, de a hiányzó pozíciókat nem tudja kitalálni.",
                  "7. Repeated chords",
                  "Enter repeated chord progressions at their correct positions. The app can hide them, but cannot infer missing positions."
                )
              ),
              s(
                "principle-format",
                ".editor-panel-wrapper",
                tx(
                  "8. Ismert akkordformátum",
                  "Csak felismert akkordjelölést használj, különben a transzponálás és capo-kezelés hibás lesz. Hiányzó, szabályos akkordtípust jelezz az üzemeltetőnek.",
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
        "A feldolgozott dal vetíthető egységei itt jelennek meg. Válassz egy szakaszt a vetítéshez, a jelölőnégyzettel pedig kihagyhatsz részeket.",
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
              "A jelölőnégyzettel egy szakaszt az adatbázis módosítása nélkül kihagyhatsz a vetítésből.",
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
          s(
            "sections-highlight",
            ".preview-sections-list",
            tx(
              "Kiemelés",
              "Megfelelő jogosultsággal egy dalszövegrészt kijelölve kiemelést küldhetsz a kapcsolódó kijelzőkre.",
              "Highlight",
              "With the required permission, select lyrics to send a highlight to connected displays."
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
        "A Formátum, Kép, Üzenet és Vezérlők lapokkal a kivetített tartalom megjelenését és kiegészítő elemeit állíthatod.",
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
              "Válassz hátteret, illesztési módot és képhez kapcsolódó beállításokat.",
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
              "A dal fölött megjelenő rövid üzenetet itt írhatod meg; a külön Üzenet kapcsolóval teheted láthatóvá.",
              "Message",
              "Write a short overlay message here and show it with the separate Message toggle."
            ),
            { prepare: () => activatePreviewTab(2) }
          ),
          s(
            "format-controls",
            [".preview-controls-grid", ".preview-tab-content"],
            tx(
              "Vezérlők",
              "A környezettől függő kivetítési és kijelzővezérlők ezen a lapon jelennek meg.",
              "Controls",
              "Runtime-dependent projection and display controls appear on this tab."
            ),
            { prepare: () => activatePreviewTab(3) }
          ),
          s(
            "format-collapse",
            ".preview-layout-cycle-btn",
            tx(
              "Panel elrendezése",
              "Ezzel több lépésben összecsukhatod a beállításokat vagy az előnézetet, hogy több hely maradjon a fontos területnek.",
              "Panel layout",
              "Cycle through collapsed layouts to give more room to either settings or the preview."
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
        "A kijelző, szöveg, kép, háttér, tartalomalapú formázás, instrukciók, fagyasztás és üzenet gyorskapcsolói.",
        "Projection switches",
        "Quick controls for display output, text, image, background, content formatting, instructions, freeze and message."
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
              "A dalban megadott szakaszformázásokat alkalmazza a vetítésre.",
              "Content-based formatting",
              "Apply section formatting defined by the song to the projection."
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
            "projection-freeze",
            ".preview-button-column button[aria-label='Freeze']",
            tx(
              "Fagyasztás",
              "A kimeneten megtartja a jelenlegi képet, miközben az alkalmazásban előkészítheted a következőt.",
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
      "preview",
      ".preview-display-container",
      tx(
        "Vetítési előnézet",
        "Itt ellenőrizheted a kivetítésre kerülő képet. Ha van megosztható cím, az előnézet QR-kódot is megjeleníthet.",
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
