import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

type ClientViewAppModule = typeof import("../ClientViewApp");

const code = ts.transpileModule(readFileSync(new URL("../ClientViewApp.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function loadClientViewApp(modules: Record<string, unknown>): ClientViewAppModule {
  const exports = {} as ClientViewAppModule;
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      assert.ok(id in modules, `Unexpected import: ${id}`);
      return modules[id];
    },
  });
  return exports;
}

test("later auth operations keep the started client view mounted", () => {
  let isLoading = true;
  // One component instance across renders: a minimal hook store, so the test
  // can raise isLoading again the way login/logout do on the live provider.
  // Like React, a state update during render renders the component again.
  const slots: unknown[] = [];
  let cursor = 0;
  let updatedDuringRender = false;
  const hooks = {
    ...React,
    useState: (initial: unknown) => {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [
        slots[slot],
        (value: unknown) => {
          if (slots[slot] === value) return;
          slots[slot] = value;
          updatedDuringRender = true;
        },
      ];
    },
  };
  const app = loadClientViewApp({
    react: hooks,
    "react/jsx-runtime": jsxRuntime,
    "../api/direct/DirectClientApi": {},
    "../controller/ClientViewStore": {},
    "../controller/ClientViewContext": {},
    "../ui/ClientView": {},
    "../../contexts/AuthContext": { useAuth: () => ({ isLoading }) },
    "../../localization/LocalizationContext": { LocalizationProvider: () => null, useLocalization: () => ({ t: (key: string) => key }) },
    "../ui/client-view.css": {},
  });
  const shown = () => {
    let tree: React.ReactElement<{ children: React.ReactElement }>;
    do {
      cursor = 0;
      updatedDuringRender = false;
      tree = app.ClientViewApp({}) as React.ReactElement<{ children: React.ReactElement }>;
    } while (updatedDuringRender);
    return (tree.props.children.type as { name: string }).name;
  };
  assert.equal(shown(), "ClientViewLoading");
  isLoading = false;
  assert.equal(shown(), "ClientViewAppContent");
  isLoading = true; // login / logout / sign-out from another tab
  assert.equal(shown(), "ClientViewAppContent", "the live store, its dialogs and follow state must survive");
});

test("embedded startup waits for the host's user database before creating its adapter and restoring state", () => {
  let isLoading = true;
  let adapters = 0;
  let stores = 0;
  const modules: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "../api/direct/DirectClientApi": {
      DirectClientApi: class {
        constructor() {
          adapters++;
        }
      },
    },
    "../controller/ClientViewStore": {
      ClientViewStore: class {
        constructor() {
          stores++;
        }
      },
    },
    "../controller/ClientViewContext": {},
    "../ui/ClientView": {},
    "../../contexts/AuthContext": { useAuth: () => ({ isLoading }) },
    "../../localization/LocalizationContext": {
      LocalizationProvider: ({ children }: { children: React.ReactNode }) => children,
      useLocalization: () => ({ t: (key: string) => key }),
    },
    "../ui/client-view.css": {},
  };
  const exports = loadClientViewApp(modules);
  assert.match(renderToStaticMarkup(React.createElement(exports.ClientViewApp)), /Loading/);
  assert.equal(adapters, 0, "the guest database must not seed an account's restored client view");
  assert.equal(stores, 0, "saved state must stay untouched while the host selects its database");

  isLoading = false;
  assert.match(renderToStaticMarkup(React.createElement(exports.ClientViewApp)), /Loading/);
  assert.equal(adapters, 1);
  assert.equal(stores, 1);
});
