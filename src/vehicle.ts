/* PERCEPTION - vehicle system: arcade EV physics, damage, battery, meshes */

import * as THREE from 'three';
import { clamp, damp, angleDiff } from './input';
import { World } from './world';
import { audio } from './audio';

/* scene lighting (only affects the player vehicle + cockpit; the world is points) */
let lightsInstalled = false;
function ensureLights(scene: THREE.Scene) {
  if (lightsInstalled) return;
  lightsInstalled = true;
  const hemi = new THREE.HemisphereLight(0x3a4a5c, 0x0a0e14, 0.85);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xbfd8ff, 1.15);
  dir.position.set(0.4, 1, 0.25);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x53e6ff, 0.25);
  fill.position.set(-0.6, 0.4, -0.7);
  scene.add(fill);
}

export interface VehicleSpec {
  id: string;
  name: string;
  cls: string;
  price: number;
  maxSpeed: number;   // m/s
  accel: number;      // m/s^2
  brake: number;      // m/s^2
  grip: number;
  wheelbase: number;
  bodyW: number; bodyH: number; bodyL: number;
  sensorSlots: number; // max sensor tier
  aiBonus: number;     // autonomy stability bonus 0..1
  desc: string;
  color: number;
  batteryCap: number;
}

export const VEHICLES: VehicleSpec[] = [
  { id: 'compact', name: 'KIRO COMPACT EV', cls: 'Compact EV', price: 0, maxSpeed: 33, accel: 6.2, brake: 11, grip: 8.5, wheelbase: 2.55, bodyW: 1.82, bodyH: 1.42, bodyL: 3.95, sensorSlots: 3, aiBonus: 0, desc: 'Entry-level testing vehicle. Nimble, modest range, one sensor mount.', color: 0x2b3540, batteryCap: 100 },
  { id: 'sedan', name: 'MERIDIAN SEDAN', cls: 'Electric Sedan', price: 34000, maxSpeed: 39, accel: 7.6, brake: 12, grip: 9.2, wheelbase: 2.85, bodyW: 1.9, bodyH: 1.4, bodyL: 4.7, sensorSlots: 4, aiBonus: 0.15, desc: 'Balanced urban and highway platform with improved mounting options.', color: 0x22344c, batteryCap: 130 },
  { id: 'suv', name: 'TERRA SURVEY SUV', cls: 'Electric SUV', price: 52000, maxSpeed: 36, accel: 6.8, brake: 11.5, grip: 7.8, wheelbase: 2.9, bodyW: 2.0, bodyH: 1.72, bodyL: 4.75, sensorSlots: 5, aiBonus: 0.2, desc: 'High-ride exploration platform. Extra equipment capacity, softer grip.', color: 0x274236, batteryCap: 150 },
  { id: 'performance', name: 'VELOCITA PERFORM.', cls: 'Performance EV', price: 92000, maxSpeed: 47, accel: 11.5, brake: 14, grip: 10.8, wheelbase: 2.7, bodyW: 1.94, bodyH: 1.25, bodyL: 4.6, sensorSlots: 4, aiBonus: 0.1, desc: 'Speed-focused. Demands high-performance sensing to drive safely fast.', color: 0x3a1f2e, batteryCap: 120 },
  { id: 'prototype', name: 'AXIOM PROTOTYPE', cls: 'Autonomous Prototype', price: 165000, maxSpeed: 44, accel: 10.2, brake: 13.5, grip: 11.2, wheelbase: 2.95, bodyW: 2.02, bodyH: 1.5, bodyL: 4.9, sensorSlots: 7, aiBonus: 0.45, desc: 'Experimental autonomy platform. Full sensor suite, maximum compute.', color: 0x1c2f3f, batteryCap: 200 }
];

export interface CollisionEvent { time: number; severity: number; speed: number; }

export class Vehicle {
  spec: VehicleSpec;
  pos = new THREE.Vector3();
  yaw = 0;
  velX = 0; velZ = 0;
  steer = 0;
  battery = 100;
  damage = 0;         // 0..1 body
  sensorDamage = 0;
  gearReverse = false;
  odometer = 0;
  collisions: CollisionEvent[] = [];
  group = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private steerWheels: THREE.Mesh[] = [];
  private steerWheel3D: THREE.Mesh | null = null;
  private bodyMat!: THREE.MeshStandardMaterial;
  private accentMat!: THREE.MeshStandardMaterial;
  private lightBarMat!: THREE.MeshStandardMaterial;
  paint = 0x2b3540;

  /* external control interface (player input or autonomy) */
  ctrl = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  private sceneRef: THREE.Scene | null = null;

