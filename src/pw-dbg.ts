import { World } from './world';
const w = new World(20261126);
w.buildDistricts();
for (let z = -1400; z <= 1400; z += 50) {
  if (z > 1290 && z < 1380) continue;
  const hit = w.collideCircle(0, z, 1.2);
  if (!hit.hitObj) console.log('MISS at z=', z);
}
