# Build & Packaging

**Sources:** `package.json`, `build.mjs`, `electron/main.cjs`, `electron/preload.cjs`

PERCEPTION ships as a Windows x64 desktop app. The renderer is bundled by esbuild into a single
minified IIFE; Electron wraps it; electron-builder produces a portable executable and an NSIS
installer.

## Tech stack

- **esbuild 0.24** — bundler, target `chrome120`, IIFE format, minified.
- **Electron 33** — desktop shell with `contextIsolation: true` and `nodeIntegration: false`.
- **electron-builder 25** — Windows `portable` + `nsis` targets.
- **Node 18+** with ESM (`build.mjs`).

## Scripts

```bash
npm install
npm run build      # bundle renderer -> dist/
npm run start      # launch Electron with existing dist/
npm run dev        # build, then launch Electron
npm run dist       # build, then electron-builder --win --x64
```

## Renderer build (`build.mjs`)

1. Create `dist/` if missing.
2. Bundle `src/main.ts` → `dist/game.js`:
   - `bundle: true`, `format: 'iife'`, `target: ['chrome120']`
   - minified, no sourcemap, legal comments stripped
   - `process.env.NODE_ENV` defined as `"production"`
3. Copy `app/index.html` and `app/style.css` into `dist/`.

`dist/index.html` loads `game.js` with a normal `<script>` tag. There is no dev server: the
renderer is always a static file load.

## Electron main process

- Creates a 1600×900 window (minimum 1100×640), background `#04060b`, menu bar hidden.
- `show: false` until `ready-to-show`, then maximize (or `--windowed` to keep the window size).
- Loads `dist/index.html` relative to `electron/`.
- `--autotest` adds `?autotest=1` to the URL for automated runs.
- Renderer crashes and console errors are appended to `crash-log` in `userData`.
- All windows closed → quit; macOS activate → recreate window.

### IPC handlers

| Channel | Behavior |
|---------|----------|
| `perception:read-save` | Read JSON file from `userData` |
| `perception:write-save` | Write JSON file |
| `perception:delete-save` | Delete file |
| `perception:meta` | App version, platform, Electron flag |
| `perception:save-png` | Decode a data URL to PNG on disk |
| `app:quit` | Quit |
| `app:capture` | Capture the window to PNG |

File names are sanitized before joining with `userData` to prevent path traversal.

## Preload bridge (`preload.cjs`)

Exposes `window.perceptionHost` only — no `ipcRenderer` or Node primitives reach the renderer:

```ts
{
  isElectron, readSave, writeSave, deleteSave, meta,
  savePng, quit, capture
}
```

This is the entire privileged surface used by `save.ts` and screenshot tooling.

## Packaging config (`package.json` → `build`)

| Field | Value |
|-------|-------|
| `appId` | `com.johnlcstudios.perception` |
| `productName` | `PERCEPTION` |
| Output | `release/` |
| Build resources | `build/` (`icon.ico`) |
| Included files | `electron/**/*`, `dist/**/*`, `package.json` |
| Windows targets | `portable` (x64), `nsis` (x64) |
| Portable artifact | `PERCEPTION-Portable-${version}.exe` |
| NSIS artifact | `PERCEPTION-Setup-${version}.exe` |
| NSIS mode | one-click, per-user, keep app data on uninstall |

Output after `npm run dist`:

```
release/
├── PERCEPTION-Setup-<version>.exe
├── PERCEPTION-Portable-<version>.exe
└── win-unpacked/PERCEPTION.exe
```

## Versioning

`package.json.version` is the single source of truth (currently `1.4.0`). Electron reports it via
`app.getVersion()` and the About screen; installer artifact names interpolate `${version}`.

## Testing / sanity checks

`src/test-world.ts` and `src/pw-dbg.ts` are Node-side scripts that build the world, print road
and object counts, sample random road points, exercise `raycast()` and simulate traffic. They are
development tools, not part of the shipped bundle.

## Notes for contributors

- Keep the renderer dependency footprint tiny; `three` is the only runtime dependency.
- Do not import Node modules from `src/`; the renderer must stay browser-compatible.
- Anything added to `dist/` must be copied by `build.mjs` or bundled from `src/`.
- The world is deterministic per seed; avoid `Math.random()` in world construction so tests and
  scenes reproduce.

## Related documentation

- [Persistence](persistence.md) — IPC save bridge details
- [World engine](world-engine.md) — what the sanity scripts exercise
- [Main README](../README.md) — user-facing build instructions
