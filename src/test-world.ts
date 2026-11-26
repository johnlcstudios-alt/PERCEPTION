/* Node-side world sanity test */
import { World } from './world';
const w = new World(20261126);
w.buildDistricts();
console.log('roads:', w.roads.length, 'objects:', w.objects.length, 'nodes:', w.nodes.length);
for (const d of ['facility', 'city', 'highway', 'industrial', 'mountain', 'experimental']) {
  const segs = (w as any).roads.filter((s: any) => s.district === d);
  console.log(d, 'segments:', segs.length);
  const p = w.randomRoadPoint(d);
  console.log('  pt:', JSON.stringify(p));
}
const hit = w.raycast(-9, 2, 0, 0.5774, -0.5774, 0.5774, 200);
console.log('raycast:', hit ? { t: +hit.t.toFixed(2), mat: hit.mat, cls: hit.obj?.cls ?? 'ground' } : 'MISS');
w.spawnTraffic(120, 8);
for (let i = 0; i < 300; i++) { w.refreshDynamicGrid(); w.updateAgents(0.016, -9, 0); }
const cars = w.agents.filter(a => a.kind !== 'pedestrian');
const onRoad = cars.filter(a => Math.abs(a.obj.x) < 26).length;
const avgSpeed = cars.reduce((s, a) => s + a.speed, 0) / cars.length;
const trucks = cars.filter(a => a.kind === 'truck').length;
console.log('agents:', w.agents.length, 'cars+trucks:', cars.length, 'trucks:', trucks,
  'on-corridor:', onRoad, 'avgSpeed:', avgSpeed.toFixed(2),
  'finite:', cars.every(a => Number.isFinite(a.obj.x + a.obj.z)));
console.log('collideCircle median:', JSON.stringify(w.collideCircle(0, 0, 1.5)));
/* ground material sanity */
console.log('groundMat road:', w.groundMatAt(-9, 0), 'groundMat shoulder:', w.groundMatAt(-22, 0), 'groundMat wild:', w.groundMatAt(0, 800));
/* path finding: south end to north end (through a U-loop) */
const path = w.findPath(-9, -1450, 9, 1450);
console.log('path length:', path.length);
/* every mission spawn must sit inside the corridor and on drivable ground */
const { MISSIONS } = await import('./missions');
for (const m of MISSIONS) {
  const s = m.spawn;
  const ok = Math.abs(s.x) < 26;
  if (!ok) console.log('BAD SPAWN', m.id, JSON.stringify(s));
}
console.log('mission spawns checked:', MISSIONS.length);
