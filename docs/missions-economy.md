# Missions & Economy

**Sources:** `src/missions.ts`, `src/economy.ts`, `src/data.ts` · **UI:** `menu.ts`, `hud.ts`

Progression is a loop of missions → credits/research/XP → equipment and research → harder
missions and new districts. Six chapters contain eighteen scripted missions plus free-roam.

## Tech stack

- **TypeScript** data-driven definitions (`MISSIONS`, `UPGRADES`, `RESEARCH`, `PAINTS`).
- Runtime objective state machine (`MissionRunner`) with no external dependencies.
- Persistence through `save.ts`; UI through `menu.ts`.

## Campaign structure

| Chapter | Theme | Missions |
|---------|-------|----------|
| 1 | Sensor basics (test facility) | SENSOR AWAKENING, TESTING GROUND, PRECISION PARKING |
| 2 | Understanding the world | KNOW YOUR WORLD, MOVING HAZARDS, INTERSTATE ENTRY |
| 3 | City driving | CORRIDOR RUN, RUSH HOUR, AFTER DARK |
| 4 | Highway | MERGE AND FLOW, FAR HORIZON, SUDDEN OBSTACLE |
| 5 | Adverse weather & terrain | STORM PROTOCOL, WHITEOUT, RIDGE RUN |
| 6 | Autonomy endgame | HANDS OFF, FREIGHT RUNNER, THE PERCEPTION TRIAL |

Each mission definition carries region, weather, objectives, time limit, par time, rewards and
optional constraints (`maxCollisions`, `maxInterventions`).

## Objective types

| Type | Success condition |
|------|-------------------|
| `reach` | Within radius of a point, under 12 m/s |
| `detections` | At least N tracks of a class with confidence ≥ 0.6 |
| `scanMarker` | Hold a position/scan for N seconds |
| `park` | Within bay, aligned (within yaw tolerance), nearly stopped, held 2 s |
| `speedAbove` | Maintain ≥ speed for cumulative seconds |
| `modeUse` | Drive with autonomy mode ≥ N active for cumulative seconds |

Objectives run sequentially; the HUD shows the current objective and progress.

## Failure conditions

- Vehicle damage reaches 100%.
- Battery reaches 0%.
- Time limit exceeded.
- `maxCollisions` or `maxInterventions` constraint exceeded.

Failure yields zero rewards and rating C.

## Scoring & ratings

```ts
timeScore   = clamp(parTime / elapsed, 0, 1) * 100   // 80 if no par time
safetyScore = max(0, 100 - collisions * 22)
score       = round(safetyScore * 0.55 + timeScore * 0.45)
```

| Score | Rating | Reward multiplier |
|-------|--------|-------------------|
| ≥ 90 | S | 1.50× |
| ≥ 75 | A | 1.25× |
| ≥ 58 | B | 1.00× |
| < 58 | C | 0.70× |

Rewards are credits (CR), research data (RD) and XP, each multiplied by the rating multiplier.
Mission records store best rating, best score and completion count.

## Economy

### Currencies

- **Credits (CR)** — earned from missions, free-roam points of interest, sold/repeat missions.
- **Research Data (RD)** — rarer; spent in the Research Lab.
- **XP / reputation** — unlocks districts at thresholds 80 / 220 / 420 / 650 / 950.
- **Ranks** — ROOKIE OPERATOR → OPERATOR → SPECIALIST → ENGINEER → AUTONOMOUS OPERATOR →
  MASTER OPERATOR.

### Upgrades (`UPGRADES`, 8 categories)

| Upgrade | Max level | Effect per level |
|---------|-----------|------------------|
| Oscillator Array | 5 | +12% scan frequency |
| Density Module | 5 | −9% angular spacing |
| Vertical Expander | 4 | +2 scan channels |
| Range Optics | 5 | +14% range |
| Recognition Net | 4 | Recognition quality +11% (base 55%) |
| Weather Filter | 3 | −25% weather degradation |
| Neural Accelerator | 4 | −15% processing latency |
| Calibration Rig | 4 | −12% measurement noise |

Costs escalate per level (catalog in `data.ts`); the Research Lab's Multi-Band Filtering adds one
extra environmental-filter level.

### Research tree (`RESEARCH`)

| Category | Unlocks |
|----------|---------|
| Point Cloud Processing | HEIGHT, INTENSITY, WIREFRAME visualization, extended scan history |
| Object Recognition | DETECTION boxes → SEMANTIC segmentation |
| Autonomous Navigation | Modes 2 → 3 → 4 → 5, gated by prerequisites |
| Environmental Filtering | Extra filter level, Scan History Mapping |

Research costs RD + CR and enforces prerequisite chains (`req`).

### Free roam & points of interest

`POIS` in `world.ts` are ten discoverable landmarks across all districts, each with a credit,
research and XP reward. They provide a non-mission income path and encourage exploration.

## Related documentation

- [Perception](perception.md) — detection objectives and confidence thresholds
- [Autonomy](autonomy.md) — mode-use objectives and intervention penalties
- [Persistence](persistence.md) — saved credits, research, equipment and records
- [UI](ui.md) — career, garage and research screens
