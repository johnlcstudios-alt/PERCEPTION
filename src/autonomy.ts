/* PERCEPTION - autonomous driving engine.
   The planner consumes ONLY perception output (tracked objects + road-space
   estimate) plus map routing data. When perception confidence drops, the
   vehicle behaves conservatively - exactly as the GDD requires. */

import { PerceptionEngine } from './perception';
import { Vehicle } from './vehicle';
import { World } from './world';
import { angleDiff, clamp } from './input';

export type AutoStatus =
  | 'STANDBY' | 'AEB READY' | 'AEB ACTIVE' | 'ACC ACTIVE' | 'LANE ASSIST'
  | 'FOLLOWING ROUTE' | 'OBSTACLE - SLOWING' | 'STOPPED - OBSTACLE'
  | 'LOW CONFIDENCE - SLOWING' | 'STOPPED - LOW CONFIDENCE'
  | 'REQUESTING MANUAL INTERVENTION' | 'ROUTE COMPLETE' | 'PARKING ASSIST';

export class AutonomyDriver {
  mode = 0;
  status: AutoStatus = 'STANDBY';
  route: number[] = [];
  routeIdx = 0;
  destination: { x: number; z: number } | null = null;
  active = false;
  interventions = 0;
  aebEvents = 0;
  lowConfTimer = 0;
  stoppedTimer = 0;
  routeComplete = false;
  interventionLatch = 0;
  private cruiseSpeed = 13;
  private steerAssistTimer = 0;

  setMode(m: number) {
    this.mode = m;
    if (m < 3) { this.active = false; this.status = m === 0 ? 'STANDBY' : 'AEB READY'; }
    else if (m >= 3 && this.destination) { this.active = true; this.status = 'FOLLOWING ROUTE'; }
    else { this.active = false; this.status = m >= 3 ? 'STANDBY - NO ROUTE' : 'STANDBY'; }
  }

  setDestination(x: number, z: number, world: World, fromX: number, fromZ: number) {
    this.destination = { x, z };
    this.route = world.findPath(fromX, fromZ, x, z);
    this.routeIdx = 0;
    this.routeComplete = false;
    if (this.mode >= 3) { this.active = true; this.status = 'FOLLOWING ROUTE'; }
  }

  clearRoute() {
    this.destination = null;
    this.route = [];
    this.active = false;
    this.status = this.mode >= 1 ? 'AEB READY' : 'STANDBY';
  }

  /* player hard steering / braking disengages supervised autonomy */
  checkIntervention(steerInput: number, brakeInput: number): boolean {
    if (this.mode >= 3 && this.active) {
      if (Math.abs(steerInput) > 0.3 || brakeInput > 0.6) {
        this.disengage('MANUAL INTERVENTION');
        return true;
      }
    }
    return false;
  }

  disengage(reason: string) {
    this.interventions++;
    this.interventionLatch = 2.5;
    this.active = false;
    this.mode = Math.min(this.mode, 1);
    this.status = reason === 'MANUAL INTERVENTION' ? 'REQUESTING MANUAL INTERVENTION' : this.status;
    this.disengageReason = reason;
  }
  disengageReason = '';

  /* advance route progress */
  private targetPoint(vx: number, vz: number, _vyaw: number, world: World, speed: number): { x: number; z: number; final: boolean } | null {
    if (!this.destination) return null;
    const L = clamp(Math.abs(speed) * 1.15, 7, 30);
    if (this.route.length === 0) return { x: this.destination.x, z: this.destination.z, final: true };
    /* find current route node ahead */
    while (this.routeIdx < this.route.length) {
      const n = world.nodes[this.route[this.routeIdx]];
      const d = Math.hypot(n.x - vx, n.z - vz);
      if (d < 16 && this.routeIdx < this.route.length - 1) this.routeIdx++;
      else break;
    }
    const n = world.nodes[this.route[this.routeIdx]];
    const dx = n.x - vx, dz = n.z - vz;
    const d = Math.hypot(dx, dz);
    if (d < L && this.routeIdx < this.route.length - 1) {
      const n2 = world.nodes[this.route[this.routeIdx + 1]];
      const segLen = Math.hypot(n2.x - n.x, n2.z - n.z) || 1;
      const t = Math.min(1, (L - d) / segLen);
      return { x: n.x + (n2.x - n.x) * t, z: n.z + (n2.z - n.z) * t, final: false };
    }
    if (this.routeIdx >= this.route.length - 1 && Math.hypot(this.destination.x - vx, this.destination.z - vz) < 10) {
      return { x: this.destination.x, z: this.destination.z, final: true };
    }
    return { x: n.x, z: n.z, final: this.routeIdx >= this.route.length - 1 };
  }

