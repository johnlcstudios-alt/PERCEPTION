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
const hit = w.raycast(0, 2, 0, 0.5774, -0.5774, 0.5774, 200);
console.log('raycast:', hit ? { t: +hit.t.toFixed(2), mat: hit.mat, cls: hit.obj?.cls ?? 'ground' } : 'MISS');
w.spawnTraffic(10, 5);
for (let i = 0; i < 120; i++) { w.refreshDynamicGrid(); w.updateAgents(0.016, 0, 0); }
const a = w.agents[0];
console.log('agent after 2s:', a.obj.x.toFixed(1), a.obj.z.toFixed(1), 'speed', a.speed.toFixed(2), 'finite:', Number.isFinite(a.obj.x + a.obj.z));
console.log('collideCircle:', JSON.stringify(w.collideCircle(0, 0, 1.5)));
/* ground material sanity */
console.log('groundMat city road:', w.groundMatAt(350, 250), 'groundMat wild:', w.groundMatAt(0, 800));
/* path finding */
const path = w.findPath(74, 250, 626, 166);
console.log('path length:', path.length);
