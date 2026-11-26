# HUD, Menus & Input

**Sources:** `app/index.html`, `app/style.css`, `src/hud.ts`, `src/menu.ts`, `src/input.ts`,
`src/config.ts` (`VIZ_MODES`, `AUTONOMY_MODES`)

The interface is deliberately diegetic: dark panels, cyan instrumentation, monospace numerics.
It is built from plain DOM and two canvases (minimap + map overlay) — no UI framework.

## Tech stack

- **Vanilla HTML/CSS** with CSS custom properties, grid/flex layout and panel styling.
- **DOM updates** driven from the game loop; no virtual DOM or reactive framework.
- **Canvas 2D** for the minimap, big map, and the vehicle's instrument screen texture.
- **Input** via `keydown`/`keyup`, pointer drag, and wheel listeners with focus-loss cleanup.

## Driving HUD

| Region | Contents |
|--------|----------|
| Top-left | Sensor panel: model, aux pod, scan Hz, range, density (pts/s), tracks, latency, visualization mode |
| Top-center | Warning stack (low confidence, AEB, obstruction, mission warnings) |
| Top-right | Environment: weather, clock, district, GNSS coordinates |
| Left | Vehicle: speed, gear, battery bar, condition bar; Autonomy: mode, status, route |
| Right | Detected objects: class, distance, confidence, hazard marker |
| Bottom | Mission title/objective/progress; navigation destination and distance |
| Overlay | Minimap (normal / maximized / minimized), visualization hint, tutorial tip |
| Map overlay | Large map; click sets an autonomy destination |
| Toast | Transient notifications (purchases, unlocks, events) |

The HUD is hidden while in menus and shown during driving. Mission results replace it with a
rating screen (C→S), score, time, collisions and reward breakdown.

## Screens (`menu.ts`)

| Screen | Purpose |
|--------|---------|
| Main menu | Continue, Career, Free Roam, Garage, Research Lab, Settings, About |
| Career | Six chapters with 18 missions, locks, best ratings and rewards |
| Garage | Vehicles, LiDAR sensors, auxiliary pods, upgrades, paint customization, repairs |
| Research Lab | Research tree with RD/CR costs and prerequisite chains |
| Settings | Quality, volume, FOV, labels, minimap, sweep, camera, invert Y, scan persistence, sweep speed |
| About | Version, studio, license, fictional-equipment disclaimer |
| Pause | Resume, restart mission, abort to menu, settings |
| Results | Rating, score, stats, rewards; continue / retry / main menu |

The menu system reads and mutates the live `Profile` and calls back into the game for mission
start, free roam, equipment changes, settings changes and profile edits.

## Visualization modes

| Key | Mode | Research unlock |
|-----|------|-----------------|
| 1 | POINT CLOUD | — |
| 2 | DISTANCE | — |
| 3 | HEIGHT | `vizHeight` |
| 4 | INTENSITY | `vizIntensity` |
| 5 | DETECTION | `vizObjects` |
| 6 | SEMANTIC | `vizSemantic` |
| 7 | WIREFRAME | `vizWireframe` |

`V` cycles through unlocked modes; `1–7` select directly. The sensor panel and hint text update
immediately.

## Input mapping (`input.ts`)

| Input | Action |
|-------|--------|
| `W` / `S` or `↑` / `↓` | Throttle / brake-reverse |
| `A` / `D` or `←` / `→` | Steer |
| `Space` | Handbrake |
| `C` | Cycle camera: chase → far → cockpit → cinematic |
| Mouse drag | Orbit / free-look camera |
| Mouse wheel (minimap) | Minimap size |
| `N` | Cycle minimap mode |
| `V` / `1–7` | Visualization mode |
| `T` | Cycle autonomy mode |
| `M` | Map overlay / set destination |
| `R` | Recover vehicle to the road |
| `Esc` / `P` | Pause |

`Input` tracks `down`, `pressed` and `released` sets per frame, exposes mouse deltas and wheel
delta, and clears state on window blur so keys never stick. It also prevents default scrolling
for gameplay keys.

## Minimap

- Canvas 220×220 (CSS-scaled), drawn from world roads, POIs and perception tracks.
- Modes: normal, maximized, minimized.
- Shows player heading, route, discovered locations, hazards and traffic near the player.
- The big map uses the same projection at 900×900; clicking sets an autonomy destination and
  triggers routing.

## Accessibility & clarity

- Numeric readouts use tabular monospace figures.
- Warnings use icon + color + text, not color alone.
- All menu actions are real buttons with focus states.
- Panels avoid covering the central view; the HUD is edge-anchored.

## Related documentation

- [LiDAR pipeline](lidar-pipeline.md) — data behind sensor/viz panels
- [Missions & economy](missions-economy.md) — career, garage and research content
- [Persistence](persistence.md) — settings and profile storage
