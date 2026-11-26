/* PERCEPTION - mission and challenge system (6 chapters, 18 missions) */

import { Vehicle } from './vehicle';
import { PerceptionEngine, ObjClass } from './perception';
import { World } from './world';
import { AutonomyDriver } from './autonomy';
import { LidarSystem } from './lidar';
import { Profile } from './save';
import { ratingFromScore, ratingMultiplier } from './economy';

export interface ObjectiveDef {
  type: 'reach' | 'detections' | 'scanMarker' | 'park' | 'speedAbove' | 'modeUse';
  label: string;
  x?: number; z?: number; r?: number;
  cls?: ObjClass; count?: number; maxDist?: number;
  seconds?: number;
  yawTol?: number;
  speed?: number;
  mode?: number;
}

export interface ConstraintDef {
  type: 'maxCollisions' | 'maxInterventions';
  n?: number;
}

export interface MissionDef {
  id: string;
  chapter: number;
  name: string;
  region: string;
  brief: string;
  weather: string;
  timeLimit: number;
  parTime: number;
  spawn: { x: number; z: number; yaw: number };
  objectives: ObjectiveDef[];
  constraints?: ConstraintDef[];
  rewards: { cr: number; rd: number; xp: number };
  requireSensorTier?: number;
  dynamicEvents?: boolean;
}

/* interstate coordinates: carriageway A (northbound) runs at x=-9, B (southbound) at x=+9;
   lanes at ±1.75/5.25/8.75 from each centerline. U-turn loops at z=±1500. */
