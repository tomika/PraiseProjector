import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadAbcjs } from "../../../../chordpro/abcjs-lazy";
import { createStoreFixture } from "../../../../tests/support/clientViewStoreFixture";
import { LocalizationProvider } from "../../../localization/LocalizationContext";
import { ClientViewProvider } from "../../controller/ClientViewContext";
import { OptionsBar } from "../OptionsBar";

test("both Roman modes carry an asterisk only when the song key is estimated", async (t) => {
  const chords = "[Am] One [Dm] two [E7] three [Am] four";
  const fixture = await createStoreFixture({ display: { songId: "song", song: chords, system: "S" }, settings: { language: "en" } });
  t.after(fixture.dispose);
  window.__ppAssetBase = "";
  fixture.store.toggleOptions(true);

  const labels = () => {
    const providerProps = { store: fixture.store } as ComponentProps<typeof ClientViewProvider>;
    const options = createElement(ClientViewProvider, providerProps, createElement(OptionsBar));
    const markup = renderToStaticMarkup(createElement(LocalizationProvider, null, options));
    const select = markup.match(/<select data-tutorial-id="client-chord-mode"[^>]*>(.*?)<\/select>/)?.[1] ?? "";
    return Array.from(select.matchAll(/<option[^>]*>([^<]+)<\/option>/g), ([, label]) => label);
  };
  const changeSongText = (song: string) => fixture.fake.emitDisplay({ ...fixture.state().display, song });

  assert.deepEqual(labels(), ["Am", "am", "a", "VI*", "♭VI*"]);
  changeSongText(`{key:A Minor}\n${chords}`);
  assert.deepEqual(labels(), ["Am", "am", "a", "VI", "♭VI"]);
  changeSongText("Lyrics without chords");
  assert.deepEqual(labels(), ["Am", "am", "a", "VI", "♭VI"]);

  await loadAbcjs();
  changeSongText('{start_of_abc}\nX:1\nM:4/4\nL:1/4\nK:Am\n"Am"A "Dm"D "E7"E "Am"A|\nw: One two three four\n{end_of_abc}');
  assert.deepEqual(labels(), ["Am", "am", "a", "VI*", "♭VI*"]);
});
