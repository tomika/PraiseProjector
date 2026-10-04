# Automated tests

| Command | What runs |
| --- | --- |
| `npm run test:chordpro` | `chordpro/tests/**/*.test.ts` |
| `npm run test:search` | `db-common/tests/**/*.test.ts` |
| `npm run test:src` | every `*.test.ts` under `src/`, `common/tests/` and `tests/support/` that is not a hardware test |
| `npm run test:hardware` | hardware-control tests: files named `hardware-*.test.ts` under `src/`, `common/tests/` or `tests/support/`, and everything under `src/hardware-input/` |

Shared test doubles and fixtures live in `tests/support/`.

## Runner rules (`scripts/run-node-tests.js`)

- Each test file is bundled separately with esbuild (CommonJS, `node_modules` external), so production modules keep their extensionless imports. `import.meta.url` is rewritten to the original source URL.
- A suite that discovers no test file fails. A failing test, a bundling error or a runner start failure gives a non-zero exit code.
- `--root <file|dir>` runs only the given test file or folder, e.g. `node scripts/run-node-tests.js --suite hardware --root src/hardware-input/tests/runtime.test.ts`.