export const MISSIONS: MissionDef[] = [
  /* ---------------- CHAPTER 1 - FIRST CONTACT ---------------- */
  {
    id: 'c1m1', chapter: 1, name: 'SENSOR AWAKENING', region: 'facility', weather: 'clear',
    brief: 'Activate the LiDAR and learn to read the point cloud. Complete scan cycles, identify traffic, follow the marked lane.',
    timeLimit: 0, parTime: 120,
    spawn: { x: -10.75, z: -1470, yaw: 0 },
    objectives: [
      { type: 'scanMarker', x: -10.75, z: -1400, r: 26, seconds: 6, label: 'Hold position and complete scan cycles' },
      { type: 'detections', cls: 'vehicle', count: 2, label: 'Detect 2 vehicles (parked row + traffic)' },
      { type: 'reach', x: -10.75, z: -1250, r: 14, label: 'Follow the lane to the cone gate' },
      { type: 'detections', cls: 'vehicle', count: 4, label: 'Detect 4 vehicles' }
    ],
    rewards: { cr: 200, rd: 25, xp: 50 }
  },
  {
    id: 'c1m2', chapter: 1, name: 'TESTING GROUND', region: 'facility', weather: 'clear',
    brief: 'Slalom the shoulder cone course south of the gate. Fixed obstacles only - keep the bodywork clean.',
    timeLimit: 150, parTime: 75,
    spawn: { x: -14.25, z: -1470, yaw: 0 },
    objectives: [
      { type: 'reach', x: -21.4, z: -1440, r: 10, label: 'Slalom marker 1' },
      { type: 'reach', x: -24.6, z: -1376, r: 10, label: 'Slalom marker 2' },
      { type: 'reach', x: -21.4, z: -1312, r: 10, label: 'Slalom marker 3' },
      { type: 'reach', x: -24.6, z: -1248, r: 12, label: 'Course exit' }
    ],
    constraints: [{ type: 'maxCollisions', n: 3 }],
    rewards: { cr: 300, rd: 35, xp: 70 }
  },
  {
    id: 'c1m3', chapter: 1, name: 'PRECISION PARKING', region: 'facility', weather: 'clear',
    brief: 'Ease into the marked shoulder bay using point-cloud perception alone. Slow, precise, within the lines.',
    timeLimit: 180, parTime: 90,
    spawn: { x: -14.25, z: -1020, yaw: 0 },
    objectives: [
      { type: 'park', x: -23, z: -950, r: 3.2, yawTol: 0.5, label: 'Park in the shoulder bay (aligned N-S)' }
    ],
    constraints: [{ type: 'maxCollisions', n: 2 }],
    rewards: { cr: 350, rd: 40, xp: 80 }
  },
  /* ---------------- CHAPTER 2 - LEARNING TO PERCEIVE ---------------- */
  {
    id: 'c2m1', chapter: 2, name: 'KNOW YOUR WORLD', region: 'facility', weather: 'clear',
    brief: 'The recognizer is online. Classify vehicles, roadside trees and overhead signs along the interstate.',
    timeLimit: 0, parTime: 150,
    spawn: { x: -10.75, z: -1470, yaw: 0 },
    objectives: [
      { type: 'detections', cls: 'vehicle', count: 5, label: 'Classify 5 vehicles' },
      { type: 'detections', cls: 'tree', count: 3, label: 'Classify 3 trees' },
      { type: 'detections', cls: 'sign', count: 2, label: 'Classify 2 signs (gantries)' }
    ],
    rewards: { cr: 400, rd: 55, xp: 100 }
  },
  {
    id: 'c2m2', chapter: 2, name: 'MOVING HAZARDS', region: 'facility', weather: 'clear',
    brief: 'The test sector is live with traffic. Weave between the waypoints without contact.',
    timeLimit: 150, parTime: 80,
    spawn: { x: -10.75, z: -1440, yaw: 0 },
    objectives: [
      { type: 'reach', x: -14.25, z: -1330, r: 12, label: 'Waypoint A' },
      { type: 'reach', x: -10.75, z: -1120, r: 12, label: 'Waypoint B' },
      { type: 'reach', x: -14.25, z: -940, r: 12, label: 'Waypoint C' }
    ],
    constraints: [{ type: 'maxCollisions', n: 1 }],
    rewards: { cr: 450, rd: 55, xp: 110 }
  },
  {
    id: 'c2m3', chapter: 2, name: 'INTERSTATE ENTRY', region: 'city', weather: 'clear',
    brief: 'First run in live traffic. Hold your lane through three sector gates without a collision.',
    timeLimit: 240, parTime: 120,
    spawn: { x: -10.75, z: -1080, yaw: 0 },
    objectives: [
      { type: 'reach', x: -10.75, z: -900, r: 12, label: 'Sector gate 1' },
      { type: 'reach', x: -14.25, z: -720, r: 12, label: 'Sector gate 2' },
      { type: 'reach', x: -10.75, z: -560, r: 12, label: 'Sector gate 3' },
      { type: 'reach', x: -14.25, z: -450, r: 12, label: 'Meridian exit' }
    ],
    constraints: [{ type: 'maxCollisions', n: 1 }],
    rewards: { cr: 500, rd: 60, xp: 120 }
  },
  /* ---------------- CHAPTER 3 - INTERSTATE NAVIGATION ---------------- */
  {
    id: 'c3m1', chapter: 3, name: 'CORRIDOR RUN', region: 'city', weather: 'clear',
    brief: 'Timed run up the Meridian corridor. Traffic is steady - precision matters more than speed.',
    timeLimit: 200, parTime: 110,
    spawn: { x: -14.25, z: -1060, yaw: 0 },
    objectives: [
      { type: 'reach', x: -14.25, z: -880, r: 11, label: 'Checkpoint 1' },
      { type: 'reach', x: -10.75, z: -700, r: 11, label: 'Checkpoint 2' },
      { type: 'reach', x: -14.25, z: -560, r: 11, label: 'Checkpoint 3' },
      { type: 'reach', x: -10.75, z: -420, r: 13, label: 'Meridian exit' }
    ],
    constraints: [{ type: 'maxCollisions', n: 2 }],
    rewards: { cr: 600, rd: 65, xp: 140 }
  },
  {
    id: 'c3m2', chapter: 3, name: 'RUSH HOUR', region: 'city', weather: 'clear',
    brief: 'Full traffic density on the interstate. Keep safe distances and read moving returns early.',
    timeLimit: 260, parTime: 150,
    spawn: { x: -10.75, z: -1080, yaw: 0 },
    objectives: [
      { type: 'reach', x: -14.25, z: -940, r: 11, label: 'Checkpoint 1' },
      { type: 'reach', x: -14.25, z: -760, r: 11, label: 'Checkpoint 2' },
      { type: 'reach', x: -10.75, z: -600, r: 11, label: 'Checkpoint 3' },
      { type: 'reach', x: -10.75, z: -450, r: 13, label: 'Destination' }
    ],
    constraints: [{ type: 'maxCollisions', n: 1 }],
    rewards: { cr: 650, rd: 70, xp: 150 }
  },
  {
    id: 'c3m3', chapter: 3, name: 'AFTER DARK', region: 'city', weather: 'clear',
    brief: 'Night run. LiDAR does not need light - but the interstate feels different after dark.',
    timeLimit: 260, parTime: 150,
    spawn: { x: -14.25, z: -460, yaw: 0 },
    objectives: [
      { type: 'reach', x: -10.75, z: -300, r: 11, label: 'Checkpoint 1' },
      { type: 'reach', x: -14.25, z: -140, r: 11, label: 'Checkpoint 2' },
      { type: 'reach', x: -10.75, z: 20, r: 11, label: 'Checkpoint 3' },
      { type: 'reach', x: -14.25, z: 160, r: 13, label: 'Core exit' }
    ],
    rewards: { cr: 650, rd: 70, xp: 150 }
  },
  /* ---------------- CHAPTER 4 - HIGH-SPEED PERCEPTION ---------------- */
  {
    id: 'c4m1', chapter: 4, name: 'MERGE AND FLOW', region: 'highway', weather: 'clear',
    brief: 'Build speed on the interstate, hold your following distance and flow with the traffic.',
    timeLimit: 240, parTime: 140,
    spawn: { x: -14.25, z: -540, yaw: 0 },
    objectives: [
      { type: 'reach', x: -10.75, z: -300, r: 16, label: 'Merge into the flow' },
      { type: 'speedAbove', speed: 23, seconds: 20, label: 'Hold 23+ m/s for 20s' },
      { type: 'reach', x: -14.25, z: 200, r: 18, label: 'Exit at the core' }
    ],
    constraints: [{ type: 'maxCollisions', n: 1 }],
    rewards: { cr: 750, rd: 80, xp: 180 }
  },
  {
    id: 'c4m2', chapter: 4, name: 'FAR HORIZON', region: 'highway', weather: 'clear',
    brief: 'Long-range calibration. Detect traffic far ahead - upgrade sensor range first.',
    timeLimit: 260, parTime: 150,
    spawn: { x: -10.75, z: -540, yaw: 0 },
    objectives: [
      { type: 'detections', cls: 'vehicle', count: 6, label: 'Detect 6 moving vehicles' },
      { type: 'detections', cls: 'truck', count: 2, label: 'Classify 2 trucks' },
      { type: 'reach', x: -14.25, z: 260, r: 18, label: 'Complete the run north' }
    ],
    requireSensorTier: 3,
    rewards: { cr: 800, rd: 85, xp: 190 }
  },
  {
    id: 'c4m3', chapter: 4, name: 'SUDDEN OBSTACLE', region: 'highway', weather: 'clear',
    brief: 'Debris events will drop obstacles onto the lanes. Read them early, thread through cleanly.',
    timeLimit: 220, parTime: 130,
    spawn: { x: -14.25, z: -500, yaw: 0 },
    objectives: [
      { type: 'reach', x: -10.75, z: -220, r: 16, label: 'Debris zone A exit' },
      { type: 'reach', x: -14.25, z: 60, r: 16, label: 'Debris zone B exit' }
    ],
    constraints: [{ type: 'maxCollisions', n: 2 }],
    dynamicEvents: true,
    rewards: { cr: 850, rd: 90, xp: 200 }
  },
  /* ---------------- CHAPTER 5 - ENVIRONMENTAL CHALLENGES ---------------- */
  {
    id: 'c5m1', chapter: 5, name: 'STORM PROTOCOL', region: 'city', weather: 'heavyrain',
    brief: 'Heavy rain degrades returns. Drive the Meridian corridor with degraded visibility.',
    timeLimit: 280, parTime: 170,
    spawn: { x: -10.75, z: -1080, yaw: 0 },
    objectives: [
      { type: 'reach', x: -14.25, z: -900, r: 11, label: 'Checkpoint 1' },
      { type: 'reach', x: -10.75, z: -720, r: 11, label: 'Checkpoint 2' },
      { type: 'reach', x: -14.25, z: -540, r: 11, label: 'Checkpoint 3' },
      { type: 'reach', x: -10.75, z: -380, r: 13, label: 'Storm layby' }
    ],
    rewards: { cr: 750, rd: 95, xp: 200 }
  },
  {
    id: 'c5m2', chapter: 5, name: 'WHITEOUT', region: 'industrial', weather: 'fog',
    brief: 'Fog on the southbound lanes. Scan three survey markers between the rest stop and the freight yard.',
    timeLimit: 300, parTime: 180,
    spawn: { x: 14.25, z: 160, yaw: Math.PI },
    objectives: [
      { type: 'scanMarker', x: 40, z: 0, r: 24, seconds: 5, label: 'Survey marker 1 (rest stop)' },
      { type: 'scanMarker', x: 23, z: 300, r: 24, seconds: 5, label: 'Survey marker 2 (freight shoulder)' },
      { type: 'scanMarker', x: 23, z: 480, r: 24, seconds: 5, label: 'Survey marker 3' }
    ],
    rewards: { cr: 800, rd: 100, xp: 210 }
  },
  {
    id: 'c5m3', chapter: 5, name: 'RIDGE RUN', region: 'mountain', weather: 'clear',
    brief: 'The Ridge Pass threads hills, rocks and tree walls. Boundary detection is everything.',
    timeLimit: 320, parTime: 200,
    spawn: { x: -10.75, z: 560, yaw: 0 },
    objectives: [
      { type: 'reach', x: -14.25, z: 740, r: 15, label: 'Ridge curves' },
      { type: 'reach', x: -10.75, z: 920, r: 15, label: 'Pass midpoint' },
      { type: 'reach', x: -14.25, z: 1080, r: 16, label: 'Overlook gantry' }
    ],
    constraints: [{ type: 'maxCollisions', n: 2 }],
    rewards: { cr: 850, rd: 105, xp: 220 }
  },
  /* ---------------- CHAPTER 6 - THE AUTONOMOUS FUTURE ---------------- */
  {
    id: 'c6m1', chapter: 6, name: 'HANDS OFF', region: 'city', weather: 'clear',
    brief: 'Engage MODE 3 and let the vehicle drive the interstate route. Intervene only if you must.',
    timeLimit: 300, parTime: 190,
    spawn: { x: -10.75, z: -1080, yaw: 0 },
    objectives: [
      { type: 'modeUse', mode: 3, seconds: 8, label: 'Engage supervised autonomy (MODE 3+)' },
      { type: 'reach', x: -14.25, z: -900, r: 12, label: 'Route checkpoint 1' },
      { type: 'reach', x: -10.75, z: -720, r: 12, label: 'Route checkpoint 2' },
      { type: 'reach', x: -10.75, z: -540, r: 13, label: 'Route destination' }
    ],
    constraints: [{ type: 'maxInterventions', n: 3 }],
    requireSensorTier: 3,
    rewards: { cr: 900, rd: 120, xp: 250 }
  },
  {
    id: 'c6m2', chapter: 6, name: 'FREIGHT RUNNER', region: 'industrial', weather: 'clear',
    brief: 'Autonomous run through the freight sector. Containers and silos crowd the corridor.',
    timeLimit: 320, parTime: 210,
    spawn: { x: -14.25, z: 60, yaw: 0 },
    objectives: [
      { type: 'reach', x: -10.75, z: 220, r: 14, label: 'Yard gate' },
      { type: 'reach', x: -14.25, z: 380, r: 14, label: 'Container row' },
      { type: 'reach', x: -10.75, z: 540, r: 14, label: 'Machinery corner' },
      { type: 'reach', x: -14.25, z: 620, r: 15, label: 'Loading dock' }
    ],
    requireSensorTier: 4,
    rewards: { cr: 950, rd: 125, xp: 260 }
  },
  {
    id: 'c6m3', chapter: 6, name: 'THE PERCEPTION TRIAL', region: 'experimental', weather: 'clear',
    brief: 'Final exam. Low-reflectivity monoliths, unpredictable obstacles, everything you have learned.',
    timeLimit: 360, parTime: 240,
    spawn: { x: -10.75, z: 1100, yaw: 0 },
    objectives: [
      { type: 'scanMarker', x: -10.75, z: 1200, r: 24, seconds: 6, label: 'Calibrate at the doppler tower' },
      { type: 'reach', x: -14.25, z: 1330, r: 14, label: 'Monolith field A' },
      { type: 'reach', x: -10.75, z: 1470, r: 14, label: 'Monolith field B' },
      { type: 'reach', x: -14.25, z: 1300, r: 14, label: 'Return south' }
    ],
    requireSensorTier: 5,
    dynamicEvents: true,
    rewards: { cr: 1200, rd: 160, xp: 320 }
  }
];

