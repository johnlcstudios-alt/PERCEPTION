/* PERCEPTION - world simulation: analytic shapes, spatial hash, raycast engine.
   The world is fully modeled in 3D but never rendered as ordinary geometry:
   the LiDAR system queries it, and only scan points become visible. */

import * as THREE from 'three';
import { MAT, WORLD } from './config';

export type ShapeKind = 0 | 1 | 2 | 3; // box | cylinder | sphere | cone

export interface WorldObject {
  id: number;            // unique primitive id
  group: string;         // logical object group (one car = several primitives)
  cls: string;           // 'building'|'vehicle'|'truck'|'pedestrian'|'tree'|'sign'|'pole'|'light'|'barrier'|'cone'|'rock'|'obstacle'|'prop'
  mat: number;           // MAT id for intensity/semantics
  kind: ShapeKind;
  x: number; y: number; z: number;
  yaw: number;
  hw: number; hh: number; hl: number; // box half extents
  r: number;             // cylinder/sphere radius, cone base radius
  h: number;             // cylinder/cone height
  dynamic: boolean;
  tags: string[];
  collR: number;         // 2D collision radius (0 = no collision)
  reflect: number;       // reflectivity multiplier override (1 = from material)
  next: number;
}

export interface RayHit {
  t: number; obj: WorldObject | null; // null = ground plane
  nx: number; ny: number; nz: number;
  gx: number; gy: number; gz: number; // hit position
  mat: number;
}

export interface RoadSeg {
  ax: number; az: number; bx: number; bz: number;
  half: number; lanes: number; speed: number;
  kind: 'street' | 'avenue' | 'highway' | 'ramp' | 'rural' | 'pad';
  district: string;
  oneway: 0 | 1 | 2; // 0 both, 1 a->b, 2 b->a
  len: number; dx: number; dz: number; nx: number; nz: number; // dir + unit normal
  aNode: number; bNode: number;
}

export interface RoadNode { id: number; x: number; z: number; links: number[]; light: boolean; district: string; }

export interface Agent {
  obj: WorldObject;
  kind: 'car' | 'truck' | 'pedestrian';
  seg: number;              // current road segment index
  dir: 1 | 2;               // travel direction along segment
  s: number;                // progress along segment
  lateral: number;          // lane offset from centerline
  speed: number; targetSpeed: number;
  yaw: number;
  crossing: number;         // pedestrian crossing state timer (-1 = none)
  crossedTo: number;        // lateral target while crossing
  waitTimer: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DISTRICTS = {
  facility:     { name: 'TESTING FACILITY',   cx: -550, cz: -550, size: 460 },
  city:         { name: 'CITY CENTER',        cx: 350,  cz: 250,  size: 760 },
  highway:      { name: 'HIGHWAY NETWORK',    cx: 100,  cz: -1050, size: 300 },
  industrial:   { name: 'INDUSTRIAL DISTRICT',cx: 1050, cz: 500,  size: 520 },
  mountain:     { name: 'MOUNTAIN ROADS',     cx: -850, cz: 350,  size: 620 },
  experimental: { name: 'EXPERIMENTAL ZONE',  cx: 950,  cz: -620, size: 400 }
};

const GRID_N = Math.ceil(WORLD.size / WORLD.gridCell); // cells per axis
const GRID_HALF = GRID_N / 2;

export class World {
  objects: WorldObject[] = [];
  private staticHeads: Int32Array;
  private dynHeads: Int32Array;
  private objNext: Int32Array;
  private objCell: Int32Array; // primary cell per object (dynamics re-registration)
  private dynList: number[] = [];
  private staticCount = 0;
  private groupMap = new Map<string, WorldObject>();
  private hit: RayHit = { t: 0, obj: null, nx: 0, ny: 0, nz: 0, gx: 0, gy: 0, gz: 0, mat: 0 };

  roads: RoadSeg[] = [];
  nodes: RoadNode[] = [];
  private roadIndex: Int32Array;      // cell -> road list head
  private roadNext: Int32Array;       // segment next index
  private groundSeed = 1337;

  agents: Agent[] = [];
  trafficSpeedMul = 1;
  private rng: () => number;
  private time = 0;

  // region ground style lookup
  private districtOfCell: Uint8Array;

  constructor(seed = 20261126) {
    this.staticHeads = new Int32Array(GRID_N * GRID_N).fill(-1);
    this.dynHeads = new Int32Array(GRID_N * GRID_N).fill(-1);
    this.objNext = new Int32Array(65536);
    this.objCell = new Int32Array(65536);
    this.roadIndex = new Int32Array(GRID_N * GRID_N).fill(-1);
    this.roadNext = new Int32Array(65536);
    this.rng = mulberry32(seed);
    this.districtOfCell = new Uint8Array(GRID_N * GRID_N);
  }

  /* ---------------- object creation ---------------- */

  private cellIdx(x: number, z: number): number {
    const cx = Math.floor(x / WORLD.gridCell + GRID_HALF);
    const cz = Math.floor(z / WORLD.gridCell + GRID_HALF);
    if (cx < 0 || cz < 0 || cx >= GRID_N || cz >= GRID_N) return -1;
    return cz * GRID_N + cx;
  }

  private addObj(o: Partial<WorldObject> & { kind: ShapeKind; x: number; y: number; z: number; cls: string; mat: number }): WorldObject {
    const obj: WorldObject = {
      id: this.objects.length, group: o.group ?? o.cls + '-' + this.objects.length,
      cls: o.cls, mat: o.mat, kind: o.kind,
      x: o.x, y: o.y, z: o.z, yaw: o.yaw ?? 0,
      hw: o.hw ?? 0, hh: o.hh ?? 0, hl: o.hl ?? 0,
      r: o.r ?? 0, h: o.h ?? 0,
      dynamic: o.dynamic ?? false, tags: o.tags ?? [],
      collR: o.collR ?? 0, reflect: o.reflect ?? 1, next: -1
    };
    this.objects.push(obj);
    if (!this.groupMap.has(obj.group)) this.groupMap.set(obj.group, obj);
    if (obj.dynamic) { this.dynList.push(obj.id); }
    else this.insertStatic(obj.id);
    return obj;
  }

  private objAABB(o: WorldObject): [number, number, number, number] {
    if (o.kind === 0) { // box
      const c = Math.abs(Math.cos(o.yaw)), s = Math.abs(Math.sin(o.yaw));
      const ex = c * o.hw + s * o.hl, ez = s * o.hw + c * o.hl;
      return [o.x - ex, o.x + ex, o.z - ez, o.z + ez];
    }
    const r = o.kind === 2 ? o.r : o.r;
    return [o.x - r, o.x + r, o.z - r, o.z + r];
  }

  private insertStatic(id: number) {
    const o = this.objects[id];
    const [x0, x1, z0, z1] = this.objAABB(o);
    const c0 = Math.floor(x0 / WORLD.gridCell + GRID_HALF), c1 = Math.floor(x1 / WORLD.gridCell + GRID_HALF);
    const r0 = Math.floor(z0 / WORLD.gridCell + GRID_HALF), r1 = Math.floor(z1 / WORLD.gridCell + GRID_HALF);
    this.objCell[id] = this.cellIdx(o.x, o.z);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (c < 0 || r < 0 || c >= GRID_N || r >= GRID_N) continue;
      const cell = r * GRID_N + c;
      this.objNext[id] = this.staticHeads[cell];
      this.staticHeads[cell] = id;
      this.staticCount++;
    }
  }

  /* shape helpers */
  addBox(cls: string, mat: number, x: number, y: number, z: number, w: number, h: number, l: number, yaw = 0, opts: Partial<WorldObject> = {}) {
    return this.addObj({ kind: 0, cls, mat, x, y, z, yaw, hw: w / 2, hh: h / 2, hl: l / 2, ...opts });
  }
  addCylinder(cls: string, mat: number, x: number, y: number, z: number, r: number, h: number, opts: Partial<WorldObject> = {}) {
    return this.addObj({ kind: 1, cls, mat, x, y, z, r, h, ...opts });
  }
  addSphere(cls: string, mat: number, x: number, y: number, z: number, r: number, opts: Partial<WorldObject> = {}) {
    return this.addObj({ kind: 2, cls, mat, x, y, z, r, ...opts });
  }
  addCone(cls: string, mat: number, x: number, y: number, z: number, r: number, h: number, opts: Partial<WorldObject> = {}) {
    return this.addObj({ kind: 3, cls, mat, x, y, z, r, h, ...opts });
  }

  get dynamicObjects(): WorldObject[] { return this.dynList.map(i => this.objects[i]); }
  objectsByTag(tag: string): WorldObject[] { return this.objects.filter(o => o.tags.includes(tag)); }
  objectById(id: number): WorldObject | null { return this.objects[id] ?? null; }
  groupSample(group: string): WorldObject | null { return this.groupMap.get(group) ?? null; }

