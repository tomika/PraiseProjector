import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as hotStableContextModule from "../../utils/hotStableContext";

type AuthModule = typeof import("../AuthContext");
type OnlineSessionModule = typeof import("../OnlineSessionContext");

// Re-evaluate the production modules as Vite does during hot reload, while
// rendering with real React contexts and hooks. Network/DB effects do not run in SSR.
function loadModule<T>(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const source = readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("import.meta.hot", "hot");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    hot: undefined,
    require: (id: string) => {
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return jsxRuntime;
      assert.ok(id in modules, `Unexpected import: ${id}`);
      return modules[id];
    },
    ...globals,
  });
  return exports as T;
}

function loadAuth(data?: Record<string, unknown>) {
  return loadModule<AuthModule>(
    "../AuthContext.tsx",
    { "../../common/cloudApi": {}, "../config": {}, "../../db-common/Database": {}, "../utils/hotStableContext": hotStableContextModule },
    { hot: data ? { data } : undefined, console: { ...console, warn() {} } }
  );
}

function fixture() {
  const auth = loadAuth();
  const loadSession = (data?: Record<string, unknown>) =>
    loadModule<OnlineSessionModule>(
      "../OnlineSessionContext.tsx",
      { "./AuthContext": auth, uuid: { v4: () => "test-session" }, "../utils/hotStableContext": hotStableContextModule },
      { hot: data ? { data } : undefined }
    );
  return { auth, loadSession };
}

test("hot reload keeps existing providers connected to reloaded session hooks", () => {
  const { auth, loadSession } = fixture();
  const data = {};
  const before = loadSession(data);
  const after = loadSession(data);
  function Probe() {
    const session = before.useOnlineSession();
    assert.equal(after.useOnlineSession(), session);
    assert.equal(after.useOptionalOnlineSession(), session);
    assert.equal(session.canPublish, true);
    return React.createElement("span", null, session.state.phase);
  }
  for (const { OnlineSessionProvider } of [before, after]) {
    const tree = React.createElement(auth.AuthProvider, null, React.createElement(OnlineSessionProvider, null, React.createElement(Probe)));
    assert.equal(renderToStaticMarkup(tree), "<span>disabled</span>");
  }
});

test("hot reload keeps an existing auth provider connected to reloaded auth hooks", () => {
  const data = {};
  const before = loadAuth(data);
  const after = loadAuth(data);
  function Probe() {
    const auth = before.useAuth();
    // A new context would miss the provider and return useAuth's HMR fallback.
    assert.equal(after.useAuth(), auth);
    return null;
  }
  renderToStaticMarkup(React.createElement(before.AuthProvider, null, React.createElement(Probe)));
});

test("useAuth without a provider fails in development too, as it does in production", () => {
  const auth = loadAuth({});
  function Consumer() {
    auth.useAuth();
    return null;
  }
  assert.throws(() => renderToStaticMarkup(React.createElement(Consumer)), /useAuth must be used within an AuthProvider/);
});

test("required session hooks reject a missing provider while standalone consumers remain optional", () => {
  const session = fixture().loadSession();
  function Required() {
    session.useOnlineSession();
    return null;
  }
  function Optional() {
    assert.equal(session.useOptionalOnlineSession(), undefined);
    return null;
  }
  assert.throws(() => renderToStaticMarkup(React.createElement(Required)), /useOnlineSession must be used within OnlineSessionProvider/);
  assert.equal(renderToStaticMarkup(React.createElement(Optional)), "");
});
