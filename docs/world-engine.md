# World Simulation & Raycasting

**Source:** `src/world.ts` · **Config:** `src/config.ts` (`WORLD`, `MAT`, `DISTRICTS`)

The world is a fully modeled 3D city that is **never rendered as ordinary geometry**. It exists
as analytic primitives queried by the LiDAR; only the returns become visible points. This keeps
thousands of rays per frame affordable while guaranteeing real occlusion.

## Tech stack

- **three.js** only for math types (`Vector3`) and scene meshes created by other systems.
- **Custom primitive raycasting** — no `THREE.Raycaster`, no physics engine, no meshes to traverse.
- **Uniform spatial hash** (16 m cells) with separate static and dynamic bucket chains stored in
  flat `Int32Array`s.
- **2D DDA** (digital differential analyzer) grid traversal for ray queries.
- Deterministic **mulberry32** RNG seeded per world (`20261126` by default).

## Primitives

Four analytic shape kinds are supported (`ShapeKind`):

| Kind | Shape | Intersection |
|------|-------|--------------|
| 0 | Yaw-rotated box | Slab test in local space, normal transformed back to world |
| 1 | Vertical cylinder | Quadratic side-wall solve with height clamp |
| 2 | Sphere | Quadratic solve, radius-normal returned |
| 3 | Cone | Cylinder approximation at `r * 0.62`, used for trees/rocks |

Every object stores identity (`id`, `group`, `cls`), material (`mat`), transform, dimensions,
collision radius, reflectivity override and tags. One logical object (a car) is composed of
several primitives sharing a `group`, which is how the perception engine can aggregate returns
into a single track.

## Spatial hash

- World extent: **3200 m** centered on origin (`WORLD.size`).
- Cell size: **16 m** (`WORLD.gridCell`) → **200 × 200** cells.
- `staticHeads` / `dynHeads`: per-cell linked-list heads.
- `objNext`: linked-list `next` index per object.
- Objects spanning cells are inserted into every overlapping AABB cell.
- Dynamic objects are re-bucketed each frame with `refreshDynamicGrid()`.

A ray walks the grid with the DDA algorithm, testing each cell's static then dynamic chain, and
stops as soon as the nearest confirmed hit lies before the next cell boundary. A hard guard of
512 cells bounds worst-case cost. The ground plane is tested analytically first; its material is
looked up from the road network.

## Ground materials & road network

`groundMatAt(x, z)` maps a ground hit to a `MAT` id:

- Road segments with lane markings → `MAT.ASPHALT` / `MAT.PAINT` (lane paint is a narrow center band).
- Districts outside roads → concrete, grass, dirt, rock or dark tarmac depending on region.
- Reflectivity comes from `MAT_INFO` in `config.ts` (0.03 for dark surfaces, 0.80 for signs).

Roads are segments (`RoadSeg`) with width, district and options, indexed into a coarse grid.
`buildNetwork()` builds the road graph; `buildDistricts()` populates six sectors:

| Key | Name | Center z | Theme |
|-----|------|----------|-------|
| `facility` | TEST SECTOR | −1333 | Test tracks, cones, pylons, loop gate |
| `city` | MERIDIAN SECTOR | −800 | Downtown blocks, crossings, traffic lights |
| `highway` | INTERSTATE CORE | −267 | Multi-lane interstate, rest stop |
| `industrial` | FREIGHT SECTOR | +267 | Warehouses, silos, freight yard |
| `mountain` | RIDGE PASS | +800 | Winding ridge roads, rocks, trees |
| `experimental` | POLAR GATE | +1333 | Doppler tower, prototype zone |

Road nodes (`RoadNode`) carry graph links and traffic-light flags. `findPath()` runs the routing
search used by autonomy; `randomRoadPoint(district)` samples spawn positions.

## Traffic agents

`spawnTraffic(count, peds)` creates `Agent` records bound to world objects:

- `kind`: `car` | `truck` | `pedestrian`
- lane-following along road segments with speed variation and intersection yielding
- pedestrians follow sidewalks, wait at crossings and cross on timers
- `updateAgents(dt, playerX, playerZ)` advances all agents and refreshes the dynamic grid

Traffic objects are real primitives, so they are scanned, occlude each other and can be tracked
by perception exactly like static geometry.

## Collision & queries

- `collideCircle(px, pz, radius)` resolves the player vehicle against road boundaries and
  collidable props, returning a push vector and normal.
- `raycast(ox, oy, oz, dx, dy, dz, maxDist)` returns a reused `RayHit` (`t`, object, normal,
  world hit point, material) or `null`.
- `sampleRecent()` (in `lidar.ts`) exposes recent scan points for UI/debug purposes.

## Performance notes

- Ray budget is adaptive: the LiDAR system measures milliseconds per ray and scales its per-frame
  budget toward a ~5 ms target (`targetMs` in `lidar.ts`).
- Grid traversal avoids per-ray allocation; `rayShape` writes into one reused result object.
- Static geometry is indexed once at load; only dynamics pay re-bucketing cost.

## Related documentation

- [LiDAR pipeline](lidar-pipeline.md) — how rays become points
- [Perception](perception.md) — how groups become tracks
- [Autonomy](autonomy.md) — how tracks and roads become a route
