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
    // Servability boundary: the client-view UI and controller layers must reach
    // the backend ONLY through the ClientApi port, never via Electron-only or
    // in-process modules. This keeps the same bundle runnable when served by the
    // Electron webserver or deployed standalone. Adapters under api/rest are
    // exempt (they are the place backend wiring is allowed).
    files: ["src/client-view/ui/**/*.{ts,tsx}", "src/client-view/controller/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/db-common/**",
                "**/services/hostDevicePpd*",
                "**/services/webServerBridge*",
                "**/state/CurrentSongStore*",
                "**/api/rest/**",
                "**/api/direct/**",
                "electron",
                "electron-*",
                "**/electron/**",
              ],
              message: "Client-view UI/controller must reach the backend only through ClientApi (keep the bundle servable by the webserver).",
            },
          ],
        },
      ],
    },
  },
];
