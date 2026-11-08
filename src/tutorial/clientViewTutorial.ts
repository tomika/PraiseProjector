import type { TutorialDefinition } from "./tutorialTypes";
import {
  closeClientTutorialPopovers,
  closeClientZoomPanel,
  ensureClientOptions,
  ensureClientListMode,
  openClientMoreMenu,
  openClientTutorialValuePicker,
  openClientZoomPanel,
  tutorialLabel as tl,
  tutorialStep as s,
  tutorialText as tx,
} from "./tutorialDefinitionHelpers";

const song = () => ensureClientOptions(false);
const options = () => {
  ensureClientOptions(true);
  closeClientZoomPanel();
};
const databaseList = () => {
  options();
  return ensureClientListMode("database");
};
const playlistList = () => {
  options();
  return ensureClientListMode("playlist");
};
const leaderLists = () => {
  options();
  return ensureClientListMode("leaderlists");
};

export const clientViewTutorial: TutorialDefinition = {
  view: "client",
  version: 5,
  cleanup: closeClientTutorialPopovers,
  steps: [
    s(
      "song-view",
      ["#swipe-handler", "#editor"],
      tx(
        "Dalnézet",
        "Itt jelenik meg az aktuális dal ChordPro-formázással, akkordokkal, kottával és instrukciókkal. A lapozási vezérlővel lehet a dalok között váltani.",
        "Song view",
        "The current song appears here with ChordPro formatting, chords, notation and instructions. Use paging controls to change songs."
      ),
      {
        prepare: song,
        details: [
          s(
            "song-content",
            "#editor",
            tx(
              "Dal tartalma",
              "A megjelenés az akkord-, capo-, transzponálás-, téma- és nagyításbeállításokat követi. Követő módban a vezető aktuális dala látható.",
              "Song content",
              "Appearance follows chord, capo, transpose, theme and zoom settings. In follower mode you see the leader's song."
            )
          ),
          s(
            "song-score-playback",
            "#editor",
            tx(
              "Kotta és lejátszás",
              "A látható ABC-kottára dupla kattintva vagy duplán koppintva a MIDI-lejátszás elindul, újabb dupla kattintásra leáll. A Nagyítás panelen a kottanézet dalszöveg és akkordok megjelenítésére váltható; ez az eredeti dalt nem írja át.",
              "Notation and playback",
              "Double-click or double-tap visible ABC notation to start MIDI playback, and repeat to stop. The Zoom panel can show lyrics and chords in place of notation without changing the original song."
            )
          ),
          s(
            "song-paging",
            "#swipe-handler",
            tx(
              "Lapozás",
              "A lapozási művelet és a vezérlősáv előző/következő gombjai ugyanazt a lapfordítást indítják.",
              "Paging",
              "Paging and the toolbar's previous/next buttons start the same page-turn action."
            )
          ),
          s(
            "song-two-finger",
            "#swipe-handler",
            tx(
              "Kétujjas koppintás",
              "Mozdítás nélküli kétujjas koppintással a módok Ki → Teljes oldal → Szélesség → Kézi sorrendben váltanak; az új mód röviden megjelenik.",
              "Two-finger tap",
              "Tap with two fingers without moving. Modes cycle Off → Fit page → Fit width → Manual, and the new mode briefly appears."
            )
          ),
          s(
            "song-zoom-modes",
            "#swipe-handler",
            tx(
              "Zoommódok",
              "A Teljes oldal a teljes dalt a rendelkezésre álló területre illeszti. A Szélesség a szélességet tölti ki, és hosszabb dalnál függőlegesen görgethető marad. A Kézi megadott betűméretet használ. Az Automatikus sortörés külön kapcsolható; rövid dalnál az illesztés nagyobb betűméretet is választhat. Kétujjas koppintás vagy Ctrl+Shift+görgő váltja a módot.",
              "Zoom modes",
              "Fit page fits the entire song into the available area. Fit width fills the width and keeps longer songs vertically scrollable. Manual uses an explicit font size. Auto wrap is a separate option; fitting may choose a larger font for short songs. A two-finger tap or Ctrl+Shift+wheel cycles modes."
            )
          ),
          s(
            "song-pinch",
            "#swipe-handler",
            tx(
              "Csippentéses nagyítás",
              "Kétujjas összecsippentéssel csökkenthető, széthúzással növelhető a betűméret; egérrel Ctrl+görgő használható. Bekapcsolt nagyításnál az automatikus illesztésből a képernyőn látható méretről Kézi módra vált, majd onnan méretez. Kikapcsolt nagyításnál nem állít betűméretet.",
              "Pinch zoom",
              "Pinch to reduce or spread to increase font size, or use Ctrl+mouse wheel. While zoom is on, an automatic fit switches to Manual at the current on-screen size, then adjusts from there. With zoom off, these gestures do not change the font size."
            )
          ),
          s(
            "song-navigation",
            ".cv-navigation-mode",
            tx(
              "Navigáció forrása",
              "Az ikon az adatbázis-, keresési vagy műsortári lapozási sorrendet jelzi. A vezérlővel a műsortár nézet állítható vissza.",
              "Navigation source",
              "The icon identifies database, search or playlist order. Use it to return to the playlist view mode."
            )
          ),
          s(
            "song-add",
            [".cv-navigation-add-current", ".cv-navigation-mode", "#editor"],
            tx(
              "Dal hozzáadása",
              "Adatbázisból vagy keresésből megnyitott, még nem műsortári dal itt adható a műsortárhoz, és a navigáció műsortári sorrendre állítható.",
              "Add song",
              "If a database or search result is not yet in the playlist, add it and switch to playlist navigation here."
            )
          ),
          s(
            "song-highlight",
            "#editor",
            tx(
              "Kiemelés",
              "Kiemelésvezérlő módban a dalszöveg kijelölt része a vezetői és az engedélyezett követői kijelzőkön egyaránt megjeleníthető kiemelve.",
              "Highlight",
              "In highlight-control mode, select lyrics to highlight them on the leader and permitted follower displays."
            )
          ),
        ],
      }
    ),
    s(
      "toolbar",
      "#mainToolbar",
      tx(
        "Fő vezérlősáv",
        "A vezérlősáv az előadás közbeni gyorsműveleteket gyűjti össze. Álló nézetben felül, fekvő nézetben oldalt is megjelenhet.",
        "Main toolbar",
        "The toolbar collects quick performance controls. Depending on orientation it can appear at the top or along the side."
      ),
      {
        prepare: song,
        details: [
          s(
            "toolbar-previous",
            ["#btnPrev", "#mainToolbar"],
            tx(
              "Előző dal",
              "Az aktuális navigációs sorrend előző dalára lép. Távoli kijelző követésekor a vezető irányít, ezért a gomb hiányozhat.",
              "Previous song",
              "Move to the previous song in the current navigation order. It may be hidden while a remote leader controls the display."
            )
          ),
          s(
            "toolbar-next",
            ["#btnNext", "#mainToolbar"],
            tx(
              "Következő dal",
              "Az aktuális navigációs sorrend következő dalára lép. Távoli kijelző követésekor a vezető irányít, ezért a gomb hiányozhat.",
              "Next song",
              "Move to the next song in the current navigation order. It may be hidden while a remote leader controls the display."
            )
          ),
          s(
            "toolbar-home",
            "#btnHome",
            tx(
              "Visszatérés a saját felületre",
              "Megosztott vagy rögzített munkamenetből a házikóval térhetsz vissza az alkalmazás saját felületére. Ez a követett tartalom elhagyására szolgál; a teljes szerkesztőre váltás külön művelet a Több menüben, ahol elérhető.",
              "Return to your own app",
              "Use Home to leave a shared or locked session and return to the app's own interface. Switching to the full editor is a separate action in More where that option is available."
            )
          ),
          s(
            "toolbar-instructions",
            ["#btnInstructions", "#mainToolbar"],
            tx(
              "Instrukciók",
              "A dal instrukciói rövid koppintással vagy kattintással kapcsolhatók be és ki.",
              "Instructions",
              "Tap or click briefly to show or hide the song instructions."
            )
          ),
          s(
            "toolbar-instruction-editor",
            ["#btnInstructions", "#mainToolbar"],
            tx(
              "Instrukciószerkesztő",
              "Vezérlési jogosultság esetén a hosszú nyomás vagy jobb kattintás nyitja meg a Forrás, Szerkesztő és Előnézet paneleket. Mentéskor a változás azonnal megjelenik. A vetített dal instrukciója a közös kijelzőre is átkerül; egy másik, helyben megnyitott dalé helyi marad. Üres szöveg mentésével az instrukció törölhető.",
              "Instructions editor",
              "With control permission, hold or right-click this button to open the Source, Editor and Preview panes. Saved changes appear immediately. Instructions for the projected song also update the shared display; another locally opened song stays local. Saving empty text clears the instructions."
            )
          ),
          s(
            "toolbar-capo",
            ["#capo", "#mainToolbar"],
            tx(
              "Capo",
              "Rövid koppintás vagy kattintás kapcsolja be és ki a capót. Hosszú nyomással, jobb kattintással, a külön lenyíló vezérlővel vagy vízszintes elhúzással közvetlen capoérték választható.",
              "Capo",
              "Tap or click briefly to toggle capo. Hold, right-click, use the separate dropdown control or just drag horizontally to choose a capo value directly."
            )
          ),
          s(
            "toolbar-transpose",
            ["#transpose", "#mainToolbar"],
            tx(
              "Transzponálás",
              "Koppintás, kattintás vagy vízszintes elhúzás nyitja az értékválasztót, ahol félhangonként állítható a megnyitott dal hangneme. A vetített dal vezérlésekor a módosítás a közös kijelzőre is átkerül. Egy másik, adatbázisból vagy mentett listából helyben megnyitott dal transzponálása helyi marad.",
              "Transpose",
              "Tap, click or drag horizontally to open the picker and transpose the viewed song by semitones. While controlling the projected song, changes also reach the shared display. Transposing a different song opened locally from the database or a saved list stays local."
            )
          ),
          s(
            "toolbar-picker",
            "#transpose, #capo",
            tx(
              "Értékválasztó",
              "Az értékek húzással, a látható lehetőségekkel vagy billentyűzettel léptethetők; a transzponálás és a capo vezérlőjéről indított húzás közvetlenül is megnyitja a választót. Az Enter billentyű vagy egy konkrét értékre való kattintás az új értéket érvényesíti, az Esc vagy az értékválasztó mellé kattintás az eredeti értéket állítja vissza.",
              "Value picker",
              "Drag, use the visible choices or use the keyboard to step through values; dragging from the transpose or capo control also opens the picker directly. Pressing Enter or clicking a specific value applies that new value; pressing Escape or clicking outside the value picker closes it and restores the original value."
            ),
            { prepare: openClientTutorialValuePicker, highlightTargets: ["#transpose", "#capo", ".cv-wheel"] }
          ),
          s(
            "toolbar-highlight",
            ["#btnUnhighlight", "#mainToolbar"],
            tx(
              "Kiemelés törlése",
              "A gomb csak akkor látható, amikor az aktív kiemelés a jelenlegi jogosultsággal törölhető.",
              "Clear highlight",
              "This control appears only when the active highlight can be cleared with your current permission."
            )
          ),
          s(
            "toolbar-fullscreen",
            ["#fsdiv", "#mainToolbar"],
            tx(
              "Teljes képernyő",
              "Váltás teljes képernyős és ablakos megjelenítés között.",
              "Full screen",
              "Switch between full-screen and windowed display."
            )
          ),
          s(
            "toolbar-refresh",
            "#mainToolbar",
            tx(
              "Frissítés",
              "Az eszköztár lehúzása és elengedése újratölti a kliensnézetet és a háttéradatokat.",
              "Pull to refresh",
              "Pull the toolbar down and release to reload the client view and background data."
            )
          ),
          s(
            "toolbar-network",
            ["#netstatus", "#mainToolbar"],
            tx(
              "Hálózati állapot",
              "Az ikon a kapcsolódás, követés, engedélyezett vezetés vagy hiba állapotát mutatja; hiba esetén itt kezdeményezhető újracsatlakozás.",
              "Network status",
              "The icon indicates connection, following, authorized leading or error. Reconnection can be requested from the same control."
            )
          ),
          s(
            "toolbar-input",
            "#mainToolbar",
            tx(
              "Billentyűzet és MIDI",
              "A fontos műveletek billentyűzettel és támogatott környezetben MIDI-vel is vezérelhetők. Saját kiosztás a teljes nézet Beállítások → Hardveres vezérlés lapján készíthető. A teljes és a kliensnézet külön profilt használ; a gyári profil másolata szerkeszthető és bemenetek taníthatók hozzá.",
              "Keyboard and MIDI",
              "Use keyboard controls and, where supported, MIDI. Create custom mappings in full view under Settings → Hardware control. Full and client view have separate profiles; copy the factory profile to edit it and learn inputs."
            )
          ),
        ],
      }
    ),
    s(
      "options",
      "#btnOptions",
      tx(
        "Beállítások és listák",
        "Ez a gomb nyitja meg a megjelenítési beállításokat, a keresőt és – megfelelő jogosultsággal – a műsortárat.",
        "Options and lists",
        "Open display settings, search and, with sufficient permission, the playlist here."
      ),
      { prepare: song }
    ),
    s(
      "search",
      "#filterRow",
      tx(
        "Keresés és listaváltás",
        "A daladatbázis keresése, a műsortárban való keresés, valamint az adatbázis-, műsortár- és vezetői listák közötti váltás itt érhető el.",
        "Search and list mode",
        "Search the song database, filter the playlist or switch among database, playlist and leader lists."
      ),
      {
        prepare: options,
        details: [
          s(
            "search-language-filter",
            "#filterRow",
            tx(
              "Keresés és dalnyelv",
              "A rendelkezésre álló dalkönyvtárat a gazdaalkalmazás dalnyelvi szűrője is korlátozhatja. A kereső kiürítése ezt nem oldja fel. Saját alkalmazásban az Általános beállítások között ellenőrizhető a dalnyelvi szűrő; követett munkamenetben a házigazda által kínált dalok érhetők el.",
              "Search and song language",
              "The host app's song-language filter may restrict the available catalogue. Clearing the search does not remove it. In your own app, check the song-language filter in General settings; a followed session supplies the songs offered by its host."
            )
          ),
          s(
            "search-mode",
            "#listModeToggle",
            tx(
              "Listamód",
              "A gomb az adatbázis, az aktuális műsortár és a vezetők dátumozott listái között léptet. Az ikon az aktuális módot mutatja.",
              "List mode",
              "Cycle among database, current playlist and dated leader lists. The icon shows the current mode."
            )
          ),
          s(
            "search-filter",
            "#options[data-list-mode='database'] #filter",
            tx(
              "Kereső és szűrő",
              "Adatbázis módban dalokat keres, műsortárban először a helyi listát szűri. Esc vagy a törlés ikon kiüríti.",
              "Search and filter",
              "In database mode it searches songs; in playlist mode it first filters locally. Escape or Clear empties the field."
            ),
            { prepare: databaseList }
          ),
          s(
            "search-database",
            "#options[data-list-mode='playlist'] #playlist-search",
            tx(
              "Adatbázis-keresés",
              "Műsortári szűrés közben ugyanarra a kifejezésre a teljes daladatbázisban is lehet keresni.",
              "Database search",
              "While filtering the playlist, search the complete song database for the same phrase."
            ),
            { prepare: playlistList }
          ),
          s(
            "search-leaders",
            "#options[data-list-mode='leaderlists'] .cv-leaderlists-controls",
            tx(
              "Vezetői listák",
              "A vezető és a dátum kiválasztása után a vezető listáiban is kereshető a kívánt tartalom. A Csere gomb csak a helyi műsortárat módosítja, a forráslistát nem.",
              "Leader lists",
              "Choose a leader and date or search their lists. Replace updates the local working playlist without changing the source."
            ),
            { prepare: leaderLists }
          ),
        ],
      }
    ),
    s(
      "song-list",
      "#options[data-list-mode='database'] #list",
      tx(
        "Dallista",
        "Egy sor kiválasztása megjeleníti a dalt. Szerkeszthető módban a dal a műsortárhoz adható, vagy közvetlenül műsortári navigációban nyitható meg.",
        "Song list",
        "Select a row to display a song. In editable mode add it to the playlist or open it directly in playlist navigation."
      ),
      {
        prepare: databaseList,
        details: [
          s(
            "list-row",
            "#options[data-list-mode='database'] #list",
            tx(
              "Találati sor",
              "A kiválasztott dal megjelenik, és a lapozás a találati sorrendben folytatódik. A kijelölt sor kiemelve marad.",
              "Result row",
              "The selected song is displayed and paging continues in result order. The selected row remains highlighted."
            )
          ),
          s(
            "list-add",
            ["#options[data-list-mode='database'] .cv-add-btn", "#options[data-list-mode='database'] #list"],
            tx(
              "Hozzáadás",
              "A plusz hozzáadja a dalt a műsortárhoz; a pipa jelzi, hogy már szerepel benne, és ugyanazzal a vezérlővel eltávolítható.",
              "Add",
              "Plus adds the song to the playlist; a check marks existing entries and the same control removes it."
            )
          ),
          s(
            "list-play",
            ["#options[data-list-mode='database'] #list .cv-play-btn", "#options[data-list-mode='database'] #list"],
            tx(
              "Azonnali lejátszás",
              "Szükség esetén hozzáadja a dalt, megjeleníti és műsortári navigációra vált.",
              "Play now",
              "Add the song if needed, display it and switch to playlist navigation."
            )
          ),
          s(
            "list-found",
            ["#options[data-list-mode='database'] .cv-found-marker", "#options[data-list-mode='database'] #list"],
            tx(
              "Találat helye",
              "A jelölő mutatja, hogy a keresett rész címben, dalszövegben, fejlécben vagy más mezőben található.",
              "Match location",
              "The marker shows whether the match came from title, lyrics, header or another field."
            )
          ),
          s(
            "list-size",
            "#options[data-list-mode='database'] #list",
            tx(
              "Lista nagyítása",
              "A lista sormérete külön állítható Ctrl+egérgörgő használatával vagy csippentéssel, és a választás ezen az eszközön megmarad.",
              "List size",
              "List row size can be adjusted separately by CTRL+mouse wheel or pinch zoom, and the setting persists on this device."
            )
          ),
        ],
      }
    ),
    s(
      "playlist",
      "#options[data-list-mode='playlist'] #list",
      tx(
        "Aktuális műsortár",
        "Az előadás dalai itt választhatók ki és rendezhetők; dalonként külön transzponálás vagy capo is beállítható.",
        "Current playlist",
        "Select and arrange performance songs here, with per-song transpose and capo settings."
      ),
      {
        prepare: playlistList,
        details: [
          s(
            "playlist-open",
            "#options[data-list-mode='playlist'] #list",
            tx(
              "Dal megnyitása",
              "A műsortári sor megjeleníti a dalt, és a további lapozás a műsortár sorrendjét követi.",
              "Open song",
              "A playlist row displays the song and subsequent paging follows playlist order."
            )
          ),
          s(
            "playlist-reorder",
            "#options[data-list-mode='playlist'] #list",
            tx(
              "Átrendezés",
              "Szerkeszthető műsortárban a sorok tetszőleges sorrendbe rendezhetők. A követői és mentett forráslisták olvashatók maradnak.",
              "Reorder",
              "Rows can be reordered in an editable playlist. Followed and saved source lists remain read-only."
            )
          ),
          s(
            "playlist-transpose",
            "#options[data-list-mode='playlist'] #list",
            tx(
              "Transzponálás és capo",
              "A sor saját vezérlői csak ezt a műsortételt módosítják, az adatbázis dalát nem.",
              "Transpose and capo",
              "Row controls affect only this playlist entry, not the database song."
            )
          ),
          s(
            "playlist-remove",
            "#options[data-list-mode='playlist'] #list",
            tx(
              "Eltávolítás",
              "A sor eltávolítási területre húzásával a dal csak az aktuális munkalistából kerül ki; az adatbázisban megmarad.",
              "Remove",
              "Drag the row to the removal target to remove it only from the current working list; the database song remains."
            )
          ),
          s(
            "playlist-size",
            "#options[data-list-mode='playlist'] #list",
            tx(
              "Lista sormérete",
              "A műsortár sorainak mérete csippentéssel vagy Ctrl+görgő használatával állítható és ezen az eszközön megmarad.",
              "Playlist row size",
              "Playlist row size can be adjusted by pinching or Ctrl+mouse wheel combination and persists on this device."
            )
          ),
        ],
      }
    ),
    s(
      "display-options",
      ".cv-options-bar",
      tx(
        "Megjelenítési beállítások",
        "Az akkordok, kiemelés, nagyítás és téma ezen az eszközön használt megjelenését szabályozzák.",
        "Display options",
        "Control how chords, highlights, zoom and theme appear on this device."
      ),
      {
        prepare: options,
        details: [
          s(
            "display-chord-box",
            "[data-tutorial-id='client-chord-box']",
            tx(
              "Akkordmegjelenítés",
              "Sorba írt akkordok, gitár- vagy zongorafogások, illetve akkordok nélküli nézet választható; a közvetlen választómenü ugyanezeket az opciókat mutatja.",
              "Chord display",
              "Choose inline chords, guitar or piano diagrams, or a lyrics-only view; the direct picker offers the same options."
            )
          ),
          s(
            "display-minor",
            "[data-tutorial-id='client-chord-mode']",
            tx(
              "Moll akkordok írásmódja",
              "Az Am, am és a rendelkezésre álló jelölési változatok választhatók.",
              "Minor chord spelling",
              "Choose among Am, am and the available minor-chord spellings."
            )
          ),
          s(
            "display-repeat-chords",
            "[data-tutorial-id='client-section-chord-repeat']",
            tx(
              "Ismételt szakaszakkordok",
              "Elrejti az előző, azonos típusú szakasz akkordjait, ha az akkordmenet változatlan.",
              "Repeated section chords",
              "Hide chords repeated unchanged from the previous section of the same type."
            )
          ),
          s(
            "display-subscript",
            "[data-tutorial-id='client-subscript']",
            tx(
              "Alsó index",
              "Az akkordmódosítókat kisebb, indexelt formában jeleníti meg.",
              "Subscript modifiers",
              "Show chord modifiers in a smaller indexed style."
            )
          ),
          s(
            "display-auto-tone",
            "[data-tutorial-id='client-auto-tone']",
            tx(
              "Automatikus hangnem",
              "Az akkordokat a dal megadott hangneméhez igazítja.",
              "Automatic key",
              "Transpose chord display to the song's declared key."
            )
          ),
          s(
            "display-highlight",
            ["[data-tutorial-id='client-highlight']", ".cv-options-bar"],
            tx(
              "Kiemelés",
              "Rövid kattintás vagy koppintás kapcsolja a kiemelést. Hosszú nyomás vagy jobb kattintás nyitja az átlátszóság beállítását. A kéz ikon a kiemelés vezérlését jelzi; a lehetőségek a munkamenet jogosultságaitól függnek.",
              "Highlight",
              "A short click or tap toggles highlighting. Hold or right-click to open its opacity setting. A hand icon indicates highlight control; available actions depend on session permissions."
            )
          ),
          s(
            "display-b-flat",
            "[data-tutorial-id='client-b-flat']",
            tx(
              "Hangnévrendszer",
              "Az akkordok megjelenítését az angolszász ABCDEFG és a magyar/német AHCDEFG hangnévrendszer között váltja.",
              "Note-name system",
              "Switch chord display between the English ABCDEFG and Hungarian/German AHCDEFG note-name systems."
            )
          ),
          s(
            "display-simplified",
            "[data-tutorial-id='client-simplified']",
            tx(
              "Akkordegyszerűsítés",
              "Elrejti a bonyolult akkordmódosítók egy részét az áttekinthetőbb megjelenéshez.",
              "Chord simplification",
              "Hide some complex chord modifiers for a clearer display."
            )
          ),
          s(
            "display-zoom",
            "[data-tutorial-id='client-zoom']",
            tx(
              "Nagyítás",
              "Rövid kattintás vagy koppintás be- vagy kikapcsolja a nagyítást. Hosszú nyomás vagy jobb kattintás nyitja meg a részletes nagyítási panelt.",
              "Zoom",
              "A short click or tap toggles zoom. Hold or right-click to open the detailed zoom panel."
            )
          ),
          s(
            "display-zoom-panel",
            [".cv-zoom-panel", "[data-tutorial-id='client-zoom']", ".cv-options-bar"],
            tx(
              "Nagyítási panel",
              "A cím, metaadat, szakaszcímke, kotta és automatikus sortörés külön szabályozható. Illesztési mód választható; Kézi módban betűméretcsúszka jelenik meg. A módosítások azonnal érvényesek ezen az eszközön.",
              "Zoom panel",
              "Control title, metadata, section labels, notation and auto wrap separately. Choose a sizing mode; Manual shows a font-size slider. Changes apply immediately on this device."
            ),
            { prepare: openClientZoomPanel }
          ),
          s(
            "display-score-mode",
            "[data-tutorial-id='client-zoom-abc']",
            tx(
              "Kotta vagy dalszöveg és akkordok",
              "Bekapcsolt nagyításnál a ♪ gomb vált a teljes kotta és az abból előállított dalszöveg/akkord nézet között. Szöveg nélküli kottából akkordrács készülhet; nem átalakítható kottánál megmarad a kottanézet. Az eredeti dal változatlan marad.",
              "Notation or lyrics and chords",
              "With zoom enabled, the ♪ button switches between full notation and lyrics/chords derived from it. Instrumental notation may become a chord grid; unsupported scores retain notation. The original song is unchanged."
            ),
            { prepare: openClientZoomPanel }
          ),
          s(
            "display-wrap",
            "[data-tutorial-id='client-zoom-wrap']",
            tx(
              "Automatikus sortörés",
              "A sortörés ikonja külön kapcsolja a hosszú sorok tördelését; az aktív ikont kék kiemelés jelzi. A Szélesség mód hosszabb tartalomnál görgethető marad, a Kézi mód a választott betűméretet tartja meg.",
              "Auto wrap",
              "The wrap icon separately enables wrapping long lines; blue highlighting marks it as active. Fit width remains scrollable for long content, and Manual preserves the selected font size."
            ),
            { prepare: openClientZoomPanel }
          ),
          s(
            "display-section-labels",
            "[data-tutorial-id='client-zoom-sections']",
            tx(
              "Szakaszcímkék",
              "A gomb a teljes szakaszcímke, a rövidítés és az elrejtés között vált. Ez a megjelenítést módosítja ezen az eszközön, a dalban tárolt szakaszneveket nem.",
              "Section labels",
              "Cycle between full section labels, abbreviations and hidden labels. This changes this device's display without editing the song's stored section names."
            ),
            { prepare: openClientZoomPanel }
          ),
          s(
            "display-theme",
            "[data-tutorial-id='client-theme']",
            tx("Téma", "A megjelenés automatikus, világos vagy sötét módra állítható.", "Theme", "Cycle among automatic, light and dark appearance.")
          ),
          s(
            "display-leader",
            ["[data-tutorial-id='client-leader-mode']", ".cv-options-bar"],
            tx(
              "Vezető mód",
              "A környezet támogatásától/jogosultságtól függően a kliens követő vagy vezető módban használható; vezető módban a közös kijelző állapota is módosítható.",
              "Leader mode",
              "Where supported, switch between follower and leader. A leader can modify shared display state."
            )
          ),
          s(
            "display-close",
            "#closeOptions",
            tx(
              "Bezárás",
              "Bezárja a beállítások panelt és visszatér a dalnézethez.",
              "Close",
              "Close options panel and return to the full song view."
            )
          ),
        ],
      }
    ),
    s(
      "more",
      "[data-tutorial-id='client-more-button']",
      tx(
        "További műveletek",
        "A Több menüben az aktuális módtól függően listatörlés, munkamenetek, felületváltás, névjegy és kilépés érhető el.",
        "More actions",
        "Depending on mode, More contains clear list, sessions, switch UI, about and exit."
      ),
      {
        prepare: options,
        details: [
          s(
            "more-attention-colors",
            "[data-tutorial-id='client-more-button']",
            tx(
              "Teendők színes jelzése",
              "A Beállítások, Több és Felületváltás vezérlők pontjai a gazdaalkalmazás teendőit jelzik: zöld feltöltés, kék letöltés, türkiz mindkettő, narancs offline állapot. A piros például ellenőrzendő dalt, frissítést vagy újrabejelentkezést jelezhet. A felhős adatbázis szinkronizálása a teljes nézetben érhető el.",
              "Attention badge colors",
              "Dots on Options, More and Switch UI report host-app tasks: green for upload, blue for download, turquoise for both, and orange for offline. Red can indicate song review, an update or a new sign-in. Cloud database synchronization is available in full view."
            )
          ),
          s(
            "more-menu",
            ".cv-more-menu",
            tx(
              "Több menü",
              "A menü csak az aktuális környezetben használható műveleteket mutatja.",
              "More menu",
              "Only actions available in the current runtime and mode are shown."
            ),
            { prepare: openClientMoreMenu }
          ),
          s(
            "more-clear",
            "[data-tutorial-id='client-more-clear-list']",
            tx(
              "Lista törlése",
              "Megerősítés után az aktuális munkalista elemeit távolítja el, a mentett forráslistát nem írja át.",
              "Clear list",
              "After confirmation, remove entries from the working list without changing its saved source."
            ),
            { prepare: openClientMoreMenu }
          ),
          s(
            "more-sessions",
            "[data-tutorial-id='client-more-sessions']",
            tx(
              "Munkamenetek és kapcsolat",
              "A kapcsolatok keresésére, indítására és követésére szolgáló dialógust nyitja meg. Itt helyi, közeli és felhős munkamenetek kezelhetők, megosztási QR-kód kérhető, követéskor pedig vissza lehet térni a helyi listákhoz. A fő vezérlősáv hálózati jelzője az aktuális kapcsolati állapotot mutatja.",
              "Sessions and connection",
              "Open the hub for discovering, starting and following connections. It manages local, nearby and cloud sessions, can provide a sharing QR code, and lets you return to your own lists while following. The main toolbar network indicator shows the current connection state."
            ),
            { prepare: openClientMoreMenu }
          ),
          s(
            "more-switch",
            "[data-tutorial-id='client-more-home']",
            tx(
              "Vissza a teljes nézetre",
              "Visszavált a teljes szerkesztői felületre, átadja az aktuális dalkijelölést, és a lenti gombbal ott folytatja a bemutatót.",
              "Back to full view",
              "Return to the full editor, carry over the current song selection, and continue the tutorial there with the action below."
            ),
            {
              prepare: openClientMoreMenu,
              actions: [{ id: "switch-full", label: tl("Visszatérés a teljes nézetre", "Return to full view"), command: "switch-full" }],
            }
          ),
          s(
            "more-about",
            ["[data-tutorial-id='client-more-about']", ".cv-more-menu"],
            tx(
              "Névjegy",
              "Az alkalmazás verzióját, licenceit és eszközinformációit mutatja. A bemutató innen bármikor újraindítható.",
              "About",
              "Shows app version, licenses and device information. You can restart this tutorial here at any time."
            ),
            { prepare: openClientMoreMenu }
          ),
          s(
            "more-exit",
            "[data-tutorial-id='client-more-exit']",
            tx("Kilépés", "Natív alkalmazáskörnyezetben bezárja a programot.", "Exit", "Close the program in a native application runtime."),
            { prepare: openClientMoreMenu }
          ),
        ],
      }
    ),
  ],
};