  /* ---------------- raycast engine ---------------- */

  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
    const hit = this.hit;
    let bestT = maxDist;
    let bestObj: WorldObject | null = null;
    let bnx = 0, bny = 0, bnz = 0, bmat = 0;

    /* ground plane */
    if (dy < -1e-6) {
      const tg = -oy / dy;
      if (tg > 0 && tg < bestT) {
        const gx = ox + dx * tg, gz = oz + dz * tg;
        if (Math.abs(gx) < WORLD.size / 2 && Math.abs(gz) < WORLD.size / 2) {
          bestT = tg; bestObj = null; bnx = 0; bny = 1; bnz = 0;
          bmat = this.groundMatAt(gx, gz);
        }
      }
    }

    /* 2D DDA through static grid */
    const invDx = dx !== 0 ? 1 / dx : 1e30, invDz = dz !== 0 ? 1 / dz : 1e30;
    let cx = Math.floor(ox / WORLD.gridCell + GRID_HALF);
    let cz = Math.floor(oz / WORLD.gridCell + GRID_HALF);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    let nextBX = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * WORLD.gridCell - GRID_HALF * WORLD.gridCell - ox) * invDx : 1e30;
    let nextBZ = dz !== 0 ? ((cz + (dz > 0 ? 1 : 0)) * WORLD.gridCell - GRID_HALF * WORLD.gridCell - oz) * invDz : 1e30;
    const tDeltaX = dx !== 0 ? Math.abs(WORLD.gridCell * invDx) : 1e30;
    const tDeltaZ = dz !== 0 ? Math.abs(WORLD.gridCell * invDz) : 1e30;
    let t = 0;
    let guard = 0;

    while (t <= bestT && guard++ < 512) {
      if (cx >= 0 && cz >= 0 && cx < GRID_N && cz < GRID_N) {
        const cell = cz * GRID_N + cx;
        /* static objects */
        let id = this.staticHeads[cell];
        while (id !== -1) {
          const o = this.objects[id];
          const res = this.rayShape(ox, oy, oz, dx, dy, dz, o, bestT);
          if (res !== null && res.t < bestT) {
            bestT = res.t; bestObj = o; bnx = res.nx; bny = res.ny; bnz = res.nz; bmat = o.mat;
          }
          id = this.objNext[id];
        }
        /* dynamic objects */
        id = this.dynHeads[cell];
        while (id !== -1) {
          const o = this.objects[id];
          const res = this.rayShape(ox, oy, oz, dx, dy, dz, o, bestT);
          if (res !== null && res.t < bestT) {
            bestT = res.t; bestObj = o; bnx = res.nx; bny = res.ny; bnz = res.nz; bmat = o.mat;
          }
          id = this.objNext[id];
        }
      }
      /* advance to next cell */
      if (nextBX < nextBZ) { t = nextBX; nextBX += tDeltaX; cx += stepX; }
      else { t = nextBZ; nextBZ += tDeltaZ; cz += stepZ; }
      if (bestT < t) break; // nearest hit is before we leave this cell's neighborhood
    }

    if (bestT >= maxDist) return null;
    hit.t = bestT; hit.obj = bestObj; hit.nx = bnx; hit.ny = bny; hit.nz = bnz;
    hit.gx = ox + dx * bestT; hit.gy = oy + dy * bestT; hit.gz = oz + dz * bestT;
    hit.mat = bmat;
    return hit;
  }

  private tmpRes = { t: 0, nx: 0, ny: 0, nz: 0 };
  private rayShape(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: WorldObject, maxT: number): { t: number; nx: number; ny: number; nz: number } | null {
    const res = this.tmpRes;
    if (o.kind === 0) { /* box (yaw rotated) */
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      /* world->local: lx = c*dxw - s*dzw ; lz = s*dxw + c*dzw  (matches local->world wx = c*lx + s*lz, wz = -s*lx + c*lz) */
      const lox = c * (ox - o.x) - s * (oz - o.z);
      const loz = s * (ox - o.x) + c * (oz - o.z);
      const ldx = c * dx - s * dz;
      const ldz = s * dx + c * dz;
      const loy = oy - o.y;
      let tmin = -1e30, tmax = 1e30, axis = 0, sign = 0;
      /* X slab */
      if (Math.abs(ldx) < 1e-9) { if (lox < -o.hw || lox > o.hw) return null; }
      else {
        let t1 = (-o.hw - lox) / ldx, t2 = (o.hw - lox) / ldx;
        let sg = -1; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
        if (t1 > tmin) { tmin = t1; axis = 0; sign = sg; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
      /* Y slab */
      if (Math.abs(dy) < 1e-9) { if (loy < -o.hh || loy > o.hh) return null; }
      else {
        let t1 = (-o.hh - loy) / dy, t2 = (o.hh - loy) / dy;
        let sg = -1; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
        if (t1 > tmin) { tmin = t1; axis = 1; sign = sg; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
      /* Z slab */
      if (Math.abs(ldz) < 1e-9) { if (loz < -o.hl || loz > o.hl) return null; }
      else {
        let t1 = (-o.hl - loz) / ldz, t2 = (o.hl - loz) / ldz;
        let sg = -1; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
        if (t1 > tmin) { tmin = t1; axis = 2; sign = sg; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
      if (tmax < 0 || tmin > maxT) return null;
      const tt = tmin > 0.01 ? tmin : tmax;
      if (tt <= 0.01 || tt > maxT) return null;
      let nx = 0, ny = 0, nz = 0;
      if (axis === 0) nx = sign; else if (axis === 1) ny = sign; else nz = sign;
      /* local normal -> world */
      const wnx = c * nx + s * nz, wnz = -s * nx + c * nz;
      res.t = tt; res.nx = wnx; res.ny = ny; res.nz = wnz;
      return res;
    }
    if (o.kind === 1 || o.kind === 3) { /* vertical cylinder (cone approximated) */
      const rad = o.kind === 3 ? o.r * 0.62 : o.r;
      const fx = ox - o.x, fz = oz - o.z;
      const a = dx * dx + dz * dz;
      if (a < 1e-12) return null;
      const b = 2 * (fx * dx + fz * dz);
      const cc = fx * fx + fz * fz - rad * rad;
      const disc = b * b - 4 * a * cc;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      let tt = (-b - sq) / (2 * a);
      if (tt <= 0.01) tt = (-b + sq) / (2 * a);
      if (tt <= 0.01 || tt > maxT) return null;
      const hy = oy + dy * tt;
      if (hy < o.y || hy > o.y + o.h) return null;
      const hx = ox + dx * tt - o.x, hz = oz + dz * tt - o.z;
      const il = 1 / Math.max(1e-6, Math.hypot(hx, hz));
      res.t = tt; res.nx = hx * il; res.ny = 0; res.nz = hz * il;
      return res;
    }
    /* sphere */
    const fx = ox - o.x, fy = oy - o.y, fz = oz - o.z;
    const b = 2 * (fx * dx + fy * dy + fz * dz);
    const cc = fx * fx + fy * fy + fz * fz - o.r * o.r;
    const disc = b * b - 4 * cc; // a == 1 (dir normalized)
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let tt = (-b - sq) / 2;
    if (tt <= 0.01) tt = (-b + sq) / 2;
    if (tt <= 0.01 || tt > maxT) return null;
    res.t = tt;
    res.nx = (ox + dx * tt - o.x) / o.r;
    res.ny = (oy + dy * tt - o.y) / o.r;
    res.nz = (oz + dz * tt - o.z) / o.r;
    return res;
  }

  refreshDynamicGrid() {
    this.dynHeads.fill(-1);
    for (const id of this.dynList) {
      const o = this.objects[id];
      const [x0, x1, z0, z1] = this.objAABB(o);
      const c0 = Math.floor(x0 / WORLD.gridCell + GRID_HALF), c1 = Math.floor(x1 / WORLD.gridCell + GRID_HALF);
      const r0 = Math.floor(z0 / WORLD.gridCell + GRID_HALF), r1 = Math.floor(z1 / WORLD.gridCell + GRID_HALF);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        if (c < 0 || r < 0 || c >= GRID_N || r >= GRID_N) continue;
        const cell = r * GRID_N + c;
        this.objNext[id] = this.dynHeads[cell];
        this.dynHeads[cell] = id;
      }
    }
  }

  /* ---------------- ground material ---------------- */

  private indexRoads() {
    for (let si = 0; si < this.roads.length; si++) {
      const s = this.roads[si];
      const pad = s.half + 3;
      const c0 = Math.floor((Math.min(s.ax, s.bx) - pad) / WORLD.gridCell + GRID_HALF);
      const c1 = Math.floor((Math.max(s.ax, s.bx) + pad) / WORLD.gridCell + GRID_HALF);
      const r0 = Math.floor((Math.min(s.az, s.bz) - pad) / WORLD.gridCell + GRID_HALF);
      const r1 = Math.floor((Math.max(s.az, s.bz) + pad) / WORLD.gridCell + GRID_HALF);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        if (c < 0 || r < 0 || c >= GRID_N || r >= GRID_N) continue;
        const cell = r * GRID_N + c;
        this.roadNext[si] = this.roadIndex[cell];
        this.roadIndex[cell] = si;
      }
    }
  }

  distToSeg(s: RoadSeg, x: number, z: number): { d: number; along: number; lat: number } {
    const abx = s.bx - s.ax, abz = s.bz - s.az;
    const l2 = abx * abx + abz * abz;
    let t = l2 > 0 ? ((x - s.ax) * abx + (z - s.az) * abz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = s.ax + abx * t, pz = s.az + abz * t;
    const d = Math.hypot(x - px, z - pz);
    const along = t * s.len;
    const lat = (x - px) * s.nx + (z - pz) * s.nz;
    return { d, along, lat };
  }

  groundMatAt(x: number, z: number): number {
    const cell = this.cellIdx(x, z);
    let bestSeg: RoadSeg | null = null;
    let bestInfo = { d: 1e9, along: 0, lat: 0 };
    if (cell >= 0) {
      let si = this.roadIndex[cell];
      while (si !== -1) {
        const s = this.roads[si];
        const info = this.distToSeg(s, x, z);
        if (info.d < bestInfo.d) { bestInfo = info; bestSeg = s; }
        si = this.roadNext[si];
      }
    }
    if (bestSeg && bestInfo.d <= bestSeg.half) {
      /* lane paint */
      const lat = Math.abs(bestInfo.lat);
      const laneW = 3.5;
      if (bestSeg.kind !== 'ramp') {
        if (Math.abs(lat - (bestSeg.half - 0.3)) < 0.15) return MAT.PAINT;
        const half2 = bestSeg.half - 0.3;
        for (let l = 1; l < bestSeg.lanes; l++) {
          const line = l * laneW * (lat < half2 ? 1 : -1);
          if (Math.abs(Math.abs(bestInfo.lat) - Math.abs(line)) < 0.15) return MAT.PAINT;
        }
        if (bestSeg.oneway === 0 && lat < 0.28) {
          /* center double line, dashed sometimes */
          const dash = Math.floor(bestInfo.along / 6) % 2 === 0;
          if (dash) return MAT.PAINT;
        }
      }
      /* crosswalk bands near nodes */
      if (bestSeg.aNode >= 0 || bestSeg.bNode >= 0) {
        const nearA = bestInfo.along < 6 && bestSeg.aNode >= 0;
        const nearB = (bestSeg.len - bestInfo.along) < 6 && bestSeg.bNode >= 0;
        if ((nearA || nearB) && lat < bestSeg.half - 0.5) {
          const stripe = Math.floor(bestInfo.along * 1.6) % 2 === 0;
          if (stripe) return MAT.PAINT;
        }
      }
      return bestSeg.kind === 'pad' ? MAT.CONCRETE : MAT.ASPHALT;
    }
    if (bestSeg && bestInfo.d <= bestSeg.half + 2.4) {
      const dist = DISTRICTS[bestSeg.district as keyof typeof DISTRICTS];
      if (dist && (bestSeg.district === 'mountain')) return MAT.DIRT;
      return MAT.CONCRETE;
    }
    /* district ground */
    const district = this.districtAt(x, z);
    switch (district) {
      case 'facility': return MAT.CONCRETE;
      case 'city': {
        const n = Math.sin(x * 0.021 + Math.floor(z / 26) * 3.7) * Math.cos(z * 0.017 + Math.floor(x / 31) * 2.3);
        return n > 0.25 ? MAT.GRASS : MAT.CONCRETE;
      }
      case 'industrial': return MAT.CONCRETE;
      case 'mountain': return MAT.GRASS;
      case 'experimental': return MAT.TARMAC_DARK;
      default: return MAT.GRASS;
    }
  }

  districtAt(x: number, z: number): string {
    let best = 'wilderness';
    let bestD = 1e9;
    for (const [key, d] of Object.entries(DISTRICTS)) {
      const dd = Math.max(Math.abs(x - d.cx), Math.abs(z - d.cz)) - d.size / 2;
      if (dd < 0) return key;
      if (dd < bestD) { bestD = dd; best = key; }
    }
    return best;
  }

  /* ---------------- road network ---------------- */

  private addNode(x: number, z: number, district: string, light = false): number {
    /* merge nearby nodes */
    for (const n of this.nodes) {
      if (Math.abs(n.x - x) < 6 && Math.abs(n.z - z) < 6) return n.id;
    }
    const node: RoadNode = { id: this.nodes.length, x, z, links: [], light, district };
    this.nodes.push(node);
    return node.id;
  }

  addRoad(ax: number, az: number, bx: number, bz: number, opts: Partial<RoadSeg> = {}): number {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1) return -1;
    const seg: RoadSeg = {
      ax, az, bx, bz,
      half: opts.half ?? 7, lanes: opts.lanes ?? 2, speed: opts.speed ?? 13,
      kind: opts.kind ?? 'street', district: opts.district ?? 'city',
      oneway: opts.oneway ?? 0,
      len, dx: dx / len, dz: dz / len,
      nx: -dz / len, nz: dx / len,
      aNode: opts.aNode ?? -1, bNode: opts.bNode ?? -1
    };
    this.roads.push(seg);
    return this.roads.length - 1;
  }

  buildNetwork() {
    /* CITY GRID */
    const S = 92, N = 6;
    const cx = DISTRICTS.city.cx, cz = DISTRICTS.city.cz;
    const gridNodes: number[][] = [];
    for (let r = 0; r <= N; r++) {
      gridNodes[r] = [];
      for (let c = 0; c <= N; c++) {
        gridNodes[r][c] = this.addNode(cx + (c - N / 2) * S, cz + (r - N / 2) * S, 'city', true);
      }
    }
    for (let r = 0; r <= N; r++) for (let c = 0; c < N; c++) {
      const a = gridNodes[r][c], b = gridNodes[r][c + 1];
      const na = this.nodes[a], nb = this.nodes[b];
      na.links.push(b); nb.links.push(a);
      this.addRoad(na.x, na.z, nb.x, nb.z, { half: 8, lanes: 2, speed: 12, kind: 'avenue', district: 'city', aNode: a, bNode: b });
    }
    for (let r = 0; r < N; r++) for (let c = 0; c <= N; c++) {
      const a = gridNodes[r][c], b = gridNodes[r + 1][c];
      const na = this.nodes[a], nb = this.nodes[b];
      na.links.push(b); nb.links.push(a);
      this.addRoad(na.x, na.z, nb.x, nb.z, { half: 8, lanes: 2, speed: 12, kind: 'street', district: 'city', aNode: a, bNode: b });
    }

    /* HIGHWAY: two parallel one-way carriageways */
    const hz = DISTRICTS.highway.cz;
    const hx0 = -1250, hx1 = 1450;
    const sA = this.addRoad(hx0, hz - 9, hx1, hz - 9, { half: 10, lanes: 2, speed: 33, kind: 'highway', district: 'highway', oneway: 1 });
    const sB = this.addRoad(hx1, hz + 9, hx0, hz + 9, { half: 10, lanes: 2, speed: 33, kind: 'highway', district: 'highway', oneway: 2 });
    const hA0 = this.addNode(hx0, hz - 9, 'highway'), hA1 = this.addNode(hx1, hz - 9, 'highway');
    const hB0 = this.addNode(hx0, hz + 9, 'highway'), hB1 = this.addNode(hx1, hz + 9, 'highway');
    this.roads[sA].aNode = hA0; this.roads[sA].bNode = hA1;
    this.roads[sB].aNode = hB1; this.roads[sB].bNode = hB0;
    this.nodes[hA0].links.push(hA1); this.nodes[hA1].links.push(hA0);
    this.nodes[hB0].links.push(hB1); this.nodes[hB1].links.push(hB0);

    /* RAMP: city south edge down to highway */
    const rampNodeCity = this.addNode(cx, cz + (N / 2) * S + 90, 'city');
    const citySouth = gridNodes[N][Math.floor(N / 2)];
    this.nodes[citySouth].links.push(rampNodeCity);
    this.addRoad(this.nodes[citySouth].x, this.nodes[citySouth].z, cx, hz + 9, { half: 5, lanes: 1, speed: 14, kind: 'ramp', district: 'city', aNode: citySouth, bNode: rampNodeCity });
    this.nodes[rampNodeCity].links.push(hB1);
    this.addRoad(cx, hz + 9, cx, hz + 9, { half: 0.1, lanes: 1, speed: 0, kind: 'ramp', district: 'highway' }); // zero-length marker (skipped)
    this.roads.pop(); // remove marker; ramp connects at hz+9 via node proximity
    const rampJoin = this.addRoad(cx, this.nodes[citySouth].z + 90, cx, hz + 21, { half: 5, lanes: 1, speed: 14, kind: 'ramp', district: 'highway', aNode: rampNodeCity, bNode: hB0 });
    this.nodes[hB0].links.push(rampNodeCity); this.nodes[rampNodeCity].links.push(hB0);
    void rampJoin;

    /* INDUSTRIAL connector from city east side */
    const cityEast = gridNodes[Math.floor(N / 2)][N];
    const indNode = this.addNode(DISTRICTS.industrial.cx - 180, DISTRICTS.industrial.cz, 'industrial');
    this.nodes[cityEast].links.push(indNode); this.nodes[indNode].links.push(cityEast);
    this.addRoad(this.nodes[cityEast].x, this.nodes[cityEast].z, this.nodes[indNode].x, this.nodes[indNode].z, { half: 7, lanes: 2, speed: 15, kind: 'avenue', district: 'industrial', aNode: cityEast, bNode: indNode });
    /* industrial internal yard road */
    const indB = this.addNode(DISTRICTS.industrial.cx + 100, DISTRICTS.industrial.cz, 'industrial');
    this.nodes[indNode].links.push(indB); this.nodes[indB].links.push(indNode);
    this.addRoad(this.nodes[indNode].x, this.nodes[indNode].z, this.nodes[indB].x, this.nodes[indB].z, { half: 6, lanes: 2, speed: 10, kind: 'pad', district: 'industrial', aNode: indNode, bNode: indB });

    /* MOUNTAIN rural road: winding path west */
    const wx = DISTRICTS.mountain.cx, wz = DISTRICTS.mountain.cz;
    const path: [number, number][] = [
      [wx - 260, wz - 240], [wx - 180, wz - 120], [wx - 240, wz + 10], [wx - 140, wz + 130],
      [wx + 10, wz + 170], [wx + 150, wz + 90], [wx + 210, wz - 40], [wx + 130, wz - 160],
      [wx - 10, wz - 220]
    ];
    let prev = -1;
    const cityWest = gridNodes[Math.floor(N / 2)][0];
    for (let i = 0; i < path.length; i++) {
      const nId = this.addNode(path[i][0], path[i][1], 'mountain');
      if (prev >= 0) {
        this.nodes[prev].links.push(nId); this.nodes[nId].links.push(prev);
        this.addRoad(this.nodes[prev].x, this.nodes[prev].z, this.nodes[nId].x, this.nodes[nId].z, { half: 5.5, lanes: 1, speed: 11, kind: 'rural', district: 'mountain', aNode: prev, bNode: nId });
      } else {
        this.nodes[cityWest].links.push(nId); this.nodes[nId].links.push(cityWest);
        this.addRoad(this.nodes[cityWest].x, this.nodes[cityWest].z, this.nodes[nId].x, this.nodes[nId].z, { half: 5.5, lanes: 1, speed: 11, kind: 'rural', district: 'mountain', aNode: cityWest, bNode: nId });
      }
      prev = nId;
    }
    /* mountain loop back to highway west end */
    this.nodes[prev].links.push(hB0); this.nodes[hB0].links.push(prev);
    this.addRoad(this.nodes[prev].x, this.nodes[prev].z, hx0, hz + 9, { half: 5.5, lanes: 1, speed: 11, kind: 'rural', district: 'mountain', aNode: prev, bNode: hB0 });

    /* EXPERIMENTAL zone access from highway */
    const expNode = this.addNode(DISTRICTS.experimental.cx, DISTRICTS.experimental.cz + 160, 'experimental');
    const hMid = this.addNode(600, hz + 9, 'highway');
    this.nodes[hMid].links.push(expNode); this.nodes[expNode].links.push(hMid);
    this.nodes[hB0].links.push(hMid); this.nodes[hMid].links.push(hB0);
    this.addRoad(600, hz + 9, this.nodes[expNode].x, this.nodes[expNode].z, { half: 5, lanes: 1, speed: 12, kind: 'ramp', district: 'experimental', aNode: hMid, bNode: expNode });

    /* FACILITY access from city west */
    const facNode = this.addNode(DISTRICTS.facility.cx + 180, DISTRICTS.facility.cz, 'facility');
    this.nodes[cityWest].links.push(facNode); this.nodes[facNode].links.push(cityWest);
    this.addRoad(this.nodes[facNode].x, this.nodes[facNode].z, this.nodes[cityWest].x, this.nodes[cityWest].z, { half: 6, lanes: 2, speed: 13, kind: 'avenue', district: 'facility', aNode: facNode, bNode: cityWest });
    /* facility internal test strip */
    const facA = this.addNode(DISTRICTS.facility.cx - 190, DISTRICTS.facility.cz, 'facility');
    this.nodes[facNode].links.push(facA); this.nodes[facA].links.push(facNode);
    this.addRoad(this.nodes[facA].x, this.nodes[facA].z, this.nodes[facNode].x, this.nodes[facNode].z, { half: 6, lanes: 2, speed: 10, kind: 'pad', district: 'facility', aNode: facA, bNode: facNode });

    this.indexRoads();
  }

  /* ---------------- districts (props & structures) ---------------- */

  buildDistricts() {
    this.buildNetwork();
    this.buildFacility();
    this.buildCity();
    this.buildHighway();
    this.buildIndustrial();
    this.buildMountain();
    this.buildExperimental();
    this.buildChargePads();
    this.refreshDynamicGrid();
  }

  private buildFacility() {
    const { cx, cz } = DISTRICTS.facility;
    const r = () => this.rng();
    /* perimeter walls */
    const W = 220;
    this.addBox('barrier', MAT.BARRIER, cx, 1.2, cz - W, 2 * W + 8, 2.4, 1.2, 0, { collR: 0 });
    this.addBox('barrier', MAT.BARRIER, cx, 1.2, cz + W, 2 * W + 8, 2.4, 1.2, 0, { collR: 0 });
    this.addBox('barrier', MAT.BARRIER, cx - W, 1.2, cz, 1.2, 2.4, 2 * W + 8, 0, { collR: 0 });
    this.addBox('barrier', MAT.BARRIER, cx + W, 1.2, cz, 1.2, 2.4, 2 * W + 8, 0, { collR: 0 });

    /* control tower */
    this.addBox('building', MAT.BUILDING, cx - 150, 9, cz - 150, 30, 18, 30, 0, { tags: ['scan-tower'] });
    this.addBox('building', MAT.GLASS, cx - 150, 19, cz - 150, 26, 4, 26, 0);

    /* obstacle course: slalom cones */
    for (let i = 0; i < 7; i++) {
      this.addCone('cone', MAT.BARRIER, cx - 120 + i * 32, 0, cz - 40 + (i % 2 === 0 ? -6 : 6), 0.55, 1.0, { tags: ['course-cone'] });
    }
    /* boxed corridor */
    for (let i = 0; i < 6; i++) {
      this.addBox('barrier', MAT.BARRIER, cx - 60, 0.6, cz + 20 + i * 0, 4, 1.2, 1.2, i * 0.3);
      this.addBox('barrier', MAT.BARRIER, cx - 60 + i * 24, 0.6, cz + 60, 2, 1.2, 12, 0, { tags: ['course-wall'] });
      this.addBox('barrier', MAT.BARRIER, cx - 60 + i * 24, 0.6, cz + 100, 2, 1.2, 12, 0, { tags: ['course-wall'] });
    }
    /* parked vehicles row */
    for (let i = 0; i < 5; i++) this.makeParkedCar(cx + 60 + i * 26, cz - 100, r() * Math.PI * 2);
    /* parking bays with target */
    for (let i = 0; i < 6; i++) {
      this.addBox('prop', MAT.PAINT, cx + 40 + i * 14, 0.02, cz + 120, 0.4, 0.05, 12, 0, { collR: 0 });
    }
    this.addBox('prop', MAT.PAINT, cx + 40, 0.02, cz + 114, 78, 0.05, 0.4, 0, { collR: 0 });
    this.addBox('prop', MAT.PAINT, cx + 40, 0.02, cz + 126, 78, 0.05, 0.4, 0, { collR: 0 });
    /* sensor test pylons at graduated ranges (inside the pad, east arm) */
    for (const d of [25, 50, 90, 140, 180]) {
      this.addCylinder('pole', MAT.METAL, cx + 40 + d, 0, cz - 150, 0.6, 4.2, { tags: ['pylon-' + d] });
      this.addSphere('sign', MAT.SIGN, cx + 40 + d, 4.6, cz - 150, 1.2, { tags: ['pylon-' + d] });
    }
    /* light poles */
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.addCylinder('pole', MAT.METAL, cx + Math.cos(a) * 190, 0, cz + Math.sin(a) * 190, 0.35, 9, {});
      this.addBox('prop', MAT.METAL, cx + Math.cos(a) * 190, 9.1, cz + Math.sin(a) * 190, 2.6, 0.3, 0.8, a);
    }
  }

  private makeParkedCar(x: number, z: number, yaw: number, tags: string[] = []) {
    const g = 'park-' + x.toFixed(0) + '-' + z.toFixed(0);
    this.addBox('vehicle', MAT.VEHICLE, x, 0.75, z, 1.9, 1.0, 4.5, yaw, { group: g, collR: 2.4, tags });
    this.addBox('vehicle', MAT.GLASS, x, 1.55, z, 1.7, 0.7, 2.3, yaw, { group: g, collR: 0 });
  }

  private buildCity() {
    const { cx, cz } = DISTRICTS.city;
    const S = 92, N = 6;
    const r = () => this.rng();
    for (let br = 0; br < N; br++) for (let bc = 0; bc < N; bc++) {
      const bx = cx + (bc - N / 2 + 0.5) * S;
      const bz = cz + (br - N / 2 + 0.5) * S;
      const inner = Math.abs(br - N / 2) < 1.6 && Math.abs(bc - N / 2) < 1.6;
      if (r() < 0.12) { /* park block */
        for (let t = 0; t < 12; t++) this.makeTree(bx + (r() - 0.5) * 60, bz + (r() - 0.5) * 60);
        continue;
      }
      const roofProps = (rx: number, rz: number, topY: number, rw: number, rl: number) => {
        /* AC units + antenna clutter — richer silhouettes for the scanner */
        const n = 1 + Math.floor(r() * 3);
        for (let k = 0; k < n; k++) {
          const px = rx + (r() - 0.5) * rw * 0.55;
          const pz = rz + (r() - 0.5) * rl * 0.55;
          this.addBox('prop', MAT.METAL, px, topY + 0.8, pz, 2 + r() * 2.4, 1.4 + r() * 0.8, 2 + r() * 2.2, r() * 0.5, { collR: 0 });
        }
        if (r() < 0.55) {
          this.addCylinder('prop', MAT.METAL, rx + (r() - 0.5) * rw * 0.4, topY, rz + (r() - 0.5) * rl * 0.4, 0.09, 3 + r() * 4, { collR: 0 });
        }
      };
      if (inner) { /* downtown towers */
        const h = 24 + r() * 26;
        const bw = 34 + r() * 14, bl = 34 + r() * 14;
        this.addBox('building', MAT.BUILDING, bx, h / 2, bz, bw, h, bl, 0, { tags: ['downtown'] });
        if (r() < 0.6) this.addBox('building', MAT.GLASS, bx, h * 0.7, bz, bw * 0.86, h * 0.25, bl * 0.86, 0);
        if (r() < 0.4) this.addCylinder('building', MAT.BUILDING, bx, h, bz, 4, 6 + r() * 8, {});
        roofProps(bx, bz, h + (r() < 0.4 ? 6 : 0), bw, bl);
      } else if (br < 2 || bc < 2) { /* residential */
        const bw = 18 + r() * 10, bl = 18 + r() * 10, h = 5 + r() * 4;
        this.addBox('building', MAT.BUILDING, bx - 14, h / 2, bz - 14, bw, h, bl, 0, { tags: ['residential'] });
        this.addBox('building', MAT.BUILDING, bx + 16, h / 2 + 1, bz + 12, bw * 0.8, h + 2, bl * 0.8, 0.3, { tags: ['residential'] });
        roofProps(bx - 14, bz - 14, h, bw, bl);
        this.makeTree(bx + 2, bz - 26);
        this.makeTree(bx - 28, bz + 4);
      } else { /* commercial mid-rise */
        const h = 10 + r() * 12;
        const bw = 40 + r() * 12, bl = 30 + r() * 16;
        this.addBox('building', MAT.BUILDING, bx, h / 2, bz, bw, h, bl, 0, { tags: ['commercial'] });
        if (r() < 0.5) this.addBox('building', MAT.BUILDING, bx + 24, 4, bz + 22, 16, 8, 16, 0.2);
        roofProps(bx, bz, h, bw, bl);
        this.makeTree(bx - 30, bz + 30);
      }
    }
    /* street furniture: lights + signs along avenues */
    for (let rI = 0; rI <= N; rI++) for (let cI = 0; cI <= N; cI++) {
      const nx = cx + (cI - N / 2) * S, nz = cz + (rI - N / 2) * S;
      this.addCylinder('pole', MAT.METAL, nx + 10.5, 0, nz + 10.5, 0.3, 8.5, {});
      this.addBox('prop', MAT.METAL, nx + 12, 8.6, nz + 10.5, 2.4, 0.25, 0.7, 0);
      /* traffic light heads on two corners */
      this.addCylinder('pole', MAT.METAL, nx - 10.5, 0, nz - 10.5, 0.28, 6.4, {});
      this.addBox('light', MAT.METAL, nx - 9.2, 6.0, nz - 10.5, 0.7, 1.7, 0.55, Math.PI / 2, { group: 'tl-' + rI + '-' + cI });
      if ((rI + cI) % 2 === 0) {
        this.addCylinder('sign', MAT.METAL, nx + 11, 0, nz - 11, 0.14, 3.2, {});
        this.addBox('sign', MAT.SIGN, nx + 11, 3.1, nz - 9.6, 1.5, 0.8, 0.08, 0, { group: 'sign-' + rI + '-' + cI, tags: ['roadsign'] });
      }
    }
    /* parked cars along curbs */
    for (let i = 0; i < 26; i++) {
      const seg = this.roads[Math.floor(r() * this.roads.length)];
      if (seg.kind !== 'street' && seg.kind !== 'avenue') continue;
      const t = r();
      const x = seg.ax + (seg.bx - seg.ax) * t + seg.nx * (seg.half + 1.6);
      const z = seg.az + (seg.bz - seg.az) * t + seg.nz * (seg.half + 1.6);
      this.makeParkedCar(x, z, Math.atan2(seg.dx, seg.dz) + (r() < 0.5 ? 0 : Math.PI));
    }
    /* construction zone props */
    for (let i = 0; i < 8; i++) this.addCone('cone', MAT.BARRIER, cx - 120 + i * 9, 0, cz - 92, 0.5, 0.9, { tags: ['construction'] });
    this.addBox('barrier', MAT.BARRIER, cx - 80, 1, cz - 92, 3, 2, 1, 0, { tags: ['construction'] });
  }

  private makeTree(x: number, z: number) {
    const g = 'tree-' + x.toFixed(0) + '-' + z.toFixed(0);
    const r = this.rng;
    const h = 3 + r() * 5;
    this.addCylinder('tree', MAT.TREE, x, 0, z, 0.26 + r() * 0.08, h, { group: g, collR: 0.5 });
    this.addSphere('tree', MAT.TREE, x, h + 1.1, z, 1.7 + r() * 1.3, { group: g, collR: 0 });
    /* second canopy lobe for organic silhouette */
    this.addSphere('tree', MAT.TREE, x + (r() - 0.5) * 2.2, h + 2.1, z + (r() - 0.5) * 2.2, 1.1 + r() * 1.0, { group: g, collR: 0 });
  }

  private buildHighway() {
    const hz = DISTRICTS.highway.cz;
    /* jersey barriers: median + edges */
    for (let x = -1250; x <= 1450; x += 100) {
      this.addBox('barrier', MAT.CONCRETE, x + 50, 0.55, hz, 100, 1.1, 0.6, 0, { collR: 0 });
      this.addBox('barrier', MAT.METAL, x + 50, 1.0, hz - 21, 100, 1.4, 0.4, 0, { collR: 0, tags: ['highway-barrier'] });
      this.addBox('barrier', MAT.METAL, x + 50, 1.0, hz + 21, 100, 1.4, 0.4, 0, { collR: 0, tags: ['highway-barrier'] });
      if (Math.floor(x / 100) % 4 === 0) {
        this.addCylinder('pole', MAT.METAL, x + 50, 0, hz + 26, 0.4, 11, {});
        this.addBox('prop', MAT.METAL, x + 50, 11.1, hz + 26, 3, 0.3, 0.9, 0);
      }
    }
    /* gantry sign */
    this.addCylinder('pole', MAT.METAL, 200, 0, hz + 24, 0.6, 9, {});
    this.addCylinder('pole', MAT.METAL, 260, 0, hz + 24, 0.6, 9, {});
    this.addBox('sign', MAT.SIGN, 230, 8.4, hz + 24, 14, 3.4, 0.4, 0, { tags: ['gantry'] });
  }

  private buildIndustrial() {
    const { cx, cz } = DISTRICTS.industrial;
    const r = () => this.rng();
    /* warehouses */
    for (let i = 0; i < 6; i++) {
      const wx = cx - 160 + (i % 3) * 130, wz = cz - 140 + Math.floor(i / 3) * 190;
      this.addBox('building', MAT.METAL, wx, 7, wz, 90, 14, 52, (i % 3) * 0.06, { tags: ['warehouse'] });
      this.addCylinder('prop', MAT.METAL, wx - 30, 0, wz + 34, 2.2, 9, { tags: ['silo'] });
      this.addCylinder('prop', MAT.METAL, wx - 36, 0, wz + 34, 2.2, 9, { tags: ['silo'] });
    }
    /* container stacks */
    for (let i = 0; i < 22; i++) {
      const x = cx + 60 + (i % 7) * 13, z = cz - 40 + Math.floor(i / 7) * 34;
      const rows = 1 + Math.floor(r() * 3);
      for (let k = 0; k < rows; k++) {
        this.addBox('obstacle', MAT.METAL, x, 1.35 + k * 2.7, z, 12.2, 2.6, 2.6, (r() - 0.5) * 0.1, { tags: ['container'] });
      }
    }
    /* machinery + barrels */
    for (let i = 0; i < 10; i++) {
      this.addCylinder('obstacle', MAT.METAL, cx - 120 + r() * 260, 0, cz + 120 + r() * 140, 1.6, 2.4 + r() * 3, { tags: ['machine'] });
    }
    for (let i = 0; i < 14; i++) {
      this.addCylinder('obstacle', MAT.METAL, cx - 200 + r() * 380, 0, cz + 60 + r() * 200, 0.42, 1.0, { tags: ['barrel'] });
    }
    /* loading dock trucks */
    for (let i = 0; i < 4; i++) {
      const x = cx - 160 + i * 105, z = cz - 108;
      const g = 'docktruck-' + i;
      this.addBox('truck', MAT.VEHICLE, x, 1.9, z, 2.6, 2.8, 7.5, Math.PI, { group: g, collR: 3.6, tags: ['delivery-truck'] });
      this.addBox('truck', MAT.METAL, x, 2.4, z + 6.4, 2.7, 3.4, 7.8, Math.PI, { group: g, collR: 0 });
    }
  }

  private buildMountain() {
    const path = this.nodes.filter(n => n.district === 'mountain');
    const r = () => this.rng();
    /* trees + rocks along the road */
    for (let i = 0; i < 240; i++) {
      const seg = this.roads.filter(s => s.kind === 'rural');
      const s = seg[Math.floor(r() * seg.length)];
      if (!s) continue;
      const t = r();
      const side = r() < 0.5 ? 1 : -1;
      const off = 9 + r() * 46;
      const x = s.ax + (s.bx - s.ax) * t + s.nx * side * off;
      const z = s.az + (s.bz - s.az) * t + s.nz * side * off;
      if (r() < 0.8) this.makeTree(x, z);
      else this.addSphere('rock', MAT.ROCK, x, 0.4, z, 0.9 + r() * 2.4, { collR: 1.8, tags: ['boulder'] });
    }
    /* scenic hills (large cones) */
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const d = 420 + r() * 260;
      this.addCone('building', MAT.GRASS, DISTRICTS.mountain.cx + Math.cos(a) * d, 0, DISTRICTS.mountain.cz + Math.sin(a) * d, 90 + r() * 120, 60 + r() * 90, { collR: 0, tags: ['hill'] });
    }
    /* TUNNEL over one rural segment */
    const tunnelSeg = this.roads.find(s => s.kind === 'rural' && s.len > 100);
    if (tunnelSeg) {
      const steps = Math.floor(tunnelSeg.len / 12);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = tunnelSeg.ax + (tunnelSeg.bx - tunnelSeg.ax) * t;
        const z = tunnelSeg.az + (tunnelSeg.bz - tunnelSeg.az) * t;
        const yaw = Math.atan2(tunnelSeg.dx, tunnelSeg.dz);
        this.addBox('building', MAT.CONCRETE, x + tunnelSeg.nx * 7.5, 3, z + tunnelSeg.nz * 7.5, 1.4, 6, 12.4, yaw, { group: 'tunnel', collR: 0, tags: ['tunnel'] });
        this.addBox('building', MAT.CONCRETE, x - tunnelSeg.nx * 7.5, 3, z - tunnelSeg.nz * 7.5, 1.4, 6, 12.4, yaw, { group: 'tunnel', collR: 0, tags: ['tunnel'] });
        this.addBox('building', MAT.CONCRETE, x, 6.4, z, 17, 1.2, 12.4, yaw, { group: 'tunnel', collR: 0, tags: ['tunnel'] });
      }
      (tunnelSeg as any).tunnel = true;
    }
    /* guard posts */
    for (let i = 0; i < 10; i++) {
      const s = this.roads.filter(sg => sg.kind === 'rural')[i % 8];
      if (!s) continue;
      const t = 0.2 + r() * 0.6;
      this.addBox('barrier', MAT.BARRIER, s.ax + (s.bx - s.ax) * t + s.nx * 7, 0.6, s.az + (s.bz - s.az) * t + s.nz * 7, 2.4, 1.2, 0.5, Math.atan2(s.dx, s.dz), { collR: 0 });
    }
  }

  chargePads: { x: number; z: number }[] = [];

  private addChargePad(x: number, z: number, yaw: number) {
    /* painted pad + charging pylon with emitter head — visible in the point cloud */
    this.addBox('prop', MAT.PAINT, x, 0.03, z, 5.5, 0.05, 7, yaw, { collR: 0, tags: ['charge-pad'] });
    this.addCylinder('pole', MAT.METAL, x - Math.sin(yaw + Math.PI / 2) * 3.4, 0, z - Math.cos(yaw + Math.PI / 2) * 3.4, 0.22, 2.6, { tags: ['charge-pole'] });
    this.addBox('prop', MAT.METAL, x - Math.sin(yaw + Math.PI / 2) * 3.4, 2.75, z - Math.cos(yaw + Math.PI / 2) * 3.4, 0.7, 0.5, 0.35, yaw, { tags: ['charge-pole'] });
    this.chargePads.push({ x, z });
  }

  private buildChargePads() {
    this.addChargePad(DISTRICTS.facility.cx + 60, DISTRICTS.facility.cz, 0);
    this.addChargePad(DISTRICTS.city.cx - 46, DISTRICTS.city.cz - 46, Math.PI / 4);
    this.addChargePad(600, DISTRICTS.highway.cz + 40, 0);
    this.addChargePad(DISTRICTS.industrial.cx - 100, DISTRICTS.industrial.cz + 90, 0);
    this.addChargePad(DISTRICTS.mountain.cx - 60, DISTRICTS.mountain.cz - 180, 0.6);
    this.addChargePad(DISTRICTS.experimental.cx - 90, DISTRICTS.experimental.cz + 60, 0);
  }

  private buildExperimental() {
    const { cx, cz } = DISTRICTS.experimental;
    const r = () => this.rng();
    /* low-reflectivity monoliths */
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const d = 60 + r() * 110;
      const h = 8 + r() * 22;
      this.addBox('building', MAT.DARK, cx + Math.cos(a) * d, h / 2, cz + Math.sin(a) * d, 6 + r() * 14, h, 6 + r() * 14, r() * Math.PI, { tags: ['monolith'] });
    }
    /* central spire complex */
    this.addCylinder('building', MAT.DARK, cx, 0, cz, 9, 46, { tags: ['spire'] });
    this.addSphere('building', MAT.DARK, cx, 48, cz, 7, { tags: ['spire'] });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.addCylinder('building', MAT.DARK, cx + Math.cos(a) * 26, 0, cz + Math.sin(a) * 26, 3, 20 + r() * 16, { tags: ['spire'] });
    }
    /* perimiter fence (dark, low) */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      this.addBox('barrier', MAT.DARK, cx + Math.cos(a) * 185, 1.4, cz + Math.sin(a) * 185, 250, 2.8, 0.5, a + Math.PI / 2, { collR: 0, tags: ['exp-fence'] });
    }
    /* test pads */
    this.addBox('prop', MAT.PAINT, cx - 80, 0.02, cz - 80, 40, 0.05, 40, 0, { collR: 0 });
  }

  /* ---------------- traffic & pedestrians ---------------- */

  spawnTraffic(count: number, peds: number) {
    const drivable = this.roads.filter(s => s.kind === 'street' || s.kind === 'avenue' || s.kind === 'highway' || s.kind === 'rural');
    for (let i = 0; i < count; i++) {
      const seg = drivable[Math.floor(this.rng() * drivable.length)];
      const dir: 1 | 2 = seg.oneway === 1 ? 1 : seg.oneway === 2 ? 2 : (this.rng() < 0.5 ? 1 : 2);
      const isHighway = seg.kind === 'highway';
      const truck = isHighway && this.rng() < 0.25;
      const lateral = (this.rng() < 0.5 ? -1 : 1) * (1.75 + (this.rng() < 0.4 ? 3.5 : 0)) * (dir === 1 ? 1 : -1);
      const g = 'traffic-' + i;
      const obj = truck
        ? this.addObj({ kind: 0, cls: 'truck', mat: MAT.VEHICLE, x: 0, y: 1.6, z: 0, yaw: 0, hw: 1.3, hh: 1.7, hl: 4.2, dynamic: true, group: g, collR: 3.2, tags: ['moving-truck'] })
        : this.addObj({ kind: 0, cls: 'vehicle', mat: MAT.VEHICLE, x: 0, y: 0.8, z: 0, yaw: 0, hw: 0.95, hh: 0.75, hl: 2.2, dynamic: true, group: g, collR: 2.3, tags: ['moving-vehicle'] });
      if (truck) {
        const body = obj;
        /* trailer as second dynamic primitive sharing group */
        const trailer = this.addObj({ kind: 0, cls: 'truck', mat: MAT.METAL, x: 0, y: 2.2, z: 0, yaw: 0, hw: 1.35, hh: 2.0, hl: 4.6, dynamic: true, group: g, collR: 0 });
        trailer.tags = ['moving-truck'];
        void body;
      }
      const agent: Agent = {
        obj, kind: truck ? 'truck' : 'car', seg: this.roads.indexOf(seg), dir, s: this.rng() * seg.len,
        lateral, speed: 0, targetSpeed: isHighway ? 24 + this.rng() * 9 : 7 + this.rng() * 5,
        yaw: 0, crossing: -1, crossedTo: 0, waitTimer: 0
      };
      this.agents.push(agent);
    }
    for (let i = 0; i < peds; i++) {
      const seg = drivable[Math.floor(this.rng() * drivable.length)];
      const g = 'ped-' + i;
      const obj = this.addObj({ kind: 0, cls: 'pedestrian', mat: MAT.PEDESTRIAN, x: 0, y: 0.95, z: 0, yaw: 0, hw: 0.26, hh: 0.95, hl: 0.26, dynamic: true, group: g, collR: 0.6, tags: ['pedestrian'] });
      const agent: Agent = {
        obj, kind: 'pedestrian', seg: this.roads.indexOf(seg), dir: this.rng() < 0.5 ? 1 : 2,
        s: this.rng() * seg.len, lateral: (seg.half + 1.6) * (this.rng() < 0.5 ? 1 : -1),
        speed: 1.2 + this.rng() * 0.8, targetSpeed: 1.4 + this.rng(), yaw: 0,
        crossing: -1, crossedTo: 0, waitTimer: this.rng() * 20
      };
      this.agents.push(agent);
    }
  }

  updateAgents(dt: number, playerX: number, playerZ: number) {
    this.time += dt;
    const lightPhase = Math.floor(this.time / 8) % 2; // 0: NS green, 1: EW green
    /* sort cars per segment for car-following (cheap: O(n^2) with n~70 but only near player matters) */
    for (const a of this.agents) {
      const seg = this.roads[a.seg];
      if (!seg) continue;
      const dToPlayer = Math.hypot(a.obj.x - playerX, a.obj.z - playerZ);
      if (dToPlayer > 560) { /* teleport far agents around player district to keep density */
        if (this.rng() < dt * 0.05) {
          const near = this.roads.filter(s => Math.hypot(s.ax - playerX, s.az - playerZ) < 420 && (s.kind === 'street' || s.kind === 'avenue' || s.kind === 'highway' || s.kind === 'rural'));
          if (near.length) {
            const s2 = near[Math.floor(this.rng() * near.length)];
            a.seg = this.roads.indexOf(s2); a.s = this.rng() * s2.len;
            a.speed = 0;
          }
        }
        continue;
      }
      if (a.kind === 'pedestrian') { this.updatePed(a, dt, seg); continue; }
      /* car-following: find nearest same-seg same-dir agent ahead */
      let gapSpeed = a.targetSpeed * this.trafficSpeedMul;
      for (const b of this.agents) {
        if (b === a || b.seg !== a.seg || b.dir !== a.dir || b.kind === 'pedestrian') continue;
        const mdx = b.obj.x - a.obj.x, mdz = b.obj.z - a.obj.z;
        if (mdx > 40 || mdx < -40 || mdz > 40 || mdz < -40) continue; /* early-out culling */
        const ds = (b.s - a.s) * (a.dir === 1 ? 1 : -1);
        if (ds > 0 && ds < 26) { gapSpeed = Math.min(gapSpeed, b.speed * (ds < 10 ? 0.4 : 0.85)); }
      }
      /* also avoid the player */
      const px2 = (playerX - a.obj.x), pz2 = (playerZ - a.obj.z);
      const ahead = px2 * seg.dx * (a.dir === 1 ? 1 : -1) + pz2 * seg.dz * (a.dir === 1 ? 1 : -1);
      const side = Math.abs(px2 * seg.nx + pz2 * seg.nz);
      if (ahead > 0 && ahead < 24 && side < 4) gapSpeed = Math.min(gapSpeed, ahead < 9 ? 0 : 3);
      /* traffic lights */
      const nodeAhead = a.dir === 1 ? seg.bNode : seg.aNode;
      const distToNode = a.dir === 1 ? seg.len - a.s : a.s;
      if (nodeAhead >= 0 && this.nodes[nodeAhead].light && distToNode < 9 && distToNode > 3) {
        const axisNS = Math.abs(seg.dz) > Math.abs(seg.dx);
        const red = axisNS ? lightPhase === 1 : lightPhase === 0;
        if (red) gapSpeed = 0;
      }
      a.speed += Math.max(-9 * dt, Math.min(4.5 * dt, (gapSpeed - a.speed) * 2.2 * dt + (gapSpeed > a.speed ? 2.2 * dt : -9 * dt)));
      a.speed = Math.max(0, a.speed);
      a.s += a.speed * dt * (a.dir === 1 ? 1 : -1);
      if (a.s > seg.len || a.s < 0) { /* pick next segment */
        const nodeId = a.s > seg.len ? seg.bNode : seg.aNode;
        const node = this.nodes[nodeId];
        const options: number[] = [];
        for (const li of node.links) {
          /* find segment between nodeId and li */
          for (let si = 0; si < this.roads.length; si++) {
            const s2 = this.roads[si];
            const match = (s2.aNode === nodeId && s2.bNode === li && s2.oneway !== 2) || (s2.aNode === li && s2.bNode === nodeId && s2.oneway !== 1);
            if (match && si !== a.seg) options.push(si);
          }
        }
        if (options.length) {
          const next = options[Math.floor(this.rng() * options.length)];
          const s2 = this.roads[next];
          a.seg = next;
          a.dir = s2.aNode === nodeId ? 1 : 2;
          a.s = a.dir === 1 ? 0.1 : s2.len - 0.1;
          a.speed *= 0.6;
        } else { a.s = Math.max(0.1, Math.min(seg.len - 0.1, a.s)); a.speed = 0; }
      }
      /* position */
      const dirSign = a.dir === 1 ? 1 : -1;
      const x = seg.ax + seg.dx * a.s + seg.nx * a.lateral * dirSign;
      const z = seg.az + seg.dz * a.s + seg.nz * a.lateral * dirSign;
      a.yaw = Math.atan2(seg.dx * dirSign, seg.dz * dirSign);
      a.obj.x = x; a.obj.z = z; a.obj.yaw = a.yaw;
      if (a.kind === 'truck' && a.obj.group) {
        for (const o2 of this.dynList) {
          const ob = this.objects[o2];
          if (ob !== a.obj && ob.group === a.obj.group) {
            ob.x = x - seg.dx * dirSign * 8.6; ob.z = z - seg.dz * dirSign * 8.6; ob.yaw = a.yaw;
          }
        }
      }
    }
  }

  private updatePed(a: Agent, dt: number, seg: RoadSeg) {
    a.waitTimer -= dt;
    if (a.crossing >= 0) {
      /* crossing: move lateral toward target */
      const dirSign = a.dir === 1 ? 1 : -1;
      const cur = a.lateral * dirSign;
      const step = a.speed * 1.2 * dt;
      const delta = a.crossedTo - cur;
      if (Math.abs(delta) <= step) { a.lateral = a.crossedTo * dirSign; a.crossing = -1; a.waitTimer = 8 + this.rng() * 24; }
      else a.lateral += (step * Math.sign(delta)) * dirSign;
      const x = seg.ax + seg.dx * a.s + seg.nx * a.lateral * dirSign;
      const z = seg.az + seg.dz * a.s + seg.nz * a.lateral * dirSign;
      a.obj.x = x; a.obj.z = z; a.yaw = Math.atan2(seg.nx * Math.sign(delta), seg.nz * Math.sign(delta));
      a.obj.yaw = a.yaw;
      return;
    }
    /* walking along sidewalk */
    a.s += a.speed * dt * (a.dir === 1 ? 1 : -1);
    if (a.s > seg.len || a.s < 0) {
      const nodeId = a.s > seg.len ? seg.bNode : seg.aNode;
      /* maybe cross here */
      if (a.waitTimer <= 0 && this.rng() < 0.5) {
        a.crossing = 0;
        a.crossedTo = -(a.lateral) * (a.dir === 1 ? 1 : -1) > 0 ? -a.lateral : -a.lateral;
        a.crossedTo = -a.lateral;
        return;
      }
      const node = this.nodes[nodeId];
      const options = node.links.filter(l => l !== nodeId);
      if (options.length) {
        const li = options[Math.floor(this.rng() * options.length)];
        for (let si = 0; si < this.roads.length; si++) {
          const s2 = this.roads[si];
          if ((s2.aNode === nodeId && s2.bNode === li) || (s2.aNode === li && s2.bNode === nodeId)) {
            a.seg = si; a.dir = s2.aNode === nodeId ? 1 : 2; a.s = a.dir === 1 ? 0.2 : s2.len - 0.2;
            a.lateral = (s2.half + 1.6) * Math.sign(a.lateral || 1);
            break;
          }
        }
      } else { a.dir = (a.dir === 1 ? 2 : 1); a.s = Math.max(0.2, Math.min(seg.len - 0.2, a.s)); }
    }
    const dirSign = a.dir === 1 ? 1 : -1;
    const x = seg.ax + seg.dx * a.s + seg.nx * a.lateral * dirSign;
    const z = seg.az + seg.dz * a.s + seg.nz * a.lateral * dirSign;
    a.yaw = Math.atan2(seg.dx * dirSign, seg.dz * dirSign);
    a.obj.x = x; a.obj.z = z; a.obj.yaw = a.yaw;
  }

  /* ---------------- routing ---------------- */

  findPath(fromX: number, fromZ: number, toX: number, toZ: number): number[] {
    const nearest = (x: number, z: number): number => {
      let best = -1, bd = 1e18;
      for (const n of this.nodes) { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; best = n.id; } }
      return best;
    };
    const start = nearest(fromX, fromZ), goal = nearest(toX, toZ);
    if (start === goal) return [start];
    const open: { id: number; f: number }[] = [{ id: start, f: 0 }];
    const g: Map<number, number> = new Map([[start, 0]]);
    const from: Map<number, number> = new Map();
    const goalN = this.nodes[goal];
    const h = (id: number) => Math.hypot(this.nodes[id].x - goalN.x, this.nodes[id].z - goalN.z);
    const closed = new Set<number>();
    while (open.length) {
      open.sort((a, b) => a.f - b.f);
      const cur = open.shift()!;
      if (cur.id === goal) break;
      if (closed.has(cur.id)) continue;
      closed.add(cur.id);
      const gc = g.get(cur.id)!;
      for (const li of this.nodes[cur.id].links) {
        const l = this.nodes[li];
        const w = Math.hypot(l.x - this.nodes[cur.id].x, l.z - this.nodes[cur.id].z);
        const ng = gc + w;
        if (!g.has(li) || ng < g.get(li)!) {
          g.set(li, ng); from.set(li, cur.id);
          open.push({ id: li, f: ng + h(li) });
        }
      }
    }
    if (!from.has(goal) && start !== goal) return [start];
    const path: number[] = [goal];
    let c = goal;
    while (from.has(c)) { c = from.get(c)!; path.push(c); }
    path.reverse();
    return path;
  }

  randomRoadPoint(district: string): { x: number; z: number; yaw: number } {
    const d = DISTRICTS[district as keyof typeof DISTRICTS];
    const inBounds = (x: number, z: number) => {
      if (!d) return true;
      return Math.abs(x - d.cx) < d.size / 2 - 20 && Math.abs(z - d.cz) < d.size / 2 - 20;
    };
    const segs = this.roads.filter(s => s.district === district && inBounds((s.ax + s.bx) / 2, (s.az + s.bz) / 2));
    const pool = segs.length ? segs : this.roads.filter(s => s.district === district);
    const s = pool[Math.floor(this.rng() * pool.length)] || this.roads[0];
    for (let tries = 0; tries < 12; tries++) {
      const t = 0.2 + this.rng() * 0.6;
      const x = s.ax + (s.bx - s.ax) * t, z = s.az + (s.bz - s.az) * t;
      if (inBounds(x, z)) return { x, z, yaw: Math.atan2(s.dx, s.dz) };
    }
    return { x: s.ax + (s.bx - s.ax) * 0.5, z: s.az + (s.bz - s.az) * 0.5, yaw: Math.atan2(s.dx, s.dz) };
  }

  /* ---------------- collision ---------------- */

  collideCircle(px: number, pz: number, radius: number): { pushX: number; pushZ: number; hitObj: WorldObject | null; nx: number; nz: number } {
    let pushX = 0, pushZ = 0, hitObj: WorldObject | null = null, bnx = 0, bnz = 0;
    const c0 = this.cellIdx(px - radius - 4, pz - radius - 4);
    const cells: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const cx = Math.floor(px / WORLD.gridCell + GRID_HALF) + dx;
      const cz = Math.floor(pz / WORLD.gridCell + GRID_HALF) + dz;
      if (cx >= 0 && cz >= 0 && cx < GRID_N && cz < GRID_N) cells.push(cz * GRID_N + cx);
    }
    void c0;
    const testObj = (o: WorldObject) => {
      if (o.collR <= 0) return;
      const dx = px - o.x, dz = pz - o.z;
      const rr = radius + o.collR;
      const d2 = dx * dx + dz * dz;
      if (d2 > rr * rr || d2 < 1e-9) return;
      const d = Math.sqrt(d2);
      const pen = rr - d;
      const nx = dx / d, nz = dz / d;
      pushX += nx * pen; pushZ += nz * pen;
      hitObj = o; bnx = nx; bnz = nz;
    };
    for (const cell of cells) {
      let id = this.staticHeads[cell];
      while (id !== -1) { testObj(this.objects[id]); id = this.objNext[id]; }
      id = this.dynHeads[cell];
      while (id !== -1) { testObj(this.objects[id]); id = this.objNext[id]; }
    }
    return { pushX, pushZ, hitObj, nx: bnx, nz: bnz };
  }

  get elapsedTime(): number { return this.time; }
}

