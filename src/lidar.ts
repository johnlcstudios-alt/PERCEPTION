/* PERCEPTION - LiDAR simulation system.
   Scan generator -> environment queries -> measurement processor ->
   latency queue -> pooled point-cloud renderer with visualization modes.
   Cycle snapshots (with processing delay) feed the perception engine. */

import * as THREE from 'three';
import { MAT, MAT_INFO, QUALITY, QualityPreset, WEATHER, WeatherModel } from './config';
import { World, RayHit } from './world';

export interface SensorSpec {
  model: string;
  tier: number;
  scanHz: number;
  maxRange: number;
  channels: number;
  vFovBottom: number;
  vFovTop: number;
  azStepDeg: number;
  noiseM: number;
  dropout: number;
  latencyMs: number;
  procDelayMs: number;
  price: number;
}

export const SENSORS: SensorSpec[] = [
  { model: 'LDR-100 BASIC',      tier: 1, scanHz: 10, maxRange: 60,  channels: 8,  vFovBottom: -22, vFovTop: 8,  azStepDeg: 1.2,  noiseM: 0.055, dropout: 0.050, latencyMs: 130, procDelayMs: 260, price: 0 },
  { model: 'LDR-250',            tier: 2, scanHz: 15, maxRange: 90,  channels: 12, vFovBottom: -25, vFovTop: 10, azStepDeg: 0.8,  noiseM: 0.042, dropout: 0.040, latencyMs: 105, procDelayMs: 210, price: 9000 },
  { model: 'LDR-500',            tier: 3, scanHz: 15, maxRange: 120, channels: 16, vFovBottom: -25, vFovTop: 12, azStepDeg: 0.55, noiseM: 0.033, dropout: 0.030, latencyMs: 85,  procDelayMs: 170, price: 24000 },
  { model: 'LDR-1000',           tier: 4, scanHz: 20, maxRange: 160, channels: 24, vFovBottom: -28, vFovTop: 14, azStepDeg: 0.40, noiseM: 0.026, dropout: 0.024, latencyMs: 65,  procDelayMs: 130, price: 52000 },
  { model: 'LDR-2000',           tier: 5, scanHz: 20, maxRange: 200, channels: 32, vFovBottom: -30, vFovTop: 15, azStepDeg: 0.30, noiseM: 0.020, dropout: 0.018, latencyMs: 48,  procDelayMs: 95,  price: 96000 },
  { model: 'LDR-5000',           tier: 6, scanHz: 25, maxRange: 235, channels: 48, vFovBottom: -30, vFovTop: 18, azStepDeg: 0.22, noiseM: 0.015, dropout: 0.013, latencyMs: 32,  procDelayMs: 62,  price: 165000 },
  { model: 'LDR-X EXPERIMENTAL', tier: 7, scanHz: 30, maxRange: 280, channels: 64, vFovBottom: -32, vFovTop: 20, azStepDeg: 0.16, noiseM: 0.010, dropout: 0.007, latencyMs: 16,  procDelayMs: 30, price: 260000 }
];

const QUEUE_CAP = 1 << 18;
const QFLOATS = 7;

export interface CycleObjAgg {
  id: number; n: number;
  sx: number; sy: number; sz: number;
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
  minT: number; maxT: number; mat: number; lastMat: number;
}

export interface CycleSnapshot {
  time: number;
  readyTime: number;
  cycle: number;
  sensorX: number; sensorY: number; sensorZ: number; yaw: number;
  range: number;
  objs: CycleObjAgg[];
  ground: number[]; // [x, z, mat] samples
}

const MAX_SNAPSHOTS = 8;

export class LidarSystem {
  points: THREE.Points;
  sweep: THREE.Mesh;
  private world: World;
  private cap: number;
  private posA: Float32Array; private birthA: Float32Array; private intensA: Float32Array; private matA: Float32Array; private distA: Float32Array;
  private attrs: Record<'pos' | 'birth' | 'intens' | 'mat' | 'dist', THREE.BufferAttribute>;
  private head = 0;
  private uniforms: Record<string, THREE.IUniform>;