export type MissionState = 'idle' | 'active' | 'success' | 'failed';

export interface MissionResult {
  success: boolean;
  reason: string;
  score: number;
  rating: string;
  time: number;
  collisions: number;
  interventions: number;
  rewards: { cr: number; rd: number; xp: number };
  repeat: boolean;
}

export class MissionRunner {
  def: MissionDef | null = null;
  state: MissionState = 'idle';
  objIdx = 0;
  elapsed = 0;
  holdTimer = 0;
  collisions = 0;
  interventionsAtStart = 0;
  modeSeconds = 0;
  speedSeconds = 0;
  failReason = '';
  result: MissionResult | null = null;
  onComplete: ((r: MissionResult) => void) | null = null;
  onFail: ((r: MissionResult) => void) | null = null;

  start(def: MissionDef, autonomy: AutonomyDriver) {
    this.def = def;
    this.state = 'active';
    this.objIdx = 0;
    this.elapsed = 0;
    this.holdTimer = 0;
    this.collisions = 0;
    this.modeSeconds = 0;
    this.speedSeconds = 0;
    this.failReason = '';
    this.result = null;
    this.interventionsAtStart = autonomy.interventions;
  }

  currentObjective(): ObjectiveDef | null {
    if (!this.def || this.state !== 'active') return null;
    return this.def.objectives[this.objIdx] ?? null;
  }

