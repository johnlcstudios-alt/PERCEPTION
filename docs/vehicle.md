# Vehicle System

**Source:** `src/vehicle.ts` · **Depends on:** `world.ts` (collision), `audio.ts`, `input.ts`

The player vehicle is one of the few actually lit meshes in the scene. It carries the simulated
sensor, so its mount point defines the origin of every LiDAR ray. Physics is an arcade EV bicycle
model tuned for readability rather than realism.

## Tech stack

- **three.js** `Group` assembled from primitive meshes (body, cabin, wheels, lights, sensor pod,
  cockpit display texture).
- **Custom arcade physics** — forward/lateral velocity decomposition, exponential grip damping,
  bicycle-model yaw, drag and regen braking.
- **Canvas 2D** instrument screen redrawn at ~5 Hz onto a `CanvasTexture`.
- **Web Audio** drivetrain synthesized from speed/throttle each frame.

## Vehicle catalog (`VEHICLES`)

| Model | Price | Max speed | Accel | Grip | Wheelbase | Sensor slots | AI bonus | Battery |
|-------|-------|-----------|-------|------|-----------|--------------|----------|---------|
| KIRO COMPACT EV | 0 | 33 m/s | 6.2 | 8.5 | 2.55 m | 3 | 0 | 100 |
| MERIDIAN SEDAN | 34,000 | 39 m/s | 7.6 | 9.2 | 2.85 m | 4 | +0.15 | 130 |
| TERRA SURVEY SUV | 52,000 | 36 m/s | 6.8 | 7.8 | 2.90 m | 5 | +0.20 | 150 |
| VELOCITA PERFORM. | 92,000 | 47 m/s | 11.5 | 10.8 | 2.70 m | 4 | +0.10 | 120 |
| AXIOM PROTOTYPE | 165,000 | 44 m/s | 10.2 | 11.2 | 2.95 m | 7 | +0.45 | 200 |

Each spec also defines body dimensions, paint, and a description. Higher `aiBonus` improves the
autonomy stack's capability.

## Physics model

### Steering

- Maximum steer angle shrinks with speed: `0.55 / (1 + |v|·0.05)`.
- Steering is damped toward target at rate 9 (`damp` from `input.ts`), preventing instant snaps.

### Drive / brake

- Throttle accelerates with a soft speed ceiling: `accel · (1 − v / (maxSpeed·1.06))`.
- Brake decelerates; below 0.5 m/s with no throttle it engages reverse (capped at 28% max speed).
- Handbrake applies exponential speed decay and lowers lateral grip.
- Drag: `0.35·v + 0.011·v·|v|`.
- Damage reduces max speed and grip (`1 − damage·0.45`); a dead battery limits power to 35%.

### Lateral grip and yaw

- Lateral velocity decays exponentially at rate `grip` (`×0.22` with handbrake).
- Yaw rate: `(v / wheelbase) · tan(steer)` — bicycle model.
- Velocity is recomposed from forward/lateral components each frame.

### Collisions

- Two collision circles at `±0.3·bodyLength` with radius `bodyW/2 + 0.12`.
- `World.collideCircle()` pushes the vehicle out and returns a normal.
- Impacts above 1.6 m/s add damage and sensor damage, record a `CollisionEvent`
  (time, severity, speed) and trigger collision audio.
- Impact response reflects velocity with a 1.5× restitution and scrubs 28% speed.

### Battery

- Drain = idle + throttle load (speed-weighted) + brake load.
- Braking above 2 m/s regenerates a small amount.
- Drain is normalized by `batteryCap`, so bigger packs last longer.
- Missions fail if battery reaches 0 or damage reaches 1.

## Sensor mount

`sensorMountWorld()` places the LiDAR origin at roof height (`bodyH + 0.24`) slightly forward of
center (`−0.05·bodyLength`). All raycasts in `LidarSystem.update()` start from this point.

## Visuals & feedback

- Wheels spin with forward speed; front wheels steer visually.
- Cockpit steering wheel rotates with steering input.
- Headlights fade in at night; the world itself remains points.
- Instrument screen (speed, battery, gear, autonomy mode/status, viz mode, road state) is drawn
  to a canvas texture and refreshed at 5 Hz to keep the cost low.
- `setPaint()` updates the body material; paints come from the garage catalog.

## Damage & condition

- `damage` (0–1): body condition, reduces performance.
- `sensorDamage` (0–1): feeds LiDAR obstruction/noise penalties.
- Garage repair costs scale with damage (`economy.repairCost`).

## Related documentation

- [World engine](world-engine.md) — collision and ground
- [LiDAR pipeline](lidar-pipeline.md) — rays originate at the sensor mount
- [Audio](audio.md) — drivetrain synthesis
- [Missions & economy](missions-economy.md) — damage/battery failure and repair costs