/* discoverable landmarks: scan near them to log research data */
export interface POI {
  id: string; name: string; x: number; z: number; r: number; region: string;
  reward: { cr: number; rd: number; xp: number };
}

export const POIS: POI[] = [
  { id: 'poi-tower',    name: 'CONTROL TOWER',    x: -700, z: -700, r: 42, region: 'facility',     reward: { cr: 60, rd: 8, xp: 10 } },
  { id: 'poi-pylons',   name: 'SENSOR PYLONS',    x: -470, z: -700, r: 40, region: 'facility',     reward: { cr: 50, rd: 6, xp: 8 } },
  { id: 'poi-towers',   name: 'THE TWIN TOWERS',  x: 396,  z: 296,  r: 38, region: 'city',         reward: { cr: 110, rd: 14, xp: 18 } },
  { id: 'poi-park',     name: 'CITY ORCHARD',     x: 258,  z: 434,  r: 36, region: 'city',         reward: { cr: 70, rd: 9, xp: 12 } },
  { id: 'poi-gantry',   name: 'GATEWAY GANTRY',   x: 230,  z: -1026, r: 46, region: 'highway',     reward: { cr: 120, rd: 16, xp: 20 } },
  { id: 'poi-yard',     name: 'CONTAINER YARD',   x: 1150, z: 500,  r: 48, region: 'industrial',   reward: { cr: 130, rd: 18, xp: 22 } },
  { id: 'poi-silos',    name: 'SILO ROW',         x: 860,  z: 394,  r: 30, region: 'industrial',   reward: { cr: 90, rd: 12, xp: 15 } },
  { id: 'poi-tunnel',   name: 'MOUNTAIN TUNNEL',  x: -1070, z: 170, r: 42, region: 'mountain',     reward: { cr: 140, rd: 20, xp: 24 } },
  { id: 'poi-overlook', name: 'WEST OVERLOOK',    x: -840, z: 520,  r: 38, region: 'mountain',     reward: { cr: 120, rd: 16, xp: 20 } },
  { id: 'poi-spire',    name: 'THE SPIRE',        x: 950,  z: -620, r: 52, region: 'experimental', reward: { cr: 200, rd: 30, xp: 35 } }
];