  notifyCollision(severity: number) {
    if (this.state !== 'active') return;
    if (severity > 0.06) this.collisions++;
  }

  update(dt: number, ctx: {
    vehicle: Vehicle; perception: PerceptionEngine; world: World; autonomy: AutonomyDriver;
    lidar: LidarSystem; profile: Profile; weather: string;
  }) {
    if (this.state !== 'active' || !this.def) return;
    this.elapsed += dt;
    const def = this.def;
    const v = ctx.vehicle;
    const vx = v.pos.x, vz = v.pos.z;

    if (v.damage >= 1) return this.fail('VEHICLE DISABLED - DAMAGE CRITICAL');
    if (v.battery <= 0) return this.fail('BATTERY DEPLETED');
    if (def.timeLimit > 0 && this.elapsed > def.timeLimit) return this.fail('TIME EXPIRED');
    for (const c of def.constraints ?? []) {
      if (c.type === 'maxCollisions' && this.collisions > (c.n ?? 0)) return this.fail('TOO MANY COLLISIONS');
      if (c.type === 'maxInterventions' && (ctx.autonomy.interventions - this.interventionsAtStart) > (c.n ?? 0)) return this.fail('TOO MANY INTERVENTIONS');
    }

    const obj = this.currentObjective();
    if (!obj) return this.complete();
    let done = false;

    switch (obj.type) {
      case 'reach': {
        const d = Math.hypot((obj.x ?? 0) - vx, (obj.z ?? 0) - vz);
        done = d < (obj.r ?? 12) && Math.abs(v.forwardSpeed()) < 12;
        break;
      }
      case 'detections': {
        let n = 0;
        for (const t of ctx.perception.tracks.values()) {
          if (t.cls !== obj.cls || t.confidence < 0.6) continue;
          n++;
        }
        done = n >= (obj.count ?? 1);
        break;
      }
      case 'scanMarker': {
        const d = Math.hypot((obj.x ?? 0) - vx, (obj.z ?? 0) - vz);
        const scanning = d < (obj.r ?? 20) && ctx.lidar.cycleCount > 0;
        if (scanning) this.holdTimer += dt; else this.holdTimer = Math.max(0, this.holdTimer - dt * 2);
        done = this.holdTimer >= (obj.seconds ?? 5);
        break;
      }
      case 'park': {
        const d = Math.hypot((obj.x ?? 0) - vx, (obj.z ?? 0) - vz);
        const tol = obj.yawTol ?? 0.4;
        /* bays run north-south: accept 0 or PI heading */
        let dYaw = Math.abs(v.yaw % Math.PI);
        if (dYaw > Math.PI / 2) dYaw = Math.PI - dYaw;
        const aligned = dYaw < tol;
        const slow = Math.abs(v.forwardSpeed()) < 0.6;
        if (d < (obj.r ?? 3) && aligned && slow) this.holdTimer += dt;
        else this.holdTimer = Math.max(0, this.holdTimer - dt);
        done = this.holdTimer >= 2.0;
        break;
      }
      case 'speedAbove': {
        if (Math.abs(v.forwardSpeed()) >= (obj.speed ?? 20)) this.speedSeconds += dt;
        else this.speedSeconds = Math.max(0, this.speedSeconds - dt * 0.5);
        done = this.speedSeconds >= (obj.seconds ?? 15);
        break;
      }
      case 'modeUse': {
        if (ctx.autonomy.mode >= (obj.mode ?? 3) && ctx.autonomy.active) this.modeSeconds += dt;
        done = this.modeSeconds >= (obj.seconds ?? 5);
        break;
      }
    }

    if (done) {
      this.objIdx++;
      this.holdTimer = 0;
      if (this.objIdx >= def.objectives.length) this.complete();
    }
  }

