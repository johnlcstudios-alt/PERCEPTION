/* PERCEPTION - perception engine.
   Consumes delayed cycle snapshots from the LiDAR, groups returns into
   tracked objects, estimates class/confidence/velocity, and derives
   drivable road space from scanned paint and asphalt returns. */

import * as THREE from 'three';
import { BoxLayer, CycleSnapshot } from './lidar';
import { MAT } from './config';
import { World } from './world';

export type ObjClass = 'vehicle' | 'truck' | 'pedestrian' | 'building' | 'tree' | 'sign' | 'pole' | 'light' | 'barrier' | 'cone' | 'rock' | 'obstacle' | 'unknown';

export interface Track {
  id: string;
  cls: ObjClass;
  confidence: number;
  x: number; y: number; z: number;
  hw: number; hh: number; hl: number;
  velX: number; velZ: number;
  dist: number;
  points: number;
  lastSeen: number; firstSeen: number;
  hazard: boolean;
  ttc: number;
  dynamic: boolean;
}

export interface RoadEstimate {
  valid: boolean;
  heading: number;
  lateralOffset: number;
  width: number;
  paintPoints: number;
  asphaltPoints: number;
  confidence: number;
}

const DYNAMIC_CLASSES = new Set(['vehicle', 'truck', 'pedestrian', 'obstacle']);
const HAZARD_CLASSES = new Set(['vehicle', 'truck', 'pedestrian', 'obstacle', 'cone', 'barrier', 'rock']);

export class PerceptionEngine {
  tracks = new Map<string, Track>();
  road: RoadEstimate = { valid: false, heading: 0, lateralOffset: 0, width: 7, paintPoints: 0, asphaltPoints: 0, confidence: 0 };
  boxLayer: BoxLayer;
  detections = 0;         // total confirmed detections (missions/scoring)
  lostWarnings = 0;
  onDetection: ((cls: ObjClass, dist: number) => void) | null = null;
  onLost: ((id: string) => void) | null = null;
  private lastIngestAt = 0;
  recognitionLevel = 0;   // 0..1 from upgrades/research
  private trueClsCache = new Map<string, ObjClass>();

  constructor(private world: World, scene: THREE.Scene) {
    this.boxLayer = new BoxLayer(scene);
  }

  private clsOf(group: string): ObjClass {
    let c = this.trueClsCache.get(group);
    if (!c) {
      const obj = this.world.groupSample(group);
      c = (obj ? obj.cls : 'unknown') as ObjClass;
      this.trueClsCache.set(group, c);
      if (this.trueClsCache.size > 4096) this.trueClsCache.clear();
    }
    return c;
  }

