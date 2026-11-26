# LiDAR Pipeline & Point-Cloud Renderer

**Source:** `src/lidar.ts` · **Config:** `src/config.ts` (`QUALITY`, `WEATHER`, `MAT_INFO`)

The LiDAR is the game. Every visible pixel of the environment is a measurement produced by this
pipeline. It runs in five stages:

```
scan generator → world raycast queries → measurement processor → latency queue → GPU point cloud
                                              │
                                              └──► delayed CycleSnapshot → perception
```

## Tech stack

- **three.js** `Points` with a **custom `ShaderMaterial`** (GLSL vertex + fragment).
- Flat typed arrays (`Float32Array`) for the point ring buffer — no per-point allocations.
- `Int32Array`-backed snapshots and `Map` aggregation for perception cycles.
- Adaptive CPU ray budget using an exponential moving average of ms/ray.

## Sensor catalog

Seven tiers (`SENSORS`), each with scan rate, range, channels, vertical FOV, azimuth step, noise,
dropout, latency, processing delay and price:

| Model | Tier | Hz | Range | Channels | Az step | Noise | Latency | Proc. delay |
|-------|------|----|-------|----------|---------|-------|---------|-------------|
| LDR-100 BASIC | 1 | 10 | 60 m | 8 | 1.20° | 0.055 m | 130 ms | 260 ms |
| LDR-250 | 2 | 15 | 90 m | 12 | 0.80° | 0.042 m | 105 ms | 210 ms |
| LDR-500 | 3 | 15 | 120 m | 16 | 0.55° | 0.033 m | 85 ms | 170 ms |
| LDR-1000 | 4 | 20 | 160 m | 24 | 0.40° | 0.026 m | 65 ms | 130 ms |
| LDR-2000 | 5 | 20 | 200 m | 32 | 0.30° | 0.020 m | 48 ms | 95 ms |
| LDR-5000 | 6 | 25 | 235 m | 48 | 0.22° | 0.015 m | 32 ms | 62 ms |
| LDR-X EXPERIMENTAL | 7 | 30 | 280 m | 64 | 0.16° | 0.010 m | 16 ms | 30 ms |

`effectiveSpec()` applies upgrade multipliers (frequency, range, density/azimuth, noise, latency)
and the user's sweep-speed setting.

### Auxiliary sensor pods (`AUX_SENSORS`)

Fused into the same cloud, each with its own coverage, weather immunity and cap:

- **RD-77 LONGSHOT RADAR** — 77 GHz, 250 m, weather-immune (`immune: 0.9`).
- **CAM-HD STEREO** — very dense, short range, collapses at night and in bad weather.
- **ULS-24 ULTRASONIC RING** — 9 m, 360°, weather-immune.
- **US-8 ULTRASONIC SPOTTER** — 5 m, 110° forward arc.
- **GNSS-RTK LOCATOR** — no returns; sharpens localization/autonomy.

Aux rays share the frame ray budget (up to 35% of it).

## Stage 1 — scan generator

- Azimuth advances in `azStepDeg` increments; a full 360° rotation completes a scan cycle.
- Each channel's vertical angle is interpolated across `[vFovBottom, vFovTop]`.
- Rays are traced in a deterministic order per cycle, with two cheap LOD rules
  (skip alternating edge channels, thin top channels) that cut cost without visible holes.
- Weather scales effective range, noise and dropout; the environmental filter upgrade recovers
  part of the degradation:

```ts
rangeMul  = weather.rangeMul + (1 - weather.rangeMul) * filtering * 0.7
noiseMul  = (1 + (weather.noiseMul - 1) * (1 - filtering * 0.75)) * (1 + interference * 4)
maxDist   = effectiveRange * rangeMul
```

## Stage 2 — world queries

Each ray calls `World.raycast()` against the analytic scene. Occlusion is therefore exact: a
building physically blocks the road behind it. A miss produces nothing; no points are invented.

## Stage 3 — measurement processor

For each hit:

1. **Dropout** — `weather.dropout + sensor.dropout`, increasing with relative range.
2. **Range noise** — triangular random error scaled by `noiseM`, weather, obstruction damage and
   `pow(rel + 0.15, 1.4)`.
3. **Vertical jitter** — small random y offset for volumetric believability.
4. **Intensity** — material reflectivity × object override × distance falloff
   `(1 − 0.55·rel)` × random 0.85–1.15, clamped to `[0.02, 1.2]`.
5. **Aggregation** — object hits accumulate into a per-group `CycleObjAgg` (count, centroid sum,
   AABB, material). Ground hits in a forward cone become `[x, z, mat]` road samples.

## Stage 4 — latency queue

- Every point is enqueued with a `readyTime = now + latencyMs/1000` into a flat `Float32Array`
  queue (`QUEUE_CAP = 262,144` entries × 7 floats).
- `flushQueue(now)` moves matured points into the GPU ring buffer. The queue is a circular buffer;
  overflow simply drops the newest measurement, which behaves like a saturated sensor.
- At cycle end, a **`CycleSnapshot`** (object aggregates + ground samples) is pushed with
  `readyTime = now + procDelayMs/1000`. Up to 8 snapshots are retained. This is what makes
  autonomy react late, like a real perception stack.

## Stage 5 — GPU point cloud

- Ring buffer capacity by quality: 60k / 150k / 280k / 450k points.
- Attributes: `position`, `aBirth`, `aIntens`, `aMat`, `aDist`.
- Vertex shader:
  - age fade `1 - smoothstep(life*0.55, life, age)`
  - far fade at 80–100% of sensor range
  - per-point size scaled by `1/−viewZ`
  - mode colorization (`uMode` 0–6): point cloud, distance, height, intensity, detection,
    semantic, wireframe
- Fragment shader discards outside a circular sprite and applies a soft edge.
- `uLife` is the scan-persistence setting; `pointForever` keeps points until ring reuse.

### Visualization mappings

| Mode | Index | Color source |
|------|-------|--------------|
| Point Cloud | 0 | Intensity-tinted cyan/white |
| Distance | 1 | Red → orange → yellow → green → cyan → blue ramp |
| Height | 2 | Blue → cyan → green → yellow → red by Y |
| Intensity | 3 | Dark blue → violet → near-white by reflectivity |
| Detection | 4 | Semantic palette for dynamic classes, dimmed static |
| Semantic | 5 | Full `MAT_INFO.semanticColor` palette |
| Wireframe | 6 | Sparse geometry-colored points, low alpha |

Detection/wireframe also draw 3D bounding boxes through `BoxLayer` (line segments per track).

## Quality presets

| Preset | Max points | Rays/frame | Point size | Labels |
|--------|-----------|------------|------------|--------|
| low | 60,000 | 1,400 | 2.0 | no |
| medium | 150,000 | 3,000 | 2.2 | no |
| high | 280,000 | 4,800 | 2.4 | yes |
| ultra | 450,000 | 7,000 | 2.6 | yes |

The actual per-frame budget is clamped further to hit a ~5 ms raycast target.

## Related documentation

- [World engine](world-engine.md) — the geometry being scanned
- [Perception](perception.md) — the consumer of `CycleSnapshot`
- [UI](ui.md) — visualization mode controls