  update(dt: number, vehicle: Vehicle, perception: PerceptionEngine, world: World, weather: { id: string }, playerThrottle: number, playerSteer: number): { brake: number; warn: boolean } {
    const vx = vehicle.pos.x, vz = vehicle.pos.z, vyaw = vehicle.yaw;
    const fwd = vehicle.forwardSpeed();
    let brake = 0;
    let warn = false;
    if (this.interventionLatch > 0) this.interventionLatch -= dt;

    /* ---- Mode 1+: AEB ---- */
    if (this.mode >= 1) {
      const hz = perception.nearestHazard(vx, vz, vyaw, Math.max(24, Math.abs(fwd) * 2.2));
      if (hz && hz.ttc < 2.1 && Math.abs(fwd) > 0.8) {
        brake = 1;
        this.status = 'AEB ACTIVE';
        this.aebEvents++;
        warn = true;
      }
    }

    /* ---- Mode 2+: ACC + lane assist ---- */
    if (this.mode === 2 && !this.active) {
      const corridor = perception.objectsInCorridor(vx, vz, vyaw, 45, 2.8);
      let lead = null as null | { d: number; speed: number };
      for (const t of corridor) {
        if (!t.dynamic) continue;
        const fdx = t.x - vx, fdz = t.z - vz;
        const fd = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
        if (!lead || fd < lead.d) lead = { d: fd, speed: Math.hypot(t.velX, t.velZ) };
      }
      if (lead && lead.d < 30) this.status = 'ACC ACTIVE';
      else this.status = 'LANE ASSIST';
    }

    /* ---- Mode 3+: route following ---- */
    if (this.mode >= 3 && this.active && this.interventionLatch <= 0) {
      const tgt = this.targetPoint(vx, vz, vyaw, world, fwd);
      const road = perception.road;
      let vDesired = this.cruiseSpeed * (this.mode >= 4 ? 1.25 : 1.0);

      /* map speed limit for current area */
      const seg = nearestSegment(world, vx, vz);
      if (seg) vDesired = Math.min(vDesired, seg.speed * (this.mode >= 4 ? 1.1 : 0.95));

      /* weather conservatism */
      if (weather.id === 'rain') vDesired = Math.min(vDesired, 18);
      if (weather.id === 'heavyrain' || weather.id === 'fog') vDesired = Math.min(vDesired, 13);
      if (weather.id === 'dust') vDesired = Math.min(vDesired, 11);

      /* road confidence gating - conservative behavior on uncertainty */
      if (!road.valid || road.confidence < 0.15) {
        this.lowConfTimer += dt;
        vDesired = 0;
        this.status = this.lowConfTimer > 4 ? 'REQUESTING MANUAL INTERVENTION' : 'STOPPED - LOW CONFIDENCE';
        warn = true;
      } else if (road.confidence < 0.35) {
        this.lowConfTimer = 0;
        vDesired = Math.min(vDesired, 6.5);
        this.status = 'LOW CONFIDENCE - SLOWING';
      } else {
        this.lowConfTimer = 0;
      }

      /* obstacle response */
      const corridor = perception.objectsInCorridor(vx, vz, vyaw, Math.max(30, Math.abs(fwd) * 2.6), 2.7);
      let nearestD = 1e9;
      let blocking = false;
      for (const t of corridor) {
        if (t.cls === 'building' || t.cls === 'tree' && t.dist > 14) continue;
        const fdx = t.x - vx, fdz = t.z - vz;
        const fd = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
        const lat = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
        const inLane = Math.abs(lat) < (road.valid ? road.width * 0.5 : 3.0);
        if (fd > 0.5 && fd < nearestD && (inLane || t.dynamic)) { nearestD = fd; blocking = inLane || t.dynamic; }
      }
      if (nearestD < 1e8) {
        const safe = 6.5 + Math.abs(fwd) * 0.55;
        if (blocking) {
          const vObs = Math.max(0, (nearestD - safe * 0.55) * 0.75);
          vDesired = Math.min(vDesired, vObs);
          if (nearestD < safe * 0.62) { vDesired = 0; this.status = 'STOPPED - OBSTACLE'; }
          else this.status = 'OBSTACLE - SLOWING';
          /* mode 4+: try to steer around a fully blocked lane */
          if (this.mode >= 4 && nearestD < safe * 0.9 && nearestD > 4) {
            const left = perception.objectsInCorridor(vx, vz, vyaw - 0.55, 26, 2.2).length === 0;
            const right = perception.objectsInCorridor(vx, vz, vyaw + 0.55, 26, 2.2).length === 0;
            if (left || right) {
              vDesired = Math.max(vDesired, 3.5);
              this.avoidBias = left ? -1 : 1;
            } else this.avoidBias = 0;
          } else this.avoidBias = 0;
        }
      } else this.avoidBias = 0;

      /* pedestrians near road -> extra caution */
      for (const t of perception.tracks.values()) {
        if (t.cls !== 'pedestrian') continue;
        const fdx = t.x - vx, fdz = t.z - vz;
        const fd = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
        const lat = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
        if (fd > 0 && fd < 18 && Math.abs(lat) < 6.5) vDesired = Math.min(vDesired, 4.5);
      }

      /* curvature */
      if (tgt) {
        const fdx = tgt.x - vx, fdz = tgt.z - vz;
        const flocal = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
        const llocal = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
        const alpha = Math.atan2(llocal + (this.avoidBias * 3), Math.max(2, flocal));
        vDesired = Math.min(vDesired, clamp(15 / Math.max(0.14, Math.abs(alpha) * 2.6), 3.5, 40));
      }

      /* speed loop */
      const err = vDesired - fwd;
      if (err > 0.4) {
        vehicle.ctrl.throttle = clamp(err * 0.32, 0, 1);
        vehicle.ctrl.brake = 0;
      } else {
        vehicle.ctrl.throttle = 0;
        vehicle.ctrl.brake = clamp(-err * 0.4, 0, 1);
      }
      if (Math.abs(fwd) < 0.25 && vDesired < 0.5) { this.stoppedTimer += dt; } else this.stoppedTimer = 0;

      /* steering: pure pursuit toward adjusted target */
      if (tgt) {
        const fdx = tgt.x - vx, fdz = tgt.z - vz;
        const flocal = fdx * Math.sin(vyaw) + fdz * Math.cos(vyaw);
        let llocal = fdx * Math.cos(vyaw) - fdz * Math.sin(vyaw);
        /* lane center correction: aim along corridor center */
        if (road.valid && !tgt.final) llocal += clamp(road.lateralOffset, -road.width, road.width) * 0.9;
        llocal += this.avoidBias * 3.0;
        const L = Math.max(4, Math.hypot(flocal, llocal));
        const alpha = Math.atan2(llocal, flocal);
        let steer = Math.atan2(2 * vehicle.spec.wheelbase * Math.sin(alpha), L);
        const headingErr = road.valid ? angleDiff(road.heading, vyaw) : 0;
        steer += clamp(headingErr * -0.45, -0.3, 0.3);
        vehicle.ctrl.steer = clamp(steer, -1, 1);
      }

      /* arrival */
      if (tgt && tgt.final && Math.hypot(tgt.x - vx, tgt.z - vz) < 7 && Math.abs(fwd) < 2.5) {
        this.status = 'ROUTE COMPLETE';
        this.routeComplete = true;
        this.active = false;
        vehicle.ctrl.throttle = 0;
        vehicle.ctrl.brake = 1;
        vehicle.ctrl.steer = 0;
      }
    } else if (this.mode === 2 && !this.active) {
      /* lane keeping assist blends toward road center while driving */
      const road = perception.road;
      if (road.valid && road.confidence > 0.5 && Math.abs(fwd) > 3 && Math.abs(playerSteer) < 0.1 && playerThrottle >= 0) {
        this.steerAssistTimer = 0.6;
      }
      if (this.steerAssistTimer > 0) {
        this.steerAssistTimer -= dt;
        const corr = clamp(road.lateralOffset * -0.12, -0.25, 0.25);
        vehicle.ctrl.steer = clamp(vehicle.ctrl.steer + corr, -1, 1);
      }
    }
    return { brake, warn };
  }
  avoidBias = 0;
}

function nearestSegment(world: World, x: number, z: number) {
  let best: World['roads'][number] | null = null;
  let bd = 1e9;
  for (const s of world.roads) {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const l2 = dx * dx + dz * dz;
    let t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = s.ax + dx * t, pz = s.az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bd) { bd = d; best = s; }
  }
  return bd < 40 ? best : best; /* map data is allowed for speed limits */
}
