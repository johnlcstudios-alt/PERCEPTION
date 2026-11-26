# Autonomous Driving

**Source:** `src/autonomy.ts` · **Depends on:** `perception.ts`, `vehicle.ts`, `world.ts`

The autonomy stack consumes **only perception output** — tracked objects and the road-space
estimate — plus map routing data (road graph and speed limits). It never reads true positions of
other objects. That constraint is what makes the six modes feel like a real driving stack:
uncertainty produces braking and stops, not omniscience.

## Tech stack

- Plain **TypeScript** control loop, no external planner library.
- **Pure-pursuit steering** with curvature-based speed limiting.
- **A\*/graph routing** from `World.findPath()` over road nodes.
- PID-like speed loop writing directly into `Vehicle.ctrl`.

## Modes

| Mode | Name | Behavior |
|------|------|----------|
| 0 | MANUAL | No assistance; LiDAR is only your eyes |
| 1 | DRIVER ASSIST | Collision warnings + Automatic Emergency Braking |
| 2 | ACTIVE ASSIST | AEB + adaptive cruise + lane-keeping assist |
| 3 | SUPERVISED AUTONOMY | Route following; player may intervene | 
| 4 | ADVANCED AUTONOMY | Faster cruise, obstacle avoidance around blocked lanes |
| 5 | EXPERIMENTAL | Full navigation authority, same planner with endgame progression |

Modes 3–5 require a destination (set from the map) and a valid route. Research unlocks modes 2–5
through the `auto2`…`auto5` tech tree.

## Control pipeline

### 1. AEB (mode ≥ 1)

`nearestHazard()` returns the lowest-TTC track in a narrow forward corridor. If `ttc < 2.1 s` and
speed > 0.8 m/s, brake is forced to 1 and status becomes `AEB ACTIVE`.

### 2. ACC + lane keeping (mode 2, not on route)

- Scans a 45 m corridor (2.8 m half-width) for the nearest dynamic lead.
- Status reflects `ACC ACTIVE` or `LANE ASSIST`.
- Lane-keeping blends a steering correction toward the perceived road center when the driver is
  not actively steering.

### 3. Route following (mode ≥ 3, active)

1. **Target point** — progress along route nodes, look-ahead distance
   `clamp(|speed|·1.15, 7, 30) m`, interpolating between nodes.
2. **Desired speed** — cruise 13 m/s (×1.25 in mode 4+), capped by map speed limit.
3. **Weather caps** — rain 18, heavy rain/fog 13, dust 11 m/s.
4. **Road confidence gating** — the core design rule:

| Condition | Response |
|-----------|----------|
| invalid or `confidence < 0.15` | desired speed 0 → `STOPPED - LOW CONFIDENCE`; after 4 s `REQUESTING MANUAL INTERVENTION` |
| `confidence < 0.35` | desired speed ≤ 6.5 → `LOW CONFIDENCE - SLOWING` |

   The optional GNSS-RTK/IMU pod relaxes these floors to 0.10 / 0.28 and tightens lane-center
   correction, because dead-reckoned position remains valid.

5. **Obstacle response** — nearest object in a forward corridor; safe distance
   `6.5 + |speed|·0.55`. Inside it, desired speed falls proportionally; very close becomes
   `STOPPED - OBSTACLE`. Mode 4+ probes left/right corridors and biases steering around a
   fully blocked lane.
6. **Pedestrian caution** — any pedestrian within 18 m ahead and 6.5 m lateral caps speed at
   4.5 m/s.
7. **Curvature limiter** — `15 / (2.6·|alpha|)` clamped 3.5–40 m/s.
8. **Speed loop** — throttle from positive error, brake from negative error.
9. **Pure-pursuit steer** — `atan2(2·wheelbase·sin(alpha), lookahead)`, plus a heading-error
   correction and lane-center offset.
10. **Arrival** — near destination, under 2.5 m/s → `ROUTE COMPLETE`, brakes to a stop.

## Intervention

`checkIntervention(steer, brake)` disengages active autonomy when the player steers hard
(`|steer| > 0.3`) or brakes hard (`brake > 0.6`):

- status becomes `REQUESTING MANUAL INTERVENTION`
- mode is reduced to ≤ 1
- `interventions` counter increments (used by missions and scoring)
- a 2.5 s latch prevents immediate re-engagement

## Telemetry exposed

`AutonomyDriver` exposes `mode`, `status`, `active`, `route`, `routeComplete`, `interventions`,
`aebEvents`, `lowConfTimer`, `stoppedTimer`, `gnss`, plus the current `avoidBias`. The HUD and
mission system read these directly.

## Status vocabulary

`STANDBY`, `AEB READY`, `AEB ACTIVE`, `ACC ACTIVE`, `LANE ASSIST`, `FOLLOWING ROUTE`,
`OBSTACLE - SLOWING`, `STOPPED - OBSTACLE`, `LOW CONFIDENCE - SLOWING`,
`STOPPED - LOW CONFIDENCE`, `REQUESTING MANUAL INTERVENTION`, `ROUTE COMPLETE`, `PARKING ASSIST`.

## Related documentation

- [Perception](perception.md) — the only sensor input to the planner
- [Vehicle](vehicle.md) — actuator model receiving the control outputs
- [World engine](world-engine.md) — road graph used for routing
