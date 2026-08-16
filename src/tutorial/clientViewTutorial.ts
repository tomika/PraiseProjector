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
  version: 4,
  cleanup: closeClientTutorialPopovers,
  steps: [
    s(
      "song-view",
      ["#swipe-handler", "#editor"],
      tx(
        "Dalnézet",
        "Itt jelenik meg az aktuális dal ChordPro-formázással, akkordokkal és instrukciókkal. A lapozási vezérlővel lehet a dalok között váltani.",
        "Song view",
        "The current song appears here with ChordPro formatting, chords and instructions. Use paging controls to change songs."
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
              "A Teljes oldal mindkét irányban illeszt; Automatikus sortörés nélkül a Szélesség kitölti a szélességet és görgethető; a Kézi közvetlen méretet használ. Az Automatikus sortörés a két illesztési módban azonosan, a rendelkezésre álló magasságig növelheti a betűméretet, Kézi módban csak a hosszú sorokat töri. Két ujjas érintés vagy Ctrl+Shift+görgő váltja a zoommódot.",
              "Zoom modes",
              "Fit page fits both dimensions; without Auto wrap, Fit width fills the width and scrolls; Manual uses an explicit size. Auto wrap gives both fit modes the same height-filling font growth, while Manual only wraps over-wide lines. A two-finger tap or Ctrl+Shift+wheel cycles zoom modes."
            )
          ),
          s(
            "song-pinch",
            "#swipe-handler",
            tx(
              "Csippentéses nagyítás",
              "Kézi módban kétujjas összecsippentéssel csökkenthető, széthúzással növelhető a betűméret; egérrel a Ctrl+görgő is használható. Automatikus módban a gesztus nem írja felül az illesztést.",
              "Pinch zoom",
              "In Manual mode, pinch to reduce or spread to increase font size or use CTRL+mouse wheel combination. Automatic modes keep their calculated fit."
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
              "Vezérlési jogosultság esetén a hosszú nyomás vagy a jobb gombos kattintás nyitja meg az instrukciószerkesztőt. A Forrás, Szerkesztő és Előnézet panelek a tartalom összevetésére, módosítására és mentésére szolgálnak.",
              "Instructions editor",
              "With control permission, hold this same button or right-click it to open the instructions editor. Compare, edit and save the content in its Source, Editor and Preview panes."
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
              "Koppintás, kattintás vagy vízszintes elhúzás nyitja meg az értékválasztót; itt félhangonként állítható az aktuális műsortétel hangneme. Vezérlő módban a módosítás egyszerre jelenik meg az aktuális vetítésen és a munkamenet valamennyi csatlakozott nézőjénél.",
              "Transpose",
              "Tap, click or just drag horizontally to open the value picker, then change the current playlist entry by semitones. When you are controlling the display, the change appears simultaneously on the current projection and for every connected session viewer."
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
              "A fontos műveletek billentyűzettel és támogatott környezetben MIDI-vel is vezérelhetők. Saját profil a full-view Kliens nézet beállításában készíthető.",
              "Keyboard and MIDI",
              "Important actions can use keyboard and, where supported, MIDI. Create custom profiles in the full view's Client view settings."
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
              "Be- vagy kikapcsolja a kiemelést, és megnyitja az átlátszóság beállítását; jogosultságtól függően vezérlő módot is jelezhet.",
              "Highlight",
              "Toggle highlighting and open its opacity setting; depending on permission it may also indicate control mode."
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
              "Be- vagy kikapcsolja az aktuális méretezést, és megnyitja a részletes nagyítási panelt.",
              "Zoom",
              "Toggle the current sizing and open the detailed zoom panel."
            )
          ),
          s(
            "display-zoom-panel",
            [".cv-zoom-panel", "[data-tutorial-id='client-zoom']", ".cv-options-bar"],
            tx(
              "Nagyítási panel",
              "A cím, metaadat és szakaszcímke külön szabályozható. Illesztési mód választható; Kézi módban csúszka jelenik meg.",
              "Zoom panel",
              "Control title, metadata and section labels separately. Select a sizing mode; Manual shows a slider."
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
            ["[data-tutorial-id='client-more-clear-list']", ".cv-more-menu"],
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
            ["[data-tutorial-id='client-more-sessions']", ".cv-more-menu"],
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
            ["[data-tutorial-id='client-more-home']", ".cv-more-menu"],
            tx(
              "Vissza a full-view-ra",
              "Visszavált a teljes szerkesztői felületre, átadja az aktuális dalkijelölést, és a lenti gombbal ott folytatja a bemutatót.",
              "Back to full view",
              "Return to the full editor, carry over the current song selection, and continue the tutorial there with the action below."
            ),
            {
              prepare: openClientMoreMenu,
              actions: [{ id: "switch-full", label: tl("Visszatérés a full-view-ra", "Return to full view"), command: "switch-full" }],
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
            ["[data-tutorial-id='client-more-exit']", ".cv-more-menu"],
            tx("Kilépés", "Natív alkalmazáskörnyezetben bezárja a programot.", "Exit", "Close the program in a native application runtime."),
            { prepare: openClientMoreMenu }
          ),
        ],
      }
    ),
  ],
};
