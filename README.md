# PraiseProjector Electron (TypeScript)

> Licensing notice: Source-available, non-commercial, and **not open source** (not OSI-approved). See [LICENSE.md](LICENSE.md).

Electron-based PraiseProjector desktop app with a React renderer, TypeScript codebase, and built-in local web server.

## What it is all about?

This is my hobby project, which was originally built using C# .NET WinForms. For a long time, I’ve wanted to make it cross-platform, but I never had the time alongside my fulltime job to rewrite the entire thing from scratch. Then came the era of Artificial Intelligence — love it or hate it. I used it to port seven years of manual development into this multiplatform Electron application in just a few months of weekend work.

As a result, the code is by no means 'pretty' or elegant or well designed; however, it gets the job done. While I’m not particularly proud of it — especially since, as mentioned, I didn’t write most of it with my own two hands — I am making it public for a specific reason. Nowadays, installing software on your computer isn't exactly a risk-free decision, so I want to help potential users by providing the source code so anyone can see for themselves that the program performs no 'under-the-table' activities. If you’re as skeptical as I am, you can even compile it yourself directly from the source.

## Features

- Cross-platform desktop app (Windows, macOS, Linux)
- React + TypeScript renderer UI
- Electron main process with secure BrowserWindow defaults
- Song, playlist, and projection workflow
- Local web server for remote display/control endpoints
- ChordPro-related tooling and shared `common/` code

## Requirements

- Node.js 22.12.0+ (recommended)

## Installation

1. **Install Node.js** (version 22.12.0 or higher) from [nodejs.org](https://nodejs.org/)

2. **Clone or download** this project

3. **Install dependencies**:
```bash
npm install
```

## Development

### Common Commands

```bash
# Start Vite dev server (renderer)
npm run dev

# Start Vite dev server in web mode
npm run dev:web

# Launch Electron app
npm run dev:electron

# Build client workspace + Vite bundles
npm run build

# Build distributables
npm run dist

# Optional: install BLE peripheral module (not installed by default)
npm run install:ble-peripheral
```

### Optional BLE Peripheral Module

- `@abandonware/bleno` is intentionally not part of the default dependency set.
- The app runs without it; BLE peripheral mode is optional.
- If you need BLE peripheral support for local testing, install it explicitly:
- Bluetooth support is not ready yet

```bash
npm run install:ble-peripheral
```

### Quality Commands

```bash
# Lint
npm run lint

# Format
npm run format

# Type checks
npm run check:ts
```

## Proxy Host Policy (`electron/proxy.ts`)

The Electron proxy blocks private/local targets in production and can optionally restrict public targets.

- Start from committed `proxy-config.example.json`, then create your local runtime file:
  - Copy `proxy-config.example.json` -> `proxy-config.json`
  - Edit values in `proxy-config.json` for your deployment
- Configure `proxy-config.json` (runtime file, not committed) at app root or next to the packaged executable:
  - `proxyAllowedHosts`: optional list of allowed public hostnames
  - `cloudApiHost`: optional URL used as fallback when `proxyAllowedHosts` is empty
- `PP_PROXY_ALLOWED_HOSTS` and `VITE_CLOUD_API_HOST` environment variables are still supported and override file values when present.
- If neither is set, any public host is allowed (private/local hosts are still blocked in production).

## External Link Policy (`electron/main.ts`)

`shell.openExternal` allowlisted domains are resolved at runtime and are not hardcoded in source.

- Source: `proxy-config.json` -> `proxyAllowedHosts`.
- Fallback: hostname derived from `proxy-config.json` -> `cloudApiHost`.

## Project Structure

```
/
├── electron/            # Electron main process (main/preload, proxy, webserver, transport)
├── src/                 # React renderer app
├── client/              # Browser client workspace
├── common/              # Shared types/utilities
├── chordpro/            # ChordPro-related logic
├── public/              # Static assets bundled as extra resources
├── scripts/             # Build and packaging helpers
├── proxy-config.example.json  # Committed template for runtime proxy policy
├── proxy-config.json          # Runtime proxy policy (local file, gitignored)
├── vite.config.ts       # Vite config (renderer + electron integration)
├── tsconfig.json        # Renderer/shared TS config
├── tsconfig.node.json   # Node/Electron TS config
└── package.json         # Scripts, deps, electron-builder config
```

## TypeScript Notes

- `tsconfig.json` uses strict settings with `module: ESNext` for renderer/shared code.
- `tsconfig.node.json` extends base config and uses `module: CommonJS` for Electron/Node targets.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run lint, format, and type checks
5. Test thoroughly
6. Submit a pull request

## License

This repository is licensed under PolyForm Noncommercial 1.0.0.
See [LICENSE.md](LICENSE.md).

Important: this is a source-available, non-commercial license (not an OSI open-source license).

Third-party dependency notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Commercial Licensing

Commercial use requires a separate written commercial license.

- Default maintainer contact (GitHub public email): 116955+tomika@users.noreply.github.com

## Support

For issues and questions, please create an issue in the repository or contact the default maintainer contact (GitHub public email): 116955+tomika@users.noreply.github.com.