# Perception Engine

**Source:** `src/perception.ts` · **Consumers:** `src/autonomy.ts`, `src/hud.ts`, `src/missions.ts`

The perception engine turns delayed LiDAR cycles into a persistent object list and a drivable
road estimate. It is deliberately imperfect: classification is confidence-gated, tracks expire,
and the road estimate can go invalid — which forces autonomy to slow down or stop.

## Tech stack

- Plain **TypeScript** with `Map<string, Track>` track tables.
- **three.js** scene for `BoxLayer` bounding-box lines.
- No ground truth for autonomy: the engine receives only `CycleSnapshot` aggregates + ground
  samples produced by the LiDAR pipeline.

## Input: `CycleSnapshot`

Delivered by `LidarSystem.onCycle` after the sensor's processing delay:

```ts
interface CycleSnapshot {
  time: number; readyTime: number; cycle: number;
  sensorX: number; sensorY: number; sensorZ: number; yaw: number;
  range: number;
  objs: CycleObjAgg[];       // per-group centroid, AABB, count, material
  ground: number[];          // [x, z, mat] road samples, forward cone only
}
```

## Track lifecycle

For every object aggregate in the snapshot:

1. **Range gate** — reject beyond `range * 1.05`.
2. **Sparsity gate** — fewer than 2 points beyond 45 m, or fewer than 4 beyond 90 m, is
   unrecognizable and ignored.
3. **Create or update** a `Track` keyed by object group id.
4. **Velocity** — center-of-mass delta over time, smoothed 55/45, only with ≥6 points and
   plausible speeds (< 60 m/s).
5. **Extents** — half-extents derived from the point AABB (minimum 0.25 m).
6. **Classification** — confidence blends point count, distance and recognition level:

```ts
base   = 0.46 + 0.5 * min(1, n / 8)
distF  = 1 - clamp((dist - range*0.4) / (range*0.6), 0, 1) * 0.45
recogF = 0.66 + 0.34 * recognitionLevel
conf   = clamp(base * distF * recogF + jitter, 0, 0.99)
cls    = conf >= 0.46 ? trueClass : 'unknown'
```

7. **Confirmation event** — first time a track reaches ≥5 points and ≥0.62 confidence it counts
   as a detection (missions, scoring, audio blip).
8. **Hazard / TTC** — for hazard classes within 60 m and inside the forward corridor:
   - closing speed from relative velocity projected onto the line of sight
   - `ttc = dist / closing` (fallback 3.2 s)
   - hazard if `ttc < 3.6 s`, or a non-pedestrian is within 9 m and nearly stationary
9. **Expiry** — tracks unseen for 1.6 s are dropped; high-confidence/hazard losses increment
   `lostWarnings`.

## Road-space estimation

`estimateRoad()` uses only scanned ground returns in a forward window
(`3 m < forward < 58 m`, `|lateral| < 15 m`):

- **Asphalt points** (`MAT.ASPHALT`, `MAT.TARMAC_DARK`) give a corridor. With ≥14 samples the
  principal axis of the forward/lateral covariance yields road heading; lateral variance gives
  width (`2.6·√var`, clamped 3–24 m) and mean lateral offset.
- **Paint points** (`MAT.PAINT`) give lane bands. With ≥6 samples the center and width of the
  paint band are blended in (55% weight) and confidence rises sharply.
- If both are too sparse (`paint < 4` and `asphalt < 18`), `valid = false`.

Outputs (`RoadEstimate`): `valid`, `heading`, `lateralOffset`, `width`, `paintPoints`,
`asphaltPoints`, `confidence`.

This is the only source of lane geometry for autonomy. In fog or on unmarked surfaces the
estimate degrades, and the planner responds conservatively.

## Query API

| Method | Purpose |
|--------|---------|
| `ingest(snapshot, now, vx, vz, vyaw, range)` | Update tracks and road estimate |
| `objectsInCorridor(vx, vz, vyaw, fwdMax, latMax)` | Objects inside a forward rectangle (ACC, route planning) |
| `nearestHazard(vx, vz, vyaw, maxDist)` | Lowest-TTC hazard in the forward path (AEB) |
| `updateBoxes(vizMode, vx, vz, now)` | Build detection/wireframe boxes |
| `reset()` | Clear tracks and invalidate road on mission restart |

## Detection boxes (`BoxLayer`)

- Visible only in DETECTION and WIREFRAME modes.
- Skips tracks below 0.32 confidence or beyond 130 m.
- Color by class: hazard red, vehicle cyan, pedestrian green, signage amber, unknown gray.
- Alpha/color dims with staleness (`1 − age/1.6 s`), so lost objects visibly fade.
- Caps at 96 boxes for predictable cost.

## Tuning surface

- `recognitionLevel` is set from upgrades/research (0–1) and directly controls classification
  quality.
- Sensor range is passed in each cycle, so upgrading the LiDAR widens classification distance.
- Hazard thresholds and track expiry live in `perception.ts`; world/weather tuning lives in
  `config.ts`.

## Related documentation

- [LiDAR pipeline](lidar-pipeline.md) — snapshot production
- [Autonomy](autonomy.md) — confident vs. conservative driving
- [Missions & economy](missions-economy.md) — detection objectives and rewards
