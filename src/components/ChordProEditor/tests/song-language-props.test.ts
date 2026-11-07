import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as songLanguage from "../../../../common/song-language";

// Render the actual wrapper with only its browser/desktop dependencies stubbed.
// Compare/import editors deliberately omit settings to retain their own display.
const code = ts
  .transpileModule(readFileSync(new URL("../ChordProEditor.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  .outputText.replaceAll("import.meta.env", "({})");

test("language defaults do not inject global display settings into compare/import editors", () => {
  const globalSettings = {
    hideChordsInReadonlyEditor: true,
    chordProStyles: { custom: true },
    sectionSelByEditorLineSel: true,
    songLanguageFilter: ["en"],
  };
  const react = {
    Component: class {},
    forwardRef: (render: unknown) => render,
    useCallback: (callback: unknown) => callback,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
  const exports: { default?: (props: Record<string, unknown>, ref: null) => { props: Record<string, unknown> } } = {};
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime")
        return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
      if (name.endsWith("/LocalizationContext")) return { useLocalization: () => ({ t: (key: string) => key, language: "hu" }) };
      if (name.endsWith("/TooltipContext")) return { useTooltips: () => ({}) };
      if (name.endsWith("/MessageBoxContext")) return { useMessageBox: () => ({}) };
      if (name.endsWith("/useSettings")) return { useSettings: () => ({ settings: globalSettings }) };
      if (name.endsWith("/common/song-language")) return songLanguage;
      return {};
    },
  });
  const wrapper = exports.default!;
  const preview = wrapper({ song: null }, null).props;
  assert.equal(preview.settings, undefined);
  assert.equal(preview.frequentSongLanguages, globalSettings.songLanguageFilter);

  const explicit = { hideChordsInReadonlyEditor: false, songLanguageFilter: ["hu"] };
  const editor = wrapper({ song: null, settings: explicit }, null).props;
  assert.equal(editor.settings, explicit);
  assert.equal(editor.frequentSongLanguages, explicit.songLanguageFilter);

  // Showing every language leaves the default language for new songs on top.
  const allLanguages = { songLanguageFilter: null, defaultSongLanguage: "de" };
  assert.deepEqual(wrapper({ song: null, settings: allLanguages }, null).props.frequentSongLanguages, ["de"]);
});
