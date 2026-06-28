const js = require("@eslint/js");
const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const compatConfigs = compat
  .config({
    env: {
      browser: true,
      es2021: true,
      node: true,
    },
    extends: [
      "eslint:recommended",
      "plugin:@typescript-eslint/recommended",
      "plugin:react/recommended",
      "plugin:react-hooks/recommended",
      "plugin:prettier/recommended",
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: {
        jsx: true,
      },
    },
    plugins: ["@typescript-eslint", "react", "react-hooks", "prettier"],
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/no-unescaped-entities": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "prettier/prettier": "warn",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  })
  .map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  }));

// --- Architectural import boundaries ---------------------------------------
// Servability boundary: code that must run unchanged whether it is bundled into
// the Electron app, served by the embedded webserver, or deployed standalone
// (cloud/PWA) may reach the backend ONLY through the ClientApi port. It must
// never pull in Electron-only or in-process modules. This applies to the
// client-view UI/controller AND to src/shared (which the client-view consumes).
// Adapters under client-view/api/** are exempt — they are the one place backend
// wiring is allowed.
const servabilityRestrictedGroups = [
  "**/db-common/**",
  "**/services/hostDevicePpd*",
  "**/services/webServerBridge*",
  "**/state/CurrentSongStore*",
  "**/api/rest/**",
  "**/api/direct/**",
  "electron",
  "electron-*",
  "**/electron/**",
];

// Frontend-isolation boundary: src/shared is a leaf consumed by BOTH frontends,
// so it must not import "upward" into either the full operator view
// (src/components, src/App) or the client view (src/client-view) — otherwise one
// frontend transitively drags in the other and import cycles become possible.
// Anything frontend-specific is passed into shared components via props.
const fullViewRestrictedGroups = ["**/components/**", "**/App"];
const clientViewRestrictedGroups = ["**/client-view/**"];

module.exports = [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/app/**",
      "*.config.js",
      "*.config.ts",
      "eslint.config.cjs",
      "scripts/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },
  ...compatConfigs,
  {
    // Client-view UI/controller: servable, and must not reach directly into
    // full-view components — anything shared with the full app belongs in
    // src/shared and is imported from there.
    files: ["src/client-view/ui/**/*.{ts,tsx}", "src/client-view/controller/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: servabilityRestrictedGroups,
              message: "Client-view UI/controller must reach the backend only through ClientApi (keep the bundle servable by the webserver).",
            },
            {
              group: fullViewRestrictedGroups,
              message: "Client-view must not import full-view components directly. Extract the shared piece into src/shared and import it from there.",
            },
          ],
        },
      ],
    },
  },
  {
    // Shared components are consumed by BOTH the full operator view and the
    // servable client-view. They must stay servable (same backend restriction)
    // and frontend-agnostic (no importing either frontend's tree).
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: servabilityRestrictedGroups,
              message: "src/shared is consumed by the servable client-view — reach the backend only via props/ports, never Electron or in-process modules.",
            },
            {
              group: [...fullViewRestrictedGroups, ...clientViewRestrictedGroups],
              message: "src/shared must stay frontend-agnostic: do not import from the full view (src/components, src/App) or the client view (src/client-view). Pass frontend-specific bits in via props.",
            },
          ],
        },
      ],
    },
  },
];
