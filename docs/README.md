# PERCEPTION — Documentation

Technical documentation for **PERCEPTION**, a LiDAR driving simulator where the world is fully
modeled in 3D but only ever made visible through a simulated scanning sensor.

> You don't see the road. You understand it.

---

## Tech Stack

| Layer | Technology | Role |
|-------|------------|------|
| Language | **TypeScript 5** (strict, bundled) | All simulation, rendering and game logic |
| Renderer | **three.js 0.170** (WebGL 2) | Scene graph, point-cloud rendering, custom `ShaderMaterial` |
| Shading | **GLSL** (vertex + fragment) | Ring-buffered point positions, age fade, mode-based GPU colorization |
| Spatial index | **Custom uniform spatial hash + 2D DDA raycaster** | Analytic ray/box/cylinder/sphere intersection at thousands of rays per frame |
| Physics | **Custom arcade EV model** | Bicycle-model steering, grip, braking, battery, damage |
| UI | **Vanilla DOM + CSS + Canvas 2D** | HUD panels, menus, garage, research lab, minimap, map overlay |
| Audio | **Web Audio API** | Fully synthesized engine, scan ticks, blips, AEB, ambience — zero audio assets |
| Desktop shell | **Electron 33** | Window, IPC save bridge, PNG capture, crash/renderer logging |
| Build (renderer) | **esbuild 0.24** | Single IIFE bundle `dist/game.js`, target Chrome 120, minified |
| Packaging | **electron-builder 25** | Windows x64 portable `.exe` + NSIS installer |
| Persistence | **JSON via Electron `userData`**, `localStorage` fallback | Profile, settings, mission records |
| Tests / tools | **Node + tsx-style scripts** | Headless world sanity checks (`src/test-world.ts`, `src/pw-dbg.ts`) |
| Platform | **Windows x64** (source runs cross-platform) | Target distribution |
| License | **MIT** | JohnLC Studios Open Source Softwares |

### Runtime architecture

```
 Input (keyboard / mouse / wheel)
        │
        ▼
 ┌──────────────┐      analytic primitives + spatial hash + DDA
 │    World     │◄──────────────────────────────────────────────┐
 └──────┬───────┘                                               │
        │ raycast queries                                       │
        ▼                                                       │
 ┌──────────────┐   measurement processor   ┌────────────────┐  │
 │ LidarSystem  │── noise · dropout · ─────►│  CycleSnapshot │  │
 └──────┬───────┘   weather · latency       └───────┬────────┘  │
        │ pooled point cloud                        │ delayed  │
        ▼                                           ▼          │
 ┌──────────────┐                            ┌────────────┐     │
 │ three.js GPU │                            │ Perception │     │
 │  point cloud │                            │   Engine   │     │
 └──────────────┘                            └─────┬──────┘     │
        ▲                                          │ tracks +  │
        │                                          │ road est. │
        │                                    ┌─────▼──────┐    │
        └────────────────────────────────────┤ Autonomy   │    │
                                             │  Driver    │────┘
                                             └─────┬──────┘
                                                   │ throttle/brake/steer
                                                   ▼
                                             ┌───────────┐
                                             │  Vehicle  │
                                             └───────────┘
```

---

## Infrastructure documentation

Every subsystem has its own document. These are the same links exposed in the main
[README](../README.md#documentation).

| Infrastructure | Document | What it covers |
|----------------|----------|----------------|
| World simulation & raycasting | [world-engine.md](world-engine.md) | Analytic primitives, spatial hash, DDA ray traversal, districts, roads, traffic agents, dynamic events |
| LiDAR pipeline & renderer | [lidar-pipeline.md](lidar-pipeline.md) | Scan generation, sensor catalog, measurement noise/weather, latency queue, aux sensor fusion, ring buffer, shaders |
| Perception engine | [perception.md](perception.md) | Track aggregation, classification confidence, velocity, hazard/TTC, road-space estimation |
| Autonomous driving | [autonomy.md](autonomy.md) | Six autonomy modes, ACC/AEB/lane keeping, route following, confidence gating |
| Vehicle system | [vehicle.md](vehicle.md) | EV physics, steering, battery, damage, collisions, vehicle catalog, cockpit/chase cameras |
| Missions & economy | [missions-economy.md](missions-economy.md) | Six chapters, objectives, scoring, credits/research/XP, upgrades, research tree, reputation |
| HUD, menus & input | [ui.md](ui.md) | Driving HUD, minimap, visualization modes, menu screens, input handling, settings |
| Persistence | [persistence.md](persistence.md) | Save schema, Electron IPC bridge, localStorage fallback, migrations |
| Audio | [audio.md](audio.md) | Web Audio graph, synthesized engine, SFX, weather ambience, lifecycle |
| Build & packaging | [build-packaging.md](build-packaging.md) | esbuild pipeline, Electron main/preload, electron-builder targets, distribution |

---

## Repository layout

```
PERCEPTION/
├── app/                 index.html + style.css (renderer shell)
├── src/                 TypeScript simulation and game logic
│   ├── config.ts        tuning constants, weather model, materials, viz modes
│   ├── data.ts          upgrade / research / paint catalogs
│   ├── world.ts         analytic world, spatial hash, raycaster, traffic
│   ├── lidar.ts         LiDAR scan pipeline + GPU point-cloud renderer
│   ├── perception.ts    tracking, classification, road estimation
│   ├── autonomy.ts      driving AI consuming perception only
│   ├── vehicle.ts       EV physics, meshes, cameras, battery, damage
│   ├── missions.ts      chapters, objectives, scoring
│   ├── economy.ts       prices, rewards, rating math
│   ├── save.ts          profile + settings persistence
│   ├── hud.ts           HUD rendering and minimap
│   ├── menu.ts          menu / career / garage / research / settings
│   ├── input.ts         keyboard, mouse, wheel
│   ├── audio.ts         synthesized Web Audio engine
│   └── main.ts          game loop and system glue
├── electron/            main.cjs + preload.cjs
├── build.mjs            esbuild renderer build
├── docs/                this documentation + screenshot
├── landing/             single-file HTML landing page
└── release/             electron-builder output (generated)
```

## Design rules

1. **The world is never drawn as ordinary geometry.** Only LiDAR returns become pixels.
   The player vehicle, cockpit and UI are the only lit meshes.
2. **The autonomy stack may only consume perception output.** It never reads ground truth
   positions. Low confidence must degrade to slow/stop, not to cheating.
3. **All tuning lives in `config.ts` / catalogs in `data.ts`.** Avoid magic numbers in systems.
4. **Assets are optional.** Textures and audio files are not required; shading and sound are
   generated in code.

## Related links

- [Main README](../README.md) — features, controls, build instructions
- [Landing page](../landing/index.html) — single-file product page
- [License](../LICENSE) — MIT