  ingestCalls = 0;
  ingest(snap: CycleSnapshot, now: number, vx: number, vz: number, vyaw: number, range: number) {
    this.ingestCalls++;
    const dt = this.lastIngestAt ? Math.min(1.2, now - this.lastIngestAt) : 0.1;
    this.lastIngestAt = now;
    const seen = new Set<string>();

    for (const agg of snap.objs) {
      const n = agg.n;
      const cx = agg.sx / n, cy = agg.sy / n, cz = agg.sz / n;
      const dist = Math.hypot(cx - snap.sensorX, cz - snap.sensorZ);
      if (dist > range * 1.05) continue;
      /* very sparse far objects are unrecognizable */
      if (n < 2 && dist > 45) continue;
      if (n < 4 && dist > 90) continue;
      seen.add(agg.id);

      let tr = this.tracks.get(agg.id);
      if (!tr) {
        tr = {
          id: agg.id, cls: 'unknown', confidence: 0,
          x: cx, y: cy, z: cz, hw: 0.5, hh: 0.5, hl: 0.5,
          velX: 0, velZ: 0, dist, points: n,
          lastSeen: now, firstSeen: now, hazard: false, ttc: 99, dynamic: false
        };
        this.tracks.set(agg.id, tr);
      }
      /* velocity from center movement */
      if (dt > 0.01 && n >= 6) {
        const nvx = (cx - tr.x) / dt, nvz = (cz - tr.z) / dt;
        if (Math.abs(nvx) < 60 && Math.abs(nvz) < 60) {
          tr.velX = tr.velX * 0.55 + nvx * 0.45;
          tr.velZ = tr.velZ * 0.55 + nvz * 0.45;
        }
      }
      tr.x = cx; tr.y = cy; tr.z = cz;
      tr.hw = Math.max(0.25, (agg.maxX - agg.minX) / 2);
      tr.hh = Math.max(0.35, (agg.maxY - agg.minY) / 2);
      tr.hl = Math.max(0.25, (agg.maxZ - agg.minZ) / 2);
      tr.dist = dist;
      tr.points = n;
      tr.lastSeen = now;

      /* classification with confidence gating */
      const truth = this.clsOf(agg.id);
      const base = 0.46 + 0.5 * Math.min(1, n / 8);
      const distF = 1 - Math.max(0, Math.min(1, (dist - range * 0.4) / (range * 0.6))) * 0.45;
      const recogF = 0.66 + 0.34 * this.recognitionLevel;
      const jitter = (Math.sin(now * 7.3 + agg.id.length * 13.7) + Math.sin(now * 3.1)) * 0.04;
      const conf = Math.max(0, Math.min(0.99, base * distF * recogF + jitter));
      tr.confidence = conf;
      tr.cls = conf >= 0.46 ? truth : 'unknown';
      tr.dynamic = DYNAMIC_CLASSES.has(truth) && conf >= 0.46;

      /* new confirmed detection event */
      if (tr.points >= 5 && conf >= 0.62 && !tr.confirmedOnce) {
        (tr as any).confirmedOnce = true;
        this.detections++;
        if ((tr.cls === 'vehicle' || tr.cls === 'truck' || tr.cls === 'pedestrian') && this.onDetection) {
          this.onDetection(tr.cls, dist);
        }
      }

      /* hazard assessment */
      tr.hazard = false; tr.ttc = 99;
      if (HAZARD_CLASSES.has(tr.cls) && dist < 60) {
        const fdx = tr.x - vx, fdz = tr.z - vz;
        const fwd = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
        const lat = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
        if (fwd > 0.5 && Math.abs(lat) < Math.max(3.2, tr.hw + tr.hl * 0.6 + 2.2)) {
          const speed = Math.hypot(tr.velX, tr.velZ);
          const approaching = (tr.velX * fdx + tr.velZ * fdz) > 0 || speed > 0.5;
          const closing = Math.max(0, (tr.velX * -fdx + tr.velZ * -fdz) / Math.max(1, dist));
          if (approaching && (closing > 0.3 || speed > 0.5)) {
            tr.ttc = closing > 0.2 ? dist / closing : 3.2;
            if (tr.ttc < 3.6 || (tr.cls !== 'pedestrian' && dist < 9 && speed < 0.5)) tr.hazard = true;
          } else if (speed < 0.4 && dist < 8.5) {
            tr.ttc = 2.4; tr.hazard = true;
          }
        }
      }
    }

    /* expire tracks */
    for (const [id, tr] of this.tracks) {
      if (now - tr.lastSeen > 1.6) {
        if (tr.hazard || tr.confidence > 0.7) this.lostWarnings++;
        if (this.onLost) this.onLost(id, tr.cls);
        this.tracks.delete(id);
      }
    }
    void seen;

    this.estimateRoad(snap, vx, vz, vyaw);
  }

