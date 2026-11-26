import { World } from './world';
const w = new World(20261126);
w.buildDistricts();
let blocked = 0, tested = 0;
for (let z = -1400; z <= 1400; z += 50) {
  if (z > 1290 && z < 1380) continue;
  tested++;
  if (w.collideCircle(0, z, 1.2).hitObj) blocked++;
}
console.log('median blocked:', blocked + '/' + tested);
let rail = 0, rt = 0;
for (let z = -1400; z <= 1400; z += 50) {
  if (z > -60 && z < 60) continue;
  rt++;
  if (w.collideCircle(26, z, 1.2).hitObj) rail++;
}
console.log('east guardrail blocked:', rail + '/' + rt + ' (rest-stop gap excluded)');
