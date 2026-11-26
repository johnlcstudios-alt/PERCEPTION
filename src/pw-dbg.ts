import { World } from './world';
const w: any = new World(20261126);
w.buildDistricts();
function dump(x: number, z: number) {
  const cx = Math.floor(x / 16 + 100), cz = Math.floor(z / 16 + 100);
  const cell = cz * 200 + cx;
  let si = w.roadIndex[cell];
  const list = [];
  let guard = 0;
  while (si !== undefined && si !== -1 && guard++ < 60) { list.push(si); si = w.roadNext[si]; }
  console.log('cell', x, z, '->', list.join(','));
}
dump(-9, -200); dump(0, 0); dump(-17, -200); dump(17, -200);
for (const pt of [[-9,-200],[-9,-50],[-9,0],[0,0],[-22,-50],[9,200],[-9,800],[-7,2]]) {
  console.log('groundMat', JSON.stringify(pt), '->', w.groundMatAt(pt[0], pt[1]));
}