  private complete() {
    if (!this.def) return;
    const def = this.def;
    const timeScore = def.parTime > 0 ? Math.max(0, Math.min(1, def.parTime / Math.max(1, this.elapsed))) * 100 : 80;
    const safetyScore = Math.max(0, 100 - this.collisions * 22);
    const score = Math.round(safetyScore * 0.55 + timeScore * 0.45);
    const rating = ratingFromScore(score);
    const mul = ratingMultiplier(rating);
    this.state = 'success';
    this.result = {
      success: true, reason: 'MISSION COMPLETE', score, rating, time: this.elapsed,
      collisions: this.collisions, interventions: 0,
      rewards: { cr: Math.round(def.rewards.cr * mul), rd: Math.round(def.rewards.rd * mul), xp: Math.round(def.rewards.xp * mul) },
      repeat: false
    };
    if (this.onComplete) this.onComplete(this.result);
  }

  private fail(reason: string) {
    if (!this.def) return;
    this.failReason = reason;
    this.state = 'failed';
    this.result = { success: false, reason, score: 0, rating: 'C', time: this.elapsed, collisions: this.collisions, interventions: 0, rewards: { cr: 0, rd: 0, xp: 0 }, repeat: false };
    if (this.onFail) this.onFail(this.result);
  }
}

export function missionById(id: string): MissionDef | undefined {
  return MISSIONS.find(m => m.id === id);
}