  constructor(spec: VehicleSpec, scene: THREE.Scene) {
    this.spec = spec;
    this.paint = spec.color;
    this.sceneRef = scene;
    this.buildMesh();
    scene.add(this.group);
  }

  setSpec(spec: VehicleSpec, scene: THREE.Scene) {
    scene.remove(this.group);
    this.spec = spec;
    this.sceneRef = scene;
    this.buildMesh();
    scene.add(this.group);
  }

  setPaint(color: number) {
    this.paint = color;
    this.bodyMat.color.setHex(color);
  }

  private screenCanvas: HTMLCanvasElement | null = null;
  private screenTexture: THREE.CanvasTexture | null = null;
  private screenCtx: CanvasRenderingContext2D | null = null;
  private screenTimer = 0;
  headlightsOn = true;
  private headlightMats: THREE.MeshStandardMaterial[] = [];
  headlightBeam: THREE.PointLight | null = null;

  setScreenDataProvider(fn: (() => { speed: number; battery: number; gear: string; mode: string; status: string; viz: string; road: string }) | null) {
    this.screenData = fn;
  }
  screenData: (() => { speed: number; battery: number; gear: string; mode: string; status: string; viz: string; road: string }) | null = null;

  private buildMesh() {
    const g = this.group;
    g.clear();
    this.wheels = []; this.steerWheels = []; this.headlightMats = [];
    ensureLights(this.sceneRef!);
    const s = this.spec;

    this.bodyMat = new THREE.MeshStandardMaterial({ color: this.paint, roughness: 0.38, metalness: 0.55 });
    this.accentMat = new THREE.MeshStandardMaterial({ color: 0x53e6ff, emissive: 0x1899b8, emissiveIntensity: 1.1, roughness: 0.4 });
    this.lightBarMat = new THREE.MeshStandardMaterial({ color: 0x101820, emissive: 0x0a3340, emissiveIntensity: 0.7, roughness: 0.3 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0a141e, roughness: 0.12, metalness: 0.75, emissive: 0x0b2830, emissiveIntensity: 0.35 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.75, metalness: 0.25 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x8a97a5, roughness: 0.3, metalness: 0.85 });
    const rimGlow = new THREE.MeshStandardMaterial({ color: 0x53e6ff, emissive: 0x1899b8, emissiveIntensity: 0.8, roughness: 0.4 });

    /* --- body from an extruded side silhouette --- */
    const L = s.bodyL, H = s.bodyH, W = s.bodyW;
    const sh = new THREE.Shape();
    const x0 = -L / 2, x1 = L / 2;
    sh.moveTo(x0 + 0.15, 0.18);
    sh.lineTo(x0 + 0.55, 0.34);                       /* front bumper */
    sh.lineTo(x1 - 1.05, 0.42);                       /* hood */
    sh.lineTo(x1 - 0.55, 0.40);
    sh.lineTo(x1 - 0.62, H * 0.62);                   /* windshield base */
    sh.lineTo(x1 - 1.55, H * 0.97);                   /* windshield */
    sh.lineTo(x0 + 1.25, H * 1.0);                    /* roof */
    sh.lineTo(x0 + 0.55, H * 0.66);                   /* rear window */
    sh.lineTo(x0 + 0.18, H * 0.60);                   /* trunk lip */
    sh.lineTo(x0 + 0.10, 0.30);                       /* tail */
    sh.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(sh, { depth: W * 0.94, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, steps: 1 });
    bodyGeo.translate(0, 0, -W * 0.47);
    bodyGeo.rotateY(Math.PI / 2);                     /* silhouette along Z (forward = +Z) */
    const body = new THREE.Mesh(bodyGeo, this.bodyMat);
    body.position.y = H * 0.10;
    g.add(body);

    /* glass canopy band */
    const glass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, H * 0.34, L * 0.46), glassMat);
    glass.position.set(0, H * 0.78, -L * 0.02);
    glass.rotation.x = 0;
    g.add(glass);

    /* rocker accent strip */
    const trim = new THREE.Mesh(new THREE.BoxGeometry(W * 1.02, 0.035, L * 0.9), this.accentMat);
    trim.position.y = H * 0.30;
    g.add(trim);

    /* roof sensor pod: base + spinning lidar drum */
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.21, 0.14, 14), this.lightBarMat);
    mount.position.set(0, H + 0.10, -L * 0.06);
    g.add(mount);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.11, 18), this.accentMat);
    pod.position.set(0, H + 0.21, -L * 0.06);
    g.add(pod);
    const podRing = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.014, 8, 20), this.accentMat);
    podRing.position.set(0, H + 0.16, -L * 0.06);
    podRing.rotation.x = Math.PI / 2;
    g.add(podRing);

    /* mirrors */
    for (const sx of [-1, 1]) {
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.12), darkMat);
      stalk.position.set(sx * (W / 2 + 0.05), H * 0.72, L * 0.16);
      g.add(stalk);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.10, 0.16), this.bodyMat);
      mirror.position.set(sx * (W / 2 + 0.10), H * 0.76, L * 0.16);
      g.add(mirror);
    }

    /* spoiler for sporty trims */
    if (s.id === 'performance' || s.id === 'prototype') {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.03, 0.22), this.bodyMat);
      wing.position.set(0, H * 0.86, -L / 2 + 0.16);
      wing.rotation.x = -0.12;
      g.add(wing);
      for (const sx of [-1, 1]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.16), darkMat);
        fin.position.set(sx * W * 0.32, H * 0.79, -L / 2 + 0.18);
        g.add(fin);
      }
    }

    /* antenna for prototype */
    if (s.id === 'prototype') {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.006, 0.5, 6), darkMat);
      ant.position.set(W * 0.28, H * 1.15, -L * 0.38);
      g.add(ant);
    }

    /* headlights + taillights (emissive, toggleable) */
    for (const sx of [-1, 1]) {
      const hm = new THREE.MeshStandardMaterial({ color: 0xf2f8ff, emissive: 0xcfe8ff, emissiveIntensity: 1.6, roughness: 0.3 });
      this.headlightMats.push(hm);
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.09, 0.06), hm);
      hl.position.set(sx * W * 0.30, H * 0.40, L / 2 + 0.01);
      g.add(hl);
      const DRL = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.025, 0.05), this.accentMat);
      DRL.position.set(sx * W * 0.30, H * 0.50, L / 2 + 0.01);
      g.add(DRL);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.05), new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff3040, emissiveIntensity: 1.2 }));
      tl.position.set(sx * W * 0.30, H * 0.44, -L / 2 - 0.01);
      g.add(tl);
    }
    /* headlight beam light (illuminates own hood at night) */
    this.headlightBeam = new THREE.PointLight(0xbfe2ff, 0.0, 9, 2);
    this.headlightBeam.position.set(0, H * 0.5, L * 0.45);
    g.add(this.headlightBeam);

    /* wheels: tire + rim disc + glow ring */
    const wr = H * 0.33;
    const tireGeo = new THREE.CylinderGeometry(wr, wr, 0.26, 18);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(wr * 0.62, wr * 0.62, 0.27, 12);
    rimGeo.rotateZ(Math.PI / 2);
    const ringGeo = new THREE.TorusGeometry(wr * 0.55, 0.012, 6, 18);
    ringGeo.rotateY(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x0c0f13, roughness: 0.92 });
    for (const [wx, wz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.x = wx * 0.006;
      const ring = new THREE.Mesh(ringGeo, rimGlow);
      ring.position.x = wx * 0.012;
      wheel.add(tire, rim, ring);
      wheel.position.set(wx * (W / 2 - 0.04), wr, wz * (s.wheelbase / 2));
      g.add(wheel);
      this.wheels.push(wheel as unknown as THREE.Mesh);
      if (wz > 0) this.steerWheels.push(wheel as unknown as THREE.Mesh);
    }

    /* --- cockpit interior --- */
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x10141b, roughness: 0.82 });
    const dash = new THREE.Mesh(new THREE.BoxGeometry(W * 0.84, 0.17, 0.34), dashMat);
    dash.position.set(-W * 0.16, H * 0.60, L * 0.20);
    g.add(dash);
    const dashTop = new THREE.Mesh(new THREE.BoxGeometry(W * 0.84, 0.03, 0.38), darkMat);
    dashTop.position.set(-W * 0.16, H * 0.70, L * 0.19);
    g.add(dashTop);

    /* live instrument screen (canvas texture) */
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 512; this.screenCanvas.height = 256;
    this.screenCtx = this.screenCanvas.getContext('2d');
    this.screenTexture = new THREE.CanvasTexture(this.screenCanvas);
    const screenMat = new THREE.MeshBasicMaterial({ map: this.screenTexture, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.46, W * 0.23), screenMat);
    screen.position.set(-W * 0.16, H * 0.74, L * 0.155);
    screen.rotation.x = -0.42;
    screen.rotation.y = 0.06;
    g.add(screen);

    /* steering wheel: rim + 3 spokes + hub */
    const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.022, 10, 24), dashMat);
    wheelRim.position.set(-W * 0.16, H * 0.58, L * 0.125);
    wheelRim.rotation.x = -0.42;
    g.add(wheelRim);
    this.steerWheel3D = wheelRim;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), darkMat);
    hub.rotation.x = Math.PI / 2 - 0.42;
    wheelRim.add(hub);
    const spokeMat = this.accentMat;
    for (const a of [0, 2.1, -2.1]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.024, 0.02), spokeMat);
      spoke.rotation.z = a;
      wheelRim.add(spoke);
    }
    /* seats + console */
    for (const sx of [-0.37, 0.37]) {
      const seatBase = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.16, 0.5), dashMat);
      seatBase.position.set(sx * W * 0.42, H * 0.38, -L * 0.08);
      g.add(seatBase);
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.52, 0.13), dashMat);
      seatBack.position.set(sx * W * 0.42, H * 0.62, -L * 0.20);
      seatBack.rotation.x = 0.16;
      g.add(seatBack);
    }
    const consoleBox = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.5), darkMat);
    consoleBox.position.set(0, H * 0.42, -L * 0.02);
    g.add(consoleBox);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.03, L * 0.5), dashMat);
    roof.position.set(0, H * 1.02, -L * 0.06);
    g.add(roof);
    this.drawScreen(true);
  }

  private drawScreen(force = false) {
    if (!this.screenCtx || !this.screenTexture || !this.screenData) return;
    const d = this.screenData();
    const ctx = this.screenCtx;
    const W = 512, H = 256;
    ctx.fillStyle = '#03101a';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(83,230,255,0.35)';
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.fillStyle = '#53e6ff';
    ctx.font = '700 64px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(Math.abs(d.speed).toFixed(1), 22, 86);
    ctx.font = '400 20px Consolas, monospace';
    ctx.fillStyle = '#6d8296';
    ctx.fillText('m/s', 175, 86);
    ctx.fillStyle = '#53e6ff';
    ctx.font = '700 40px Consolas, monospace';
    ctx.fillText(d.gear, 246, 84);
    ctx.font = '400 19px Consolas, monospace';
    ctx.fillStyle = '#9fb4c4';
    ctx.fillText(d.viz, 22, 128);
    ctx.fillText('MODE ' + d.mode, 22, 158);
    ctx.fillStyle = d.status === 'STANDBY' ? '#6d8296' : '#51ffa8';
    ctx.fillText(d.status.slice(0, 22), 22, 188);
    /* battery bar */
    ctx.fillStyle = '#22303c';
    ctx.fillRect(22, 210, 300, 18);
    ctx.fillStyle = d.battery < 15 ? '#ff4d5e' : d.battery < 35 ? '#ffc24d' : '#53e6ff';
    ctx.fillRect(22, 210, 300 * clamp(d.battery, 0, 100) / 100, 18);
    ctx.fillStyle = '#9fb4c4';
    ctx.fillText(Math.round(d.battery) + '%', 332, 226);
    ctx.fillStyle = '#40566a';
    ctx.fillText('PERCEPTION OS', 352, 40);
    this.screenTexture.needsUpdate = true;
    void force;
  }

  sensorMountWorld(): { x: number; y: number; z: number } {
    const s = this.spec;
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const lx = 0, ly = s.bodyH + 0.24, lz = -s.bodyL * 0.05;
    return {
      x: this.pos.x + c * lx + sn * lz,
      y: this.pos.y + ly,
      z: this.pos.z - sn * lx + c * lz
    };
  }

  update(dt: number, world: World, enabled: boolean) {
    const s = this.spec;
    const ctrl = this.ctrl;
    const damageFactor = 1 - this.damage * 0.45;
    const batteryFactor = this.battery <= 0 ? 0.35 : 1;
    const maxSpeed = s.maxSpeed * damageFactor;

    /* steering */
    const speedAbs = Math.abs(this.forwardSpeed());
    const maxSteer = 0.55 / (1 + speedAbs * 0.05);
    const steerTarget = (enabled ? ctrl.steer : 0) * maxSteer;
    this.steer = damp(this.steer, steerTarget, 9, dt);

    /* forward / lateral decomposition */
    const fX = Math.sin(this.yaw), fZ = Math.cos(this.yaw);
    const rX = Math.cos(this.yaw), rZ = -Math.sin(this.yaw);
    let fwd = this.velX * fX + this.velZ * fZ;
    let lat = this.velX * rX + this.velZ * rZ;

    /* drive */
    const throttle = enabled ? ctrl.throttle : 0;
    const brake = enabled ? ctrl.brake : 0;
    if (throttle > 0) {
      if (fwd < -0.5) fwd += s.brake * 0.7 * dt;
      else fwd += s.accel * batteryFactor * damageFactor * (1 - Math.max(0, fwd) / (maxSpeed * 1.06)) * throttle * dt;
    }
    if (brake > 0) {
      if (fwd > 0.5) fwd -= s.brake * brake * dt;
      else if (throttle === 0) fwd -= s.accel * 0.55 * batteryFactor * dt; /* reverse */
    }
    if (ctrl.handbrake) fwd *= Math.exp(-2.4 * dt);
    /* drag + rolling */
    fwd -= (0.35 * fwd + 0.011 * fwd * Math.abs(fwd)) * dt;
    if (throttle === 0 && brake === 0) fwd *= Math.exp(-0.25 * dt);
    fwd = clamp(fwd, -maxSpeed * 0.28, maxSpeed);

    /* lateral grip */
    const grip = s.grip * (ctrl.handbrake ? 0.22 : 1) * damageFactor;
    lat *= Math.exp(-grip * dt);

    /* yaw from bicycle model */
    const yawRate = (fwd / s.wheelbase) * Math.tan(this.steer) * (ctrl.handbrake ? 1.5 : 1);
    this.yaw += yawRate * dt;

    /* recompose velocity */
    this.velX = fX * fwd + rX * lat;
    this.velZ = fZ * fwd + rZ * lat;
    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;
    this.pos.y = 0;
    this.odometer += Math.abs(fwd) * dt;

    /* collisions: two circles */
    const sampleR = s.bodyW / 2 + 0.12;
    for (const off of [s.bodyL * 0.3, -s.bodyL * 0.3]) {
      const px = this.pos.x + fX * off, pz = this.pos.z + fZ * off;
      const col = world.collideCircle(px, pz, sampleR);
      if (col.hitObj) {
        this.pos.x += col.pushX; this.pos.z += col.pushZ;
        const vn = -(this.velX * col.nx + this.velZ * col.nz);
        if (vn > 0) {
          if (vn > 1.6) {
            const severity = Math.min(1, vn / 18);
            this.damage = clamp(this.damage + vn * 0.006, 0, 1);
            this.sensorDamage = clamp(this.sensorDamage + vn * 0.003, 0, 1);
            this.collisions.push({ time: performance.now() / 1000, severity, speed: vn });
            audio.collision(severity * 30);
          }
          /* bounce + scrub speed */
          const vn2 = this.velX * col.nx + this.velZ * col.nz;
          this.velX -= col.nx * vn2 * 1.5;
          this.velZ -= col.nz * vn2 * 1.5;
          this.velX *= 0.72; this.velZ *= 0.72;
        }
      }
    }

    /* battery */
    const speedFrac = Math.abs(fwd) / Math.max(1, maxSpeed);
    let drain = 0.05 + 0.42 * throttle * (0.25 + 0.75 * speedFrac) + 0.1 * brake * speedFrac;
    if (brake > 0 && fwd > 2) drain -= 0.16; /* regen */
    this.battery = clamp(this.battery - drain * dt * (100 / s.batteryCap) * 1.35, 0, 100);

    /* visuals */
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw + Math.PI;
    const wheelSpin = fwd * dt / (s.bodyH * 0.33);
    for (const w of this.wheels) w.rotation.x += wheelSpin;
    for (const w of this.steerWheels) w.rotation.y = -this.steer * 1.2;
    if (this.steerWheel3D) this.steerWheel3D.rotation.z = -this.steer * 3.4;
    if (this.headlightBeam) {
      const target = this.headlightsOn ? 1.6 : 0.0;
      (this.headlightBeam as any).intensity = (this.headlightBeam as any).intensity * 0.85 + target * 0.15;
    }

    /* instrument screen refresh at ~5 Hz */
    this.screenTimer += dt;
    if (this.screenTimer > 0.2) { this.screenTimer = 0; this.drawScreen(); }

    audio.updateDrive(fwd, throttle, dt);
    this.lastFwd = fwd;
  }

  lastFwd = 0;

  forwardSpeed(): number {
    return this.velX * Math.sin(this.yaw) + this.velZ * Math.cos(this.yaw);
  }

  reset(x: number, z: number, yaw: number) {
    this.pos.set(x, 0, z);
    this.yaw = yaw;
    this.velX = 0; this.velZ = 0;
    this.steer = 0;
    this.ctrl.throttle = 0; this.ctrl.brake = 0; this.ctrl.steer = 0;
  }
}