  private estimateRoad(snap: CycleSnapshot, vx: number, vz: number, vyaw: number) {
    const sy = Math.sin(vyaw), cy = Math.cos(vyaw);
    let paintN = 0, asphaltN = 0;
    let sumLatPaint = 0, latMin = 1e9, latMax = -1e9;
    let sumFwd = 0, sumFwd2 = 0, sumLat = 0, sumLat2 = 0, sumCross = 0, corridorN = 0;

    const g = snap.ground;
    for (let i = 0; i < g.length; i += 3) {
      const dx = g[i] - vx, dz = g[i + 1] - vz;
      const mat = g[i + 2];
      const fwd = dx * sy + dz * cy;
      const lat = dx * cy - dz * sy;
      if (fwd < 3 || fwd > 58 || Math.abs(lat) > 15) continue;
      if (mat === MAT.PAINT) {
        paintN++;
        sumLatPaint += lat;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
      } else if (mat === MAT.ASPHALT || mat === MAT.TARMAC_DARK) {
        asphaltN++; corridorN++;
        sumFwd += fwd; sumFwd2 += fwd * fwd;
        sumLat += lat; sumLat2 += lat * lat;
        sumCross += fwd * lat;
      }
    }

    const est = this.road;
    est.paintPoints = paintN;
    est.asphaltPoints = asphaltN;

    /* heading from asphalt corridor principal axis */
    if (corridorN >= 14) {
      const mf = sumFwd / corridorN, ml = sumLat / corridorN;
      const vf = sumFwd2 / corridorN - mf * mf;
      const vl = sumLat2 / corridorN - ml * ml;
      const cf = sumCross / corridorN - mf * ml;
      /* principal direction angle within (fwd,lat) frame */
      const ang = 0.5 * Math.atan2(2 * cf, vf - vl);
      /* road direction relative to vehicle yaw: 0 = straight ahead */
      const relAng = ang; // covariance axis vs fwd axis
      est.heading = vyaw + relAng;
      est.width = Math.max(3, Math.min(24, 2.6 * Math.sqrt(Math.max(0.3, vl + 0.2))));
      est.lateralOffset = ml;
      est.valid = true;
      est.confidence = Math.min(0.85, 0.2 + corridorN / 300);
    }
    if (paintN >= 6) {
      /* paint bands give lane edges relative to the vehicle */
      const center = (latMin + latMax) / 2;
      const width = latMax - latMin;
      if (width > 2.2 && width < 18) {
        est.lateralOffset = 0.45 * est.lateralOffset + 0.55 * center;
        est.width = 0.45 * est.width + 0.55 * width;
        est.confidence = Math.min(0.98, est.confidence + 0.3 + paintN / 200);
      }
    }
    if (paintN < 4 && asphaltN < 18) est.valid = false;
  }

  /* bounding boxes for detection / wireframe modes */
  updateBoxes(vizMode: string, vx: number, vz: number, now: number) {
    const show = vizMode === 'objects' || vizMode === 'wireframe';
    this.boxLayer.setVisible(show);
    if (!show) return;
    const boxes: { x: number; y: number; z: number; hw: number; hh: number; hl: number; color: [number, number, number] }[] = [];
    for (const tr of this.tracks.values()) {
      if (tr.confidence < 0.32 || tr.dist > 130) continue;
      const stale = Math.max(0, 1 - (now - tr.lastSeen) / 1.6);
      let color: [number, number, number];
      if (tr.hazard) color = [1, 0.2, 0.25];
      else if (tr.cls === 'vehicle' || tr.cls === 'truck') color = [0.2, 0.85, 1.0];
      else if (tr.cls === 'pedestrian') color = [0.3, 1.0, 0.5];
      else if (tr.cls === 'sign' || tr.cls === 'light' || tr.cls === 'pole') color = [1.0, 0.85, 0.3];
      else if (tr.cls === 'unknown') color = [0.65, 0.65, 0.7];
      else color = [0.5, 0.55, 0.75];
      boxes.push({
        x: tr.x, y: tr.y, z: tr.z,
        hw: Math.min(30, tr.hw + 0.15), hh: Math.min(30, tr.hh + 0.15), hl: Math.min(30, tr.hl + 0.15),
        color: [color[0], color[1] * (0.5 + 0.5 * stale), color[2] * (0.5 + 0.5 * stale)]
      });
      if (boxes.length >= 96) break;
    }
    this.boxLayer.setBoxes(boxes);
  }

  nearestHazard(vx: number, vz: number, vyaw: number, maxDist: number): Track | null {
    let best: Track | null = null;
    for (const tr of this.tracks.values()) {
      if (!tr.hazard && !(tr.dynamic && tr.dist < maxDist)) continue;
      const fdx = tr.x - vx, fdz = tr.z - vz;
      const fwd = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
      const lat = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
      if (fwd > 0.5 && Math.abs(lat) < 3.6 && tr.dist < maxDist) {
        if (!best || tr.ttc < best.ttc) best = tr;
      }
    }
    return best;
  }

  objectsInCorridor(vx: number, vz: number, vyaw: number, fwdMax: number, latMax: number): Track[] {
    const out: Track[] = [];
    for (const tr of this.tracks.values()) {
      const fdx = tr.x - vx, fdz = tr.z - vz;
      const fwd = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
      const lat = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
      if (fwd > 0.5 && fwd < fwdMax && Math.abs(lat) < latMax + tr.hw) out.push(tr);
    }
    return out;
  }

  reset() {
    this.tracks.clear();
    this.road.valid = false;
    this.road.confidence = 0;
  }
}
