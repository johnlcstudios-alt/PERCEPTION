# Persistence

**Sources:** `src/save.ts`, `electron/main.cjs`, `electron/preload.cjs`

One profile JSON holds all progression and settings. It is written to Electron's `userData`
directory through a context-isolated IPC bridge, with `localStorage` as a browser fallback.

## Tech stack

- **Electron `contextBridge` + `ipcMain.handle`** — no direct Node access in the renderer.
- **JSON** serialization of the `Profile` object.
- **`localStorage`** fallback (`perception.profile`) for non-Electron runs.
- Debounced writes (2 s) with an explicit `flush(true)` for critical changes.

## Save location

Electron `app.getPath('userData')`:

```
%APPDATA%/PERCEPTION/profile.json        (Windows)
```

File names are sanitized (`[^a-z0-9_\- .]` → `_`) before joining. The same bridge also stores
screenshots (`perception:save-png`), captures (`app:capture`) and `crash-log`.

## Bridge API (`window.perceptionHost`)

| Method | IPC channel | Purpose |
|--------|-------------|---------|
| `readSave(name)` | `perception:read-save` | Read a UTF-8 JSON file |
| `writeSave(name, data)` | `perception:write-save` | Write a UTF-8 JSON file |
| `deleteSave(name)` | `perception:delete-save` | Delete a file |
| `meta()` | `perception:meta` | Version, platform, `isElectron` |
| `savePng(dataUrl, name)` | `perception:save-png` | Decode base64 PNG to disk |
| `quit()` | `app:quit` | Quit the app |
| `capture(name)` | `app:capture` | Capture the window to PNG |

All handlers catch errors and return `false`/`null` rather than throwing across IPC.

## Profile schema (version 1)

```ts
interface Profile {
  version: number;
  credits: number;
  researchData: number;
  xp: number;
  selectedVehicle: string;
  ownedVehicles: string[];
  sensorTier: number;
  auxSensors: string[];          // owned pods
  activeAux: string[];           // enabled pods
  upgrades: Record<string, number>;
  research: string[];            // completed research ids
  paint: number;
  completedMissions: Record<string, { best: string; times: number; bestScore: number }>;
  discoveredLocations: string[];
  tutorialDone: boolean;
  settings: Settings;
  stats: {
    kmDriven: number; scans: number; detections: number;
    missions: number; collisions: number; aeb: number;
  };
}
```

### Settings

```ts
interface Settings {
  quality: 'low' | 'medium' | 'high' | 'ultra';
  volume: number;          // 0..1
  fov: number;             // camera field of view
  labels: boolean;         // 3D object labels
  minimap: boolean;
  minimapSize: 'normal' | 'maximized' | 'minimized';
  sweep: boolean;          // draw the LiDAR sweep plane
  camera: 'chase' | 'far' | 'cockpit' | 'cinematic';
  invertY: boolean;
  pointLife: number;       // seconds scanned points remain visible
  pointForever: boolean;   // keep points until the ring buffer recycles
  sweepSpeed: number;      // scan/rotation rate multiplier (0.1..4)
}
```

## Load / merge strategy

`load()`:

1. Try `perceptionHost.readSave('profile')`.
2. If empty, read `localStorage['perception.profile']`.
3. `JSON.parse`.
4. Shallow-merge onto `defaultProfile()`, with deep merges for `settings` and `stats`.

This makes older saves forward-compatible: missing fields get defaults, unknown fields survive
in the parsed object but are ignored by typed consumers. Corrupt JSON is caught and silently
replaced with a fresh profile.

Defaults: 3,000 CR, 0 RD, 0 XP, KIRO COMPACT EV, sensor tier 1, no research, quality `high`,
volume 0.8, FOV 70, scan persistence 4 s.

## Write strategy

- `markDirty()` flags the profile after any mutation.
- `flush()` skips clean profiles, rate-limits to once per 2 s unless forced.
- Writes go through the host bridge; if that throws, it retries `localStorage`.
- `reset()` restores `defaultProfile()` and force-writes immediately.

The game calls `flush(true)` on mission completion, purchases, research, settings changes and
window unload points.

## Related documentation

- [Missions & economy](missions-economy.md) — what is stored
- [UI](ui.md) — where settings are edited
- [Build & packaging](build-packaging.md) — preload/main process wiring