  spec: SensorSpec = SENSORS[0];
  private az = 0;
  private qHead = 0; private qTail = 0;
  private qArr = new Float32Array(QUEUE_CAP * QFLOATS);

  weather: WeatherModel = WEATHER.clear;
  private quality: QualityPreset = QUALITY.medium;
  private rayMsEMA = 0.0004;
  private budget = 2000;

  cycleCount = 0;
  effectiveHz = 0; configuredHz = 10;
  pointsPerSec = 0; raysPerSec = 0;
  budgetLimited = false;
  lastRange = 60;
  obstruction = false;
  interference = 0; // dynamic-event noise spike (0..1)

  onCycle: ((cycle: number, snap: CycleSnapshot) => void) | null = null;

  private upFreq = 0; private upRange = 0; private upNoise = 0; private upAz = 0; private upLatency = 0;
  filtering = 0;

  /* per-cycle aggregation */
  private aggMap = new Map<number, CycleObjAgg>();
  private snapshots: CycleSnapshot[] = [];
  private pendingSnapshots: CycleSnapshot[] = [];

  constructor(scene: THREE.Scene, world: World, quality: QualityPreset) {
    this.world = world;
    this.quality = quality;
    this.cap = quality.maxPoints;
    this.posA = new Float32Array(this.cap * 3);
    this.birthA = new Float32Array(this.cap);
    this.intensA = new Float32Array(this.cap);
    this.matA = new Float32Array(this.cap);
    this.distA = new Float32Array(this.cap);

    const semPal: THREE.Color[] = [];
    for (let i = 0; i < 16; i++) semPal.push(new THREE.Color(...MAT_INFO[i].semanticColor));

    this.uniforms = {
      uTime: { value: 0 },
      uLife: { value: 1.7 },
      uPointSize: { value: quality.pointSize },
      uMode: { value: 0 },
      uMaxRange: { value: 60 },
      uSemPal: { value: semPal }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aBirth;
        attribute float aIntens;
        attribute float aMat;
        attribute float aDist;
        uniform float uTime, uLife, uPointSize, uMaxRange;
        uniform int uMode;
        uniform vec3 uSemPal[16];
        varying vec3 vColor;
        varying float vAlpha;

        vec3 distPalette(float rel) {
          vec3 c;
          if (rel < 0.14)      c = mix(vec3(1.0,0.18,0.22), vec3(1.0,0.55,0.15), rel/0.14);
          else if (rel < 0.30) c = mix(vec3(1.0,0.55,0.15), vec3(1.0,0.9,0.25), (rel-0.14)/0.16);
          else if (rel < 0.52) c = mix(vec3(1.0,0.9,0.25), vec3(0.35,1.0,0.5), (rel-0.30)/0.22);
          else if (rel < 0.75) c = mix(vec3(0.35,1.0,0.5), vec3(0.2,0.85,1.0), (rel-0.52)/0.23);
          else                 c = mix(vec3(0.2,0.85,1.0), vec3(0.25,0.35,1.0), min(1.0,(rel-0.75)/0.25));
          return c;
        }
        vec3 heightPalette(float h) {
          float rel = clamp(h / 30.0, 0.0, 1.0);
          vec3 c;
          if (rel < 0.2)       c = mix(vec3(0.2,0.3,1.0), vec3(0.2,0.85,1.0), rel/0.2);
          else if (rel < 0.45) c = mix(vec3(0.2,0.85,1.0), vec3(0.3,1.0,0.45), (rel-0.2)/0.25);
          else if (rel < 0.7)  c = mix(vec3(0.3,1.0,0.45), vec3(1.0,0.9,0.2), (rel-0.45)/0.25);
          else                 c = mix(vec3(1.0,0.9,0.2), vec3(1.0,0.25,0.3), (rel-0.7)/0.3);
          return c;
        }

        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float age = uTime - aBirth;
          float fade = 1.0 - smoothstep(uLife * 0.55, uLife, age);
          float farFade = 1.0 - smoothstep(uMaxRange * 0.8, uMaxRange, aDist);
          float alpha = fade * farFade;
          float h1 = hash13(position);
          vec3 col;

          if (uMode == 0) {
            col = mix(vec3(0.42,0.72,1.0), vec3(0.88,0.98,1.0), clamp(aIntens*1.35,0.0,1.0));
            col *= 0.86 + 0.28 * h1;
          } else if (uMode == 1) {
            col = distPalette(aDist / max(1.0, uMaxRange));
          } else if (uMode == 2) {
            col = heightPalette(max(0.0, position.y));
          } else if (uMode == 3) {
            float i = clamp(aIntens, 0.0, 1.0);
            col = mix(vec3(0.10,0.10,0.22), mix(vec3(0.45,0.4,1.0), vec3(1.0,0.98,0.9), i), 0.25 + 0.75*i);
          } else if (uMode == 4) {
            float m = aMat;
            vec3 sem = uSemPal[int(m + 0.5)];
            float dyn = step(4.5, m) * (1.0 - step(8.5, m));
            col = mix(vec3(0.14,0.18,0.28) * (0.5 + aIntens), sem * (0.8 + aIntens*0.6), dyn);
          } else if (uMode == 5) {
            col = uSemPal[int(aMat + 0.5)] * (0.35 + 0.65 * clamp(aIntens*1.2, 0.0, 1.0)) * (0.9 + 0.2 * h1);
          } else {
            col = vec3(0.35,0.5,0.7);
            alpha *= 0.22;
          }
          vColor = col;
          vAlpha = alpha;
          float sz = uPointSize * (170.0 / max(1.0, -mv.z)) * (0.85 + 0.3 * h1);
          gl_PointSize = clamp(sz, 1.0, 9.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float r2 = dot(uv, uv);
          if (r2 > 0.25) discard;
          float a = vAlpha * (1.0 - r2 * 2.6);
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `
    });

    const geo = new THREE.BufferGeometry();
    this.attrs = {
      pos: new THREE.BufferAttribute(this.posA, 3),
      birth: new THREE.BufferAttribute(this.birthA, 1),
      intens: new THREE.BufferAttribute(this.intensA, 1),
      mat: new THREE.BufferAttribute(this.matA, 1),
      dist: new THREE.BufferAttribute(this.distA, 1)
    };
    geo.setAttribute('position', this.attrs.pos);
    geo.setAttribute('aBirth', this.attrs.birth);
    geo.setAttribute('aIntens', this.attrs.intens);
    geo.setAttribute('aMat', this.attrs.mat);
    geo.setAttribute('aDist', this.attrs.dist);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;

    const sweepGeo = new THREE.PlaneGeometry(0.35, 1);
    sweepGeo.rotateX(-Math.PI / 2);
    const sweepMat = new THREE.MeshBasicMaterial({
      color: 0x53e6ff, transparent: true, opacity: 0.085, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    this.sweep = new THREE.Mesh(sweepGeo, sweepMat);
    scene.add(this.points, this.sweep);
  }

  setQuality(q: QualityPreset) {
    this.quality = q;
    this.uniforms.uPointSize.value = q.pointSize;
    this.budget = q.rayBudgetPerFrame;
  }

  setSensor(spec: SensorSpec) {
    this.spec = spec;
    this.configuredHz = spec.scanHz;
    this.aggMap.clear();
  }

  applyUpgrades(u: { freq?: number; range?: number; noise?: number; az?: number; latency?: number; filtering?: number }) {
    this.upFreq = u.freq ?? this.upFreq;
    this.upRange = u.range ?? this.upRange;
    this.upNoise = u.noise ?? this.upNoise;
    this.upAz = u.az ?? this.upAz;
    this.upLatency = u.latency ?? this.upLatency;
    this.filtering = u.filtering ?? this.filtering;
  }

  setMode(modeIndex: number) { this.uniforms.uMode.value = modeIndex; }

  /* how long scanned points stay visible (Settings -> SCAN PERSISTENCE) */
  pointLife = 1.7;
  setLife(seconds: number) {
    this.pointLife = seconds;
    this.uniforms.uLife.value = seconds;
  }
  setSweepVisible(v: boolean) { this.sweep.visible = v; }

  effectiveSpec() {
    const s = this.spec;
    return {
      channels: s.channels,
      vFovBottom: s.vFovBottom,
      vFovTop: s.vFovTop,
      scanHz: s.scanHz * (1 + this.upFreq),
      maxRange: s.maxRange * (1 + this.upRange),
      azStepDeg: s.azStepDeg * Math.max(0.35, 1 - this.upAz),
      noiseM: s.noiseM * Math.max(0.25, 1 - this.upNoise),
      dropout: s.dropout * Math.max(0.2, 1 - this.upNoise),
      latencyMs: s.latencyMs * Math.max(0.15, 1 - this.upLatency),
      procDelayMs: s.procDelayMs * Math.max(0.15, 1 - this.upLatency)
    };
  }

  update(dt: number, sx: number, sy: number, sz: number, yaw: number, now: number) {
    this.uniforms.uTime.value = now;

    /* deliver perception snapshots whose processing delay elapsed */
    while (this.pendingSnapshots.length && this.pendingSnapshots[0].readyTime <= now) {
      const snap = this.pendingSnapshots.shift()!;
      if (this.onCycle) this.onCycle(snap.cycle, snap);
    }

    const es = this.effectiveSpec();
    const weather = this.weather;
    const filt = this.filtering;
    const rangeMul = weather.rangeMul + (1 - weather.rangeMul) * filt * 0.7;
    const noiseMul = (1 + (weather.noiseMul - 1) * (1 - filt * 0.75)) * (1 + this.interference * 4);
    const dropoutBase = Math.min(0.5, weather.dropout * (1 - filt * 0.8) + es.dropout + this.interference * 0.15);
    const maxDist = es.maxRange * rangeMul;
    this.lastRange = maxDist;
    this.uniforms.uMaxRange.value = maxDist;

    const targetMs = 5.0;
    this.budget = Math.max(300, Math.min(this.quality.rayBudgetPerFrame, Math.round(targetMs / Math.max(1e-5, this.rayMsEMA))));

    const azStep = es.azStepDeg * Math.PI / 180;
    const raysPerCycle = (Math.PI * 2 / azStep) * es.channels;
    const raysPerSec = raysPerCycle * es.scanHz;

    let allowance = Math.min(this.budget, raysPerSec * dt + 96);
    const t0 = performance.now();

    const channels = es.channels;
    const vBot = es.vFovBottom * Math.PI / 180;
    const vTop = es.vFovTop * Math.PI / 180;
    const chanV: number[] = new Array(channels);
    const chanCos: number[] = new Array(channels);
    const chanSin: number[] = new Array(channels);
    for (let ch = 0; ch < channels; ch++) {
      const v = vBot + (ch / Math.max(1, channels - 1)) * (vTop - vBot);
      chanV[ch] = v; chanCos[ch] = Math.cos(v); chanSin[ch] = Math.sin(v);
    }

    const c = Math.cos(yaw), s = Math.sin(yaw);
    let rays = 0, traced = 0;
    const damageMul = this.obstruction ? 2.4 : 1;


    while (allowance > 0) {
      const steps = Math.max(1, Math.min(Math.floor(allowance / channels), 32));
      for (let st = 0; st < steps; st++) {
        const az = this.az + st * azStep;
        const sa = Math.sin(az), ca = Math.cos(az);
        for (let ch = 0; ch < channels; ch++) {
          if ((ch & 1) === 1 && (st & 1) === 1) continue;   // LOD: alternate edge channels
          if (chanV[ch] > 0.09 && st % 3 === 2) continue;   // LOD: thin top channels
          const cosV = chanCos[ch], sinV = chanSin[ch];
          const lxc = sa * cosV, lyc = sinV, lzc = ca * cosV;
          const dx2 = c * lxc + s * lzc;
          const dz2 = -s * lxc + c * lzc;
          const hit = this.world.raycast(sx, sy, sz, dx2, lyc, dz2, maxDist);
          rays++;
          if (!hit) continue;
          const rel = hit.t / maxDist;
          if (Math.random() < dropoutBase + rel * 0.06) continue;
          let tN = hit.t * (1 + (Math.random() + Math.random() - 1) * es.noiseM * noiseMul * damageMul * Math.pow(rel + 0.15, 1.4) * 8);
          const intensity = this.computeIntensity(hit, rel);
          const px = sx + dx2 * tN, py = sy + lyc * tN + (Math.random() - 0.5) * es.noiseM * noiseMul * damageMul * 3, pz = sz + dz2 * tN;
          /* render buffer */
          this.enqueuePoint(px, py, pz, intensity, hit.mat, hit.t, now + es.latencyMs / 1000);
          /* perception aggregation */
          if (hit.obj) {
            const o = hit.obj;
            let a = this.aggMap.get(o.group);
            if (!a || a.id !== o.group || (a as any)._gen !== this.cycleCount) {
              if (!a) { a = { id: '', n: 0, sx: 0, sy: 0, sz: 0, minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, minT: 0, maxT: 0, mat: 0, lastMat: 0 }; this.aggMap.set(o.group, a); }
              a.id = o.group; a.n = 0; a.sx = 0; a.sy = 0; a.sz = 0;
              a.minX = 1e9; a.maxX = -1e9; a.minY = 1e9; a.maxY = -1e9; a.minZ = 1e9; a.maxZ = -1e9;
              a.minT = 1e9; a.maxT = 0; a.mat = o.mat; a.lastMat = o.mat;
              (a as any)._gen = this.cycleCount;
              (a as any)._cls = o.cls;
            }
            (a as any)._cls = o.cls;
            a.n++; a.sx += px; a.sy += py; a.sz += pz;
            if (px < a.minX) a.minX = px; if (px > a.maxX) a.maxX = px;
            if (py < a.minY) a.minY = py; if (py > a.maxY) a.maxY = py;
            if (pz < a.minZ) a.minZ = pz; if (pz > a.maxZ) a.maxZ = pz;
            if (hit.t < a.minT) a.minT = hit.t; if (hit.t > a.maxT) a.maxT = hit.t;
            a.lastMat = o.mat;
          } else {
            /* ground sample for road-space estimation: forward cone only */
            const fwdDot = dx2 * s + dz2 * c;
            if (fwdDot > 0.25 && hit.t < 75) {
              const snap = this.curGround;
              if (snap.length < 2400) { snap.push(px, pz, hit.mat); }
            }
          }
          traced++;
        }
      }
      allowance -= steps * channels;
      this.az += steps * azStep;
      if (this.az >= Math.PI * 2) {
        this.az -= Math.PI * 2;
        this.completeCycle(now, sx, sy, sz, yaw, maxDist, es);
      }
    }

    this.lastTraced = traced; this.lastRays = rays;
    const elapsed = performance.now() - t0;
    this.rayMsEMA = this.rayMsEMA * 0.9 + (elapsed / Math.max(1, rays)) * 0.1;
    this.pointsPerSec = this.pointsPerSec * 0.8 + (traced / Math.max(1e-4, dt)) * 0.2;
    this.raysPerSec = raysPerSec;
    this.budgetLimited = raysPerSec > this.budget * 60 * 1.15;

    /* sweep visual */
    const lxs = Math.sin(this.az), lzs = Math.cos(this.az);
    const wdx = c * lxs + s * lzs, wdz = -s * lxs + c * lzs;
    const swLen = Math.min(75, maxDist * 0.55);
    this.sweep.position.set(sx + wdx * swLen / 2, sy + 0.12, sz + wdz * swLen / 2);
    this.sweep.rotation.y = Math.atan2(wdx, wdz);
    this.sweep.scale.set(1, 1, swLen);
    this.sweep.visible = this.sweepVisible && maxDist > 20;
  }

  sweepVisible = true;

  private curGround: number[] = [];

  private completeCycle(now: number, sx: number, sy: number, sz: number, yaw: number, range: number, es: ReturnType<LidarSystem['effectiveSpec']>) {
    this.cycleCount++;
    const objs: CycleObjAgg[] = [];
    for (const a of this.aggMap.values()) {
      if ((a as any)._gen !== this.cycleCount - 1) continue;
      if (a.n < 1) continue;
      if (objs.length < 420) objs.push(a);
      else if (a.n >= 4 && objs.length < 460) objs.push(a);
    }
    const snap: CycleSnapshot = {
      time: now, readyTime: now + es.procDelayMs / 1000, cycle: this.cycleCount,
      sensorX: sx, sensorY: sy, sensorZ: sz, yaw, range,
      objs, ground: this.curGround
    };
    this.pendingSnapshots.push(snap);
    if (this.pendingSnapshots.length > MAX_SNAPSHOTS) this.pendingSnapshots.shift();
    /* reset for next cycle */
    this.curGround = [];
    const hz = 1 / Math.max(1e-3, now - (this.lastCycleAt || now - 0.1));
    this.effectiveHz = this.effectiveHz * 0.85 + Math.min(200, hz) * 0.15;
    this.lastCycleAt = now;
  }
  private lastCycleAt = 0;
  lastTraced = 0; lastRays = 0;

  private computeIntensity(hit: RayHit, rel: number): number {
    const info = MAT_INFO[hit.mat];
    const refl = info.reflectivity * (hit.obj ? hit.obj.reflect : 1);
    const falloff = 1 - 0.55 * rel;
    return Math.max(0.02, Math.min(1.2, refl * falloff * (0.85 + Math.random() * 0.3)));
  }

  private enqueuePoint(x: number, y: number, z: number, intens: number, mat: number, dist: number, ready: number) {
    const nextTail = (this.qTail + 1) % QUEUE_CAP;
    if (nextTail === this.qHead) this.qHead = (this.qHead + 1) % QUEUE_CAP;
    const base = this.qTail * QFLOATS;
    this.qArr[base] = x; this.qArr[base + 1] = y; this.qArr[base + 2] = z;
    this.qArr[base + 3] = intens; this.qArr[base + 4] = mat; this.qArr[base + 5] = dist;
    this.qArr[base + 6] = ready;
    this.qTail = nextTail;
  }

  /* consume due measurements into the render ring buffer (partial GPU uploads) */
  private dirtyRanges: [number, number][] = [];

  flushQueue(now: number) {
    let count = 0;
    let segStart = -1;
    let prev = -2;
    while (this.qHead !== this.qTail && count < 260000) {
      const base = this.qHead * QFLOATS;
      if (this.qArr[base + 6] > now) break;
      const h3 = this.head * 3;
      this.posA[h3] = this.qArr[base];
      this.posA[h3 + 1] = this.qArr[base + 1];
      this.posA[h3 + 2] = this.qArr[base + 2];
      this.birthA[this.head] = now;
      this.intensA[this.head] = this.qArr[base + 3];
      this.matA[this.head] = this.qArr[base + 4];
      this.distA[this.head] = this.qArr[base + 5];
      if (segStart < 0) segStart = this.head;
      else if (this.head !== prev) { this.dirtyRanges.push([segStart, prev - segStart + 1]); segStart = this.head; }
      prev = this.head;
      this.head = (this.head + 1) % this.cap;
      this.qHead = (this.qHead + 1) % QUEUE_CAP;
      count++;
    }
    if (segStart >= 0) this.dirtyRanges.push([segStart, prev - segStart + 1]);
    if (this.dirtyRanges.length > 0) {
      const ranges = this.dirtyRanges;
      this.dirtyRanges = [];
      for (const key of ['pos', 'birth', 'intens', 'mat', 'dist'] as const) {
        const a = this.attrs[key] as any;
        const itemSize = key === 'pos' ? 3 : 1;
        if (a.clearUpdateRanges && a.addUpdateRange) {
          a.clearUpdateRanges();
          for (const [s, c] of ranges) a.addUpdateRange(s * itemSize, c * itemSize);
          a.needsUpdate = true;
        } else {
          a.needsUpdate = true;
        }
      }
    }
  }

  /* recent points for the minimap (world x,z pairs), sampled evenly across the history window */
  sampleRecent(n: number, now: number, maxAge = 2.2): { arr: Float32Array; count: number } {
    const out = new Float32Array(n * 2);
    const maxScan = Math.min(this.cap, n * 6);
    /* pass 1: count points inside the history window */
    let alive = 0;
    for (let i = 1; i <= maxScan; i++) {
      const idx = (this.head - i + this.cap * 2) % this.cap;
      if (now - this.birthA[idx] > maxAge) break;
      alive++;
    }
    if (alive === 0) return { arr: out, count: 0 };
    /* pass 2: sample with an even stride so the whole window is represented */
    const stride = Math.max(1, Math.floor(alive / n));
    let c = 0;
    for (let i = 1; i <= alive && c < n; i += stride) {
      const idx = (this.head - i + this.cap * 2) % this.cap;
      out[c * 2] = this.posA[idx * 3];
      out[c * 2 + 1] = this.posA[idx * 3 + 2];
      c++;
    }
    return { arr: out, count: c };
  }

  /* perception boxes rendering layer (used by PerceptionEngine) */
  makeBoxLayer(scene: THREE.Scene) {
    return new BoxLayer(scene);
  }
}

/* ------------------------------------------------------------
   Object bounding-box line layer (detection / wireframe modes)
------------------------------------------------------------ */
export class BoxLayer {
  lines: THREE.LineSegments;
  private posArr: Float32Array;
  private colArr: Float32Array;
  private geo: THREE.BufferGeometry;
  private maxBoxes = 96;

  constructor(scene: THREE.Scene) {
    this.posArr = new Float32Array(this.maxBoxes * 24 * 3);
    this.colArr = new Float32Array(this.maxBoxes * 24 * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    this.lines = new THREE.LineSegments(this.geo, mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  setBoxes(boxes: { x: number; y: number; z: number; hw: number; hh: number; hl: number; color: [number, number, number] }[]) {
    let i = 0;
    const p = this.posArr, c = this.colArr;
    for (const b of boxes) {
      if (i >= this.maxBoxes) break;
      const x0 = b.x - b.hw, x1 = b.x + b.hw;
      const y0 = b.y - b.hh, y1 = b.y + b.hh;
      const z0 = b.z - b.hl, z1 = b.z + b.hl;
      const edges: [number, number, number, number, number, number][] = [
        [x0,y0,z0, x1,y0,z0], [x1,y0,z0, x1,y0,z1], [x1,y0,z1, x0,y0,z1], [x0,y0,z1, x0,y0,z0],
        [x0,y1,z0, x1,y1,z0], [x1,y1,z0, x1,y1,z1], [x1,y1,z1, x0,y1,z1], [x0,y1,z1, x0,y1,z0],
        [x0,y0,z0, x0,y1,z0], [x1,y0,z0, x1,y1,z0], [x1,y0,z1, x1,y1,z1], [x0,y0,z1, x0,y1,z1]
      ];
      for (const e of edges) {
        p[i*3] = e[0]; p[i*3+1] = e[1]; p[i*3+2] = e[2];
        c[i*3] = b.color[0]; c[i*3+1] = b.color[1]; c[i*3+2] = b.color[2];
        i++;
      }
    }
    for (let k = i; k < this.maxBoxes * 24; k++) { p[k*3+1] = -9999; p[k*3+2] = -9999; p[k*3] = -9999; }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  setVisible(v: boolean) { this.lines.visible = v; }
}

export const MAT_CONST = MAT;
