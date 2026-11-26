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

/* sectors are north-south bands along the endless interstate (carriageway A runs at x=-9) */
export const DISTRICTS = {
  facility:     { name: 'TEST SECTOR',      cx: -9, cz: -1333, size: 533 },
  city:         { name: 'MERIDIAN SECTOR',  cx: -9, cz: -800,  size: 533 },
  highway:      { name: 'INTERSTATE CORE',  cx: -9, cz: -267,  size: 533 },
  industrial:   { name: 'FREIGHT SECTOR',   cx: -9, cz: 267,   size: 533 },
  mountain:     { name: 'RIDGE PASS',       cx: -9, cz: 800,   size: 533 },
  experimental: { name: 'POLAR GATE',       cx: -9, cz: 1333,  size: 533 }
};

/* sector key for a z coordinate (used to tag road segments) */
export function sectorOfZ(z: number): string {
  if (z < -1067) return 'facility';
  if (z < -533) return 'city';
  if (z < 0) return 'highway';
  if (z < 533) return 'industrial';
  if (z < 1067) return 'mountain';
  return 'experimental';
}

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
    this.roadNext = new Int32Array(262144); /* edge list: (segment, cell) pairs */
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
    /* roadIndex cells store PACKED entries (slot * 4096 + segmentId); roadNext is
       a flat edge list keyed by slot — one entry per (segment, cell) insertion,
       because a long segment lives in many cell lists at once. */
    this.roadIndex.fill(-1);
    let slot = 0;
    for (let si = 0; si < this.roads.length; si++) {
      const s = this.roads[si];
      const pad = s.half + 3;
      const c0 = Math.floor((Math.min(s.ax, s.bx) - pad) / WORLD.gridCell + GRID_HALF);
      const c1 = Math.floor((Math.max(s.ax, s.bx) + pad) / WORLD.gridCell + GRID_HALF);
      const r0 = Math.floor((Math.min(s.az, s.bz) - pad) / WORLD.gridCell + GRID_HALF);
      const r1 = Math.floor((Math.max(s.az, s.bz) + pad) / WORLD.gridCell + GRID_HALF);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        if (c < 0 || r < 0 || c >= GRID_N || r >= GRID_N) continue;
        if (slot >= this.roadNext.length) return; /* edge list full — fail safe */
        const cell = r * GRID_N + c;
        this.roadNext[slot] = this.roadIndex[cell];
        this.roadIndex[cell] = slot * 4096 + si;
        slot++;
      }
    }
  }

  /* iterate the segments indexed in a cell */
  private roadSegsAt(cell: number, fn: (si: number) => void) {
    let entry = this.roadIndex[cell];
    let guard = 0;
    while (entry !== -1 && entry !== undefined && guard++ < 4096) {
      fn(entry & 4095);
      entry = this.roadNext[entry >>> 12];
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
      this.roadSegsAt(cell, (si) => {
        const s = this.roads[si];
        const info = this.distToSeg(s, x, z);
        if (info.d < bestInfo.d) { bestInfo = info; bestSeg = s; }
      });
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
      return MAT.CONCRETE; /* shoulder */
    }
    /* sector ground */
    const district = this.districtAt(x, z);
    switch (district) {
      case 'facility': return MAT.CONCRETE;
      case 'industrial': return MAT.CONCRETE;
      case 'experimental': return MAT.TARMAC_DARK;
      case 'mountain': {
        const n = Math.sin(x * 0.03 + z * 0.021);
        return n > 0.4 ? MAT.DIRT : MAT.GRASS;
      }
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
    /* THE ENDLESS INTERSTATE: two 3-lane one-way carriageways running the full
       north-south span, joined by U-turn loops at both ends — drive forever. */
    const XA = -9, XB = 9;          // carriageway centerlines (median at x=0)
    const Z0 = -1500, Z1 = 1500;
    const SEGS = 8;
    const step = (Z1 - Z0) / SEGS;  // 375 m

    /* northbound carriageway A (travel +z) */
    const aStart = this.addNode(XA, Z0, sectorOfZ(Z0));
    let prevA = aStart;
    for (let i = 1; i <= SEGS; i++) {
      const z = Z0 + step * i;
      const dKey = sectorOfZ(z);
      const nid = this.addNode(XA, z, dKey);
      const nn = this.nodes[nid];
      this.nodes[prevA].links.push(nid); this.nodes[nid].links.push(prevA);
      this.addRoad(this.nodes[prevA].x, this.nodes[prevA].z, nn.x, nn.z, { half: 9, lanes: 3, speed: 33, kind: 'highway', district: dKey, oneway: 1, aNode: prevA, bNode: nid });
      prevA = nid;
    }
    const aEnd = prevA;

    /* southbound carriageway B (travel -z) */
    const bStart = this.addNode(XB, Z1, sectorOfZ(Z1));
    let prevB = bStart;
    for (let i = 1; i <= SEGS; i++) {
      const z = Z1 - step * i;
      const dKey = sectorOfZ(z);
      const nid = this.addNode(XB, z, dKey);
      const nn = this.nodes[nid];
      this.nodes[prevB].links.push(nid); this.nodes[nid].links.push(prevB);
      this.addRoad(this.nodes[prevB].x, this.nodes[prevB].z, nn.x, nn.z, { half: 9, lanes: 3, speed: 33, kind: 'highway', district: dKey, oneway: 1, aNode: prevB, bNode: nid });
      prevB = nid;
    }
    const bEnd = prevB;

    /* U-turn loops — the "endless" part: run out of highway, swing around, run back */
    const nLoopId = this.addNode(0, 1556, 'experimental');
    const nLoop = this.nodes[nLoopId];
    this.nodes[aEnd].links.push(nLoopId); this.nodes[nLoopId].links.push(aEnd);
    this.addRoad(this.nodes[aEnd].x, this.nodes[aEnd].z, nLoop.x, nLoop.z, { half: 6, lanes: 1, speed: 10, kind: 'ramp', district: 'experimental', oneway: 1, aNode: aEnd, bNode: nLoopId });
    this.nodes[nLoopId].links.push(bStart); this.nodes[bStart].links.push(nLoopId);
    this.addRoad(nLoop.x, nLoop.z, this.nodes[bStart].x, this.nodes[bStart].z, { half: 6, lanes: 1, speed: 10, kind: 'ramp', district: 'experimental', oneway: 1, aNode: nLoopId, bNode: bStart });

    const sLoopId = this.addNode(0, -1556, 'facility');
    const sLoop = this.nodes[sLoopId];
    this.nodes[bEnd].links.push(sLoopId); this.nodes[sLoopId].links.push(bEnd);
    this.addRoad(this.nodes[bEnd].x, this.nodes[bEnd].z, sLoop.x, sLoop.z, { half: 6, lanes: 1, speed: 10, kind: 'ramp', district: 'facility', oneway: 1, aNode: bEnd, bNode: sLoopId });
    this.nodes[sLoopId].links.push(aStart); this.nodes[aStart].links.push(sLoopId);
    this.addRoad(sLoop.x, sLoop.z, this.nodes[aStart].x, this.nodes[aStart].z, { half: 6, lanes: 1, speed: 10, kind: 'ramp', district: 'facility', oneway: 1, aNode: sLoopId, bNode: aStart });

    this.indexRoads();
  }

  /* ---------------- districts (props & structures) ---------------- */

  buildDistricts() {
    this.buildNetwork();
    this.buildInterstate();
    this.buildMountain();
    this.buildExperimental();
    this.buildChargePads();
    this.refreshDynamicGrid();
  }

  /* ---------------- the endless interstate ---------------- */

  private buildInterstate() {
    const r = () => this.rng();
    const SHOULDER = 23; // shoulder centerline (road edge at ±18, rail at ±26)

    /* median jersey barrier (impassable) — opens at the polar tower plaza */
    for (let z = -1500; z < 1500; z += 50) {
      if (z >= 1290 && z < 1380) continue;
      this.addBox('barrier', MAT.CONCRETE, 0, 0.55, z + 25, 50, 1.1, 0.6, 0, { collR: 1.6, tags: ['median'] });
    }
    /* guardrails — east side gaps at the rest stop */
    for (let z = -1500; z < 1500; z += 50) {
      if (!(z >= -60 && z < 60)) this.addBox('barrier', MAT.METAL, 26, 1.0, z + 25, 50, 1.4, 0.4, 0, { collR: 1.6, tags: ['guardrail'] });
      this.addBox('barrier', MAT.METAL, -26, 1.0, z + 25, 50, 1.4, 0.4, 0, { collR: 1.6, tags: ['guardrail'] });
    }
    /* light poles, alternating flanks */
    for (let z = -1475; z <= 1475; z += 100) {
      const side = (Math.floor((z + 1500) / 100) % 2 === 0) ? -1 : 1;
      const px = side * 24.5;
      this.addCylinder('pole', MAT.METAL, px, 0, z, 0.35, 11, { collR: 0.8 });
      this.addBox('prop', MAT.METAL, px - side * 1.4, 11.1, z, 3.2, 0.3, 0.7, 0, { collR: 0 });
    }
    /* gantry sign gantries every 500 m */
    for (const gz of [-1250, -750, -250, 250, 750, 1250]) {
      this.addCylinder('pole', MAT.METAL, -27, 0, gz, 0.6, 9, { collR: 1 });
      this.addCylinder('pole', MAT.METAL, 27, 0, gz, 0.6, 9, { collR: 1 });
      this.addBox('prop', MAT.METAL, 0, 8.9, gz, 56, 0.5, 0.6, 0, { collR: 0 });
      this.addBox('sign', MAT.SIGN, gz > 0 ? -9 : 9, 8.2, gz, 14, 3.2, 0.4, 0, { collR: 0, tags: ['gantry'] });
    }

    /* ---- TEST SECTOR (south end): slalom, parked row, parking bay, pylons ---- */
    for (let i = 0; i < 10; i++) {
      this.addCone('cone', MAT.BARRIER, SHOULDER + (i % 2 === 0 ? 1.6 : -1.6), 0, -1440 + i * 32, 0.55, 1.0, { tags: ['course-cone'] });
    }
    for (let i = 0; i < 5; i++) this.makeParkedCar(SHOULDER, -1100 + i * 26, 0, ['parked-row']);
    /* parking bay paint (north-south aligned) */
    this.addBox('prop', MAT.PAINT, SHOULDER, 0.02, -950, 0.4, 0.05, 12, 0, { collR: 0 });
    this.addBox('prop', MAT.PAINT, SHOULDER - 3.5, 0.02, -950, 0.4, 0.05, 12, 0, { collR: 0 });
    this.addBox('prop', MAT.PAINT, SHOULDER + 3.5, 0.02, -950, 0.4, 0.05, 12, 0, { collR: 0 });
    this.addBox('prop', MAT.PAINT, SHOULDER, 0.02, -944, 7.4, 0.05, 0.4, 0, { collR: 0 });
    this.addBox('prop', MAT.PAINT, SHOULDER, 0.02, -956, 7.4, 0.05, 0.4, 0, { collR: 0 });
    /* sensor test pylons (east shoulder) */
    for (const d of [-1450, -1250, -1050]) {
      this.addCylinder('pole', MAT.METAL, 23, 0, d, 0.6, 4.2, { tags: ['pylon'] });
      this.addSphere('sign', MAT.SIGN, 23, 4.6, d, 1.2, { tags: ['pylon'] });
    }
    /* control shed (west shoulder, south end) */
    this.addBox('building', MAT.BUILDING, -23, 2.5, -1560, 8, 5, 12, 0, { tags: ['shed'] });

    /* ---- REST STOP (east side, z≈0) ---- */
    this.addBox('prop', MAT.PAINT, 40, 0.02, 0, 40, 0.05, 80, 0, { collR: 0, tags: ['rest-apron'] });
    this.addBox('building', MAT.BUILDING, 44, 3, -28, 12, 6, 10, 0, { tags: ['rest-shed'] });
    /* fuel canopy */
    for (const fz of [16, 30]) {
      this.addCylinder('pole', MAT.METAL, 34, 0, fz, 0.4, 5.5, { collR: 0.9 });
      this.addCylinder('pole', MAT.METAL, 46, 0, fz, 0.4, 5.5, { collR: 0.9 });
    }
    this.addBox('prop', MAT.METAL, 40, 5.7, 23, 16, 0.5, 18, 0, { collR: 0 });
    this.makeParkedCar(50, -10, Math.PI / 2);
    this.makeParkedCar(50, 44, Math.PI / 2);

    /* ---- FREIGHT SECTOR: container stacks + warehouses beyond the rails ---- */
    for (let i = 0; i < 24; i++) {
      const x = (i % 2 === 0 ? 1 : -1) * (42 + (Math.floor(i / 2) % 3) * 12);
      const z = 80 + Math.floor(i / 6) * 90 + (i % 6) * 13;
      const rows = 1 + Math.floor(r() * 3);
      for (let k = 0; k < rows; k++) {
        this.addBox('obstacle', MAT.METAL, x, 1.35 + k * 2.7, z, 12.2, 2.6, 2.6, (r() - 0.5) * 0.1, { tags: ['container'] });
      }
    }
    this.addBox('building', MAT.METAL, 64, 7, 330, 44, 14, 30, 0, { tags: ['warehouse'] });
    this.addCylinder('prop', MAT.METAL, 84, 0, 300, 2.2, 9, { tags: ['silo'] });
    this.addCylinder('prop', MAT.METAL, 90, 0, 300, 2.2, 9, { tags: ['silo'] });

    /* ---- RIDGE PASS: hills, rocks, trees (kept clear of the corridor) ---- */
    for (let i = 0; i < 16; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      this.addCone('building', MAT.GRASS, side * (120 + r() * 90), 0, 560 + (i / 16) * 520, 60 + r() * 30, 40 + r() * 50, { collR: 0, tags: ['hill'] });
    }
    for (let i = 0; i < 26; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const x = side * (30 + r() * 26);
      const z = 560 + r() * 500;
      if (r() < 0.6) this.makeTree(x, z);
      else this.addSphere('rock', MAT.ROCK, x, 0.4, z, 0.9 + r() * 2.0, { collR: 1.8, tags: ['boulder'] });
    }

    /* ---- POLAR GATE: dark monoliths + doppler tower on an opened median ---- */
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const d = 45 + r() * 80;
      const h = 8 + r() * 22;
      this.addBox('building', MAT.DARK, side * (26 + d), h / 2, 1100 + (i / 14) * 480, 6 + r() * 14, h, 6 + r() * 14, r() * Math.PI, { tags: ['monolith'] });
    }
    this.addBox('prop', MAT.CONCRETE, 0, 0.02, 1333, 10, 0.05, 90, 0, { collR: 0 });
    this.addCylinder('building', MAT.DARK, 0, 0, 1333, 5, 46, { tags: ['tower'], collR: 5 });
    this.addSphere('building', MAT.DARK, 0, 48, 1333, 4, { tags: ['tower'], collR: 0 });

    /* ---- tree rows along both flanks ---- */
    for (let i = 0; i < 90; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const x = side * (33 + r() * 14);
      const z = -1580 + r() * 3140;
      if (side === 1 && Math.abs(z) < 70) continue; /* keep the rest stop clear */
      this.makeTree(x, z);
    }
  }

  private makeParkedCar(x: number, z: number, yaw: number, tags: string[] = []) {
    const g = 'park-' + x.toFixed(0) + '-' + z.toFixed(0);
    this.addBox('vehicle', MAT.VEHICLE, x, 0.75, z, 1.9, 1.0, 4.5, yaw, { group: g, collR: 2.4, tags });
    this.addBox('vehicle', MAT.GLASS, x, 1.55, z, 1.7, 0.7, 2.3, yaw, { group: g, collR: 0 });
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

  private buildMountain() {
    /* replaced by buildInterstate — kept as no-op for compatibility */
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
    this.addChargePad(-23, -1500, 0);           /* test sector shoulder */
    this.addChargePad(44, 0, Math.PI / 2);      /* rest stop apron */
    this.addChargePad(23, 300, 0);              /* freight shoulder */
    this.addChargePad(23, 810, 0);              /* ridge shoulder */
    this.addChargePad(23, 1300, 0);             /* polar gate shoulder */
  }

  private buildExperimental() {
    /* replaced by buildInterstate — kept as no-op for compatibility */
  }

  /* ---------------- traffic & pedestrians ---------------- */

  spawnTraffic(count: number, peds: number) {
    const drivable = this.roads.filter(s => s.kind === 'street' || s.kind === 'avenue' || s.kind === 'highway' || s.kind === 'rural');
    for (let i = 0; i < count; i++) {
      const seg = drivable[Math.floor(this.rng() * drivable.length)];
      const dir: 1 | 2 = seg.oneway === 1 ? 1 : seg.oneway === 2 ? 2 : (this.rng() < 0.5 ? 1 : 2);
      const isHighway = seg.kind === 'highway';
      const truck = isHighway && this.rng() < 0.38;
      /* 3-lane discipline: lanes at 1.75 / 5.25 / 8.75 from the centerline (clamped to narrow ramps) */
      const lane = Math.min([1.75, 5.25, 8.75][Math.floor(this.rng() * 3)], Math.max(1.75, seg.half - 1.75));
      const lateral = lane * (this.rng() < 0.5 ? -1 : 1) * (dir === 1 ? 1 : -1);
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
        lateral, speed: 0, targetSpeed: truck ? 20 + this.rng() * 6 : (isHighway ? 24 + this.rng() * 9 : 7 + this.rng() * 5),
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
          /* match the new segment's pace (slow on the U-turn loops) */
          const isTruck = a.kind === 'truck';
          a.targetSpeed = s2.kind === 'ramp' ? 8 + this.rng() * 3
            : isTruck ? 20 + this.rng() * 6 : 24 + this.rng() * 9;
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
  { id: 'poi-sloop',    name: 'SOUTH LOOP GATE',  x: 0,    z: -1520, r: 44, region: 'facility',     reward: { cr: 60, rd: 8, xp: 10 } },
  { id: 'poi-cones',    name: 'CONE COURSE',      x: -23,  z: -1300, r: 38, region: 'facility',     reward: { cr: 50, rd: 6, xp: 8 } },
  { id: 'poi-pylons',   name: 'RANGE PYLONS',     x: 23,   z: -1250, r: 38, region: 'facility',     reward: { cr: 70, rd: 9, xp: 12 } },
  { id: 'poi-meridian', name: 'MERIDIAN GANTRY',  x: -9,   z: -750,  r: 40, region: 'city',         reward: { cr: 110, rd: 14, xp: 18 } },
  { id: 'poi-rest',     name: 'REST STOP 66',     x: 44,   z: 0,     r: 46, region: 'highway',      reward: { cr: 120, rd: 16, xp: 20 } },
  { id: 'poi-freight',  name: 'FREIGHT YARD',     x: 60,   z: 300,   r: 46, region: 'industrial',   reward: { cr: 130, rd: 18, xp: 22 } },
  { id: 'poi-silos',    name: 'SILO ROW',         x: 86,   z: 300,   r: 34, region: 'industrial',   reward: { cr: 90, rd: 12, xp: 15 } },
  { id: 'poi-ridge',    name: 'RIDGE OVERLOOK',   x: -40,  z: 810,   r: 40, region: 'mountain',     reward: { cr: 120, rd: 16, xp: 20 } },
  { id: 'poi-tower',    name: 'DOPPLER TOWER',    x: 0,    z: 1333,  r: 42, region: 'experimental', reward: { cr: 200, rd: 30, xp: 35 } },
  { id: 'poi-nloop',    name: 'NORTH LOOP GATE',  x: 0,    z: 1520,  r: 44, region: 'experimental', reward: { cr: 140, rd: 20, xp: 24 } }
];
