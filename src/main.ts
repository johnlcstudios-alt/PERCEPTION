/* PERCEPTION - main game loop and system glue */

import * as THREE from 'three';
import { QUALITY, WEATHER, PAL, VIZ_MODES, REP_UNLOCKS } from './config';
import { Input, clamp, damp, angleDiff } from './input';
import { audio } from './audio';
import { World, DISTRICTS, POIS } from './world';
import { LidarSystem, SENSORS, AUX_SENSORS } from './lidar';
import { PerceptionEngine } from './perception';
import { Vehicle, VEHICLES } from './vehicle';
import { AutonomyDriver } from './autonomy';
import { UPGRADES } from './data';
import { save, Profile } from './save';
import { MissionRunner, MissionDef, MISSIONS } from './missions';
import { HUD, fmtClock } from './hud';
import { MenuSystem } from './menu';

type GameState = 'menu' | 'driving' | 'paused' | 'results' | 'map';

class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  world: World;
  lidar: LidarSystem;
  perception: PerceptionEngine;
  vehicle: Vehicle;
  autonomy = new AutonomyDriver();
  input: Input;
  hud = new HUD();
  menu: MenuSystem;
  mission = new MissionRunner();
  profile: Profile;

  state: GameState = 'menu';
  vizMode = 0;
  camMode = 0; // 0 chase 1 far 2 cockpit 3 cinematic
  camYaw = 0;
  camPitch = 0.22;
  camOrbitYaw = 0;   // mouse-drag orbit offset around the vehicle (rad)
  camOrbitPitch = 0; // mouse-drag elevation offset: >0 = camera above (bird view)
  camPos = new THREE.Vector3();
  now = 0;
  dayTime = 9.0;
  weatherId = 'clear';
  fog: THREE.FogExp2;
  private eventTimer = 24;
  private eventEffect = 0;
  private eventEffectTimer = 0;
  private tmpV = new THREE.Vector3();
  private lastOdometer = 0;
  private lostFlash = 0;
  private tutorialStep = 0;
  private minimapFrame = 0;
  private freeRoamRegion = 'facility';
  private collisionAudioCool = 0;
  photoMode = false;
  private photoCam = { x: 0, y: 3, z: 0, yaw: 0, pitch: -0.1 };
  private shotRequest = false;
  private poiHold: Record<string, number> = {};
  private poiCheckTimer = 0;
  private nearbyPoi: { name: string; dist: number } | null = null;
  private chargeToastTimer = 0;
  private basePixelRatio = 1;
  private resScale = 1;
  private resCheckTimer = 3;

  constructor() {
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(window.devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(PAL.bg);
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.08, 4000);
    this.fog = new THREE.FogExp2(0x04060b, 0.0);
    this.scene.fog = this.fog;

    this.input = new Input(canvas);

    /* world */
    this.world = new World(20261126);
    this.world.buildDistricts();
    this.world.spawnTraffic(120, 8);

    /* lidar + perception */
    this.lidar = new LidarSystem(this.scene, this.world, QUALITY[save.profile.settings.quality] ?? QUALITY.high);
    this.lidar.onCycle = (_cycle, snap) => {
      const v = this.vehicle;
      const mount = v.sensorMountWorld();
      this.perception.ingest(snap, this.now, v.pos.x, v.pos.z, v.yaw, this.lidar.lastRange);
      void mount;
      this.profile.stats.scans++;
    };
    this.perception = new PerceptionEngine(this.world, this.scene);
    this.perception.onDetection = (cls) => {
      audio.detect();
      if (cls === 'pedestrian') this.toast('PEDESTRIAN DETECTED');
    };
    this.perception.onLost = () => { this.lostFlash = 2.0; };

    /* vehicle */
    this.vehicle = new Vehicle(VEHICLES[0], this.scene);
    this.profile = save.profile;

    this.menu = new MenuSystem(this.profile, {
      onMissionStart: (def) => this.startMission(def),
      onFreeRoam: (region) => this.startFreeRoam(region),
      onEquipmentChanged: () => { this.applyEquipment(); this.menu.showScreen('menu-screen'); this.menu.renderMain(); },
      onSettingsChanged: () => this.applySettings(),
      onProfileEdited: () => this.applyEquipment(),
      onResume: () => this.resume(),
      onRestartMission: () => { if (this.mission.def) this.startMission(this.mission.def); },
      onAbort: () => this.toMenu(),
      onResultsContinue: () => { this.menu.hideAll(); this.state = 'driving'; this.mission.state = 'idle'; this.hud.show(); },
      onResultsRetry: () => { if (this.mission.def) this.startMission(this.mission.def); },
      onResultsMenu: () => this.toMenu()
    });

    (window as any).__gameRepair = () => { this.vehicle.damage = 0; this.vehicle.sensorDamage = 0; };
    Object.defineProperty(window, '__gameVehicleDamage', { get: () => this.vehicle.damage });

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.vehicle.setScreenDataProvider(() => ({
      speed: this.vehicle.forwardSpeed(),
      battery: this.vehicle.battery,
      gear: this.vehicle.forwardSpeed() < -0.3 ? 'R' : 'D',
      mode: String(this.autonomy.mode),
      status: this.autonomy.status,
      viz: VIZ_MODES[this.vizMode].name,
      road: this.perception.road.valid ? 'ROAD OK' : 'NO ROAD'
    }));

    /* wheel over the minimap resizes it (minimize / maximize; clamps at the ends) */
    const minimapEl = document.getElementById('minimap') as HTMLElement;
    minimapEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cycleMinimap(e.deltaY > 0 ? -1 : 1, false);
    }, { passive: false });

    this.applyEquipment();
    this.applySettings();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /* ---------------- setup helpers ---------------- */

  applyEquipment() {
    const p = this.profile;
    const base = SENSORS[clamp(p.sensorTier, 1, 7) - 1];
    const extraCh = Math.round((p.upgrades['channels'] ?? 0) * 2);
    const spec = extraCh > 0 ? { ...base, channels: base.channels + extraCh } : base;
    this.lidar.setSensor(spec);
    /* auxiliary pods: radar / camera / proximity / ultrasonic / GNSS fusion */
    const activeAux = p.activeAux ?? [];
    this.lidar.setAuxSensors(AUX_SENSORS.filter(a => activeAux.includes(a.id)));
    this.autonomy.gnss = activeAux.includes('gnss');
    const up = p.upgrades;
    this.lidar.applyUpgrades({
      freq: (up['scanFreq'] ?? 0) * 0.12,
      range: (up['range'] ?? 0) * 0.14,
      noise: (up['calibration'] ?? 0) * 0.12,
      az: (up['density'] ?? 0) * 0.09,
      latency: (up['aiUnit'] ?? 0) * 0.15,
      filtering: (up['filtering'] ?? 0) * 0.25
    });
    this.perception.recognitionLevel = clamp((up['recognition'] ?? 0) * 0.12 + (p.research.includes('vizObjects') ? 0.1 : 0), 0, 1);
    /* vehicle */
    const vdef = VEHICLES.find(v => v.id === p.selectedVehicle) ?? VEHICLES[0];
    if (this.vehicle.spec.id !== vdef.id) this.vehicle.setSpec(vdef, this.scene);
    this.vehicle.setPaint(p.paint);
    /* extra channels from density upgrade */
    void UPGRADES;
  }

  applySettings() {
    const s = this.profile.settings;
    const q = QUALITY[s.quality] ?? QUALITY.high;
    this.lidar.setQuality(q);
    this.lidar.setSweepVisible(s.sweep);
    const life = typeof s.pointLife === 'number' && isFinite(s.pointLife) ? clamp(s.pointLife, 1, 120) : 4;
    /* "keep forever": large finite life so the shader fade never kicks in;
       points persist until the ring buffer recycles them */
    this.lidar.setLife(s.pointForever === true ? 1e9 : life);
    const sweepMul = typeof s.sweepSpeed === 'number' && isFinite(s.sweepSpeed) ? s.sweepSpeed : 1;
    this.lidar.setSweepSpeed(sweepMul);
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    audio.setVolume(s.volume);
    (document.getElementById('minimap') as HTMLElement).style.display = s.minimap ? '' : 'none';
    this.applyMinimapSize();
  }

  /* minimap size: minimized / normal / maximized (persisted in settings) */
  applyMinimapSize() {
    const size = this.profile.settings.minimapSize === 'max' ? 400
      : this.profile.settings.minimapSize === 'min' ? 118 : 220;
    const mm = document.getElementById('minimap') as HTMLElement;
    mm.style.width = size + 'px';
    mm.style.height = size + 'px';
  }

  cycleMinimap(dir: number, wrap = true) {
    const order = ['min', 'normal', 'max'];
    const cur = order.indexOf(this.profile.settings.minimapSize ?? 'normal');
    const idx = wrap ? (cur + dir + order.length) % order.length : clamp(cur + dir, 0, order.length - 1);
    const next = order[idx] ?? 'normal';
    if (next === this.profile.settings.minimapSize) return;
    this.profile.settings.minimapSize = next;
    save.markDirty(); save.flush();
    this.applyMinimapSize();
    this.toast('MINIMAP — ' + (next === 'max' ? 'MAXIMIZED' : next === 'min' ? 'MINIMIZED' : 'NORMAL'));
    audio.click();
  }

  toast(msg: string) { this.hud.toast(msg); }

  /* ---------------- state transitions ---------------- */

  toMenu() {
    this.state = 'menu';
    this.mission.state = 'idle';
    this.hud.hide();
    this.menu.showScreen('menu-screen');
    this.menu.renderMain();
    save.markDirty(); save.flush(true);
  }

  resume() {
    this.menu.hideAll();
    this.state = 'driving';
    this.hud.show();
  }

  pause() {
    if (this.state !== 'driving' && this.state !== 'map') return;
    this.state = 'paused';
    this.menu.showPause();
  }

  startFreeRoam(region: string) {
    audio.ensure();
    this.menu.hideAll();
    this.state = 'driving';
    this.hud.show();
    this.mission.state = 'idle';
    this.tutorialStep = -1;
    this.hud.tutorial(null);
    this.autonomy.clearRoute();
    this.perception.reset();
    if (region === '__continue__') {
      /* resume where we were; first boot spawns at facility */
      if (!this.vehicleStarted) this.placeVehicleAt(this.world.randomRoadPoint('facility'));
    } else {
      this.freeRoamRegion = region;
      const pt = this.world.randomRoadPoint(region);
      this.placeVehicleAt(pt);
      this.toast(DISTRICTS[region as keyof typeof DISTRICTS]?.name ?? region);
    }
    this.vehicle.damage = Math.min(this.vehicle.damage, 0.2);
    this.vehicle.battery = Math.max(this.vehicle.battery, 60);
  }
  vehicleStarted = false;

  placeVehicleAt(pt: { x: number; z: number; yaw: number }) {
    this.vehicle.reset(pt.x, pt.z, pt.yaw);
    this.vehicleStarted = true;
    this.camPos.set(pt.x - Math.sin(pt.yaw) * 8, 3.2, pt.z - Math.cos(pt.yaw) * 8);
  }

  startMission(def: MissionDef) {
    audio.ensure();
    this.menu.hideAll();
    this.state = 'driving';
    this.hud.show();
    this.weatherId = def.weather;
    this.placeVehicleAt(def.spawn);
    this.vehicle.damage = 0;
    this.vehicle.sensorDamage = 0;
    this.vehicle.battery = 100;
    this.vehicle.collisions.length = 0;
    this.autonomy.setMode(0);
    this.autonomy.clearRoute();
    this.autonomy.interventions = 0;
    this.perception.reset();
    this.mission.start(def, this.autonomy);
    /* pre-set route to final reach objective for supervised missions */
    const reach = [...def.objectives].reverse().find(o => o.type === 'reach');
    if (reach && reach.x !== undefined) {
      this.autonomy.setDestination(reach.x, reach.z ?? 0, this.world, def.spawn.x, def.spawn.z);
    }
    this.tutorialStep = def.id === 'c1m1' && !this.profile.tutorialDone ? 0 : -1;
    this.toast('MISSION: ' + def.name);
    audio.chime('engage');
  }

  /* ---------------- main loop ---------------- */

  private lastT = 0;
  fpsAvg = 0;
  requestScreenshot: boolean | string = false;
  loop(t: number) {
    requestAnimationFrame(this.loop);
    const dt = clamp((t - this.lastT) / 1000, 0.0001, 0.05);
    if (this.lastT > 0) this.fpsAvg = this.fpsAvg * 0.95 + (1 / dt) * 0.05;
    this.lastT = t;

    /* adaptive resolution keeps the frame rate smooth */
    this.resCheckTimer -= dt;
    if (this.resCheckTimer <= 0 && this.fpsAvg > 1) {
      this.resCheckTimer = 2.5;
      if (this.fpsAvg < 42 && this.resScale > 0.7) {
        this.resScale = Math.max(0.7, this.resScale * 0.85);
        this.renderer.setPixelRatio(this.basePixelRatio * this.resScale);
        this.toast('ADAPTIVE RESOLUTION — ' + Math.round(this.resScale * 100) + '%');
      } else if (this.fpsAvg > 56 && this.resScale < 1) {
        this.resScale = Math.min(1, this.resScale / 0.85);
        this.renderer.setPixelRatio(this.basePixelRatio * this.resScale);
      }
    }

    if (this.photoMode) {
      if (this.input.justPressed('KeyO')) { this.exitPhotoMode(); }
      else this.updatePhotoCam(dt);
      this.renderer.render(this.scene, this.camera);
      if (this.input.justPressed('F2')) this.saveScreenshot(true);
      this.input.endFrame();
      return;
    }

    /* map state: M / ESC close the map (step() is paused while the map is open) */
    if (this.state === 'map' && (this.input.justPressed('Escape') || this.input.justPressed('KeyM'))) {
      this.toggleMap();
    }

    if (this.state === 'driving') {
      this.now += dt;
      this.step(dt);
    }
    this.renderer.render(this.scene, this.camera);
    if (this.shotRequest) { this.shotRequest = false; this.saveScreenshot(false); }
    if (this.requestScreenshot) {
      const name = typeof this.requestScreenshot === 'string' ? this.requestScreenshot : 'screenshot';
      this.requestScreenshot = false;
      const host = (window as any).perceptionHost;
      if (host && host.capture) {
        Promise.resolve(host.capture(name)).then((r: any) => { console.error('[SHOT] ' + name + ' saved=' + r); }).catch((e: any) => console.error('[SHOT-err]', e && e.message));
      }
    }
    this.input.endFrame();
  }

  private step(dt: number) {
    const v = this.vehicle;
    const p = this.perception;
    const inp = this.input;

    /* ---- global keys ---- */
    if (inp.justPressed('Escape') || inp.justPressed('KeyP')) { this.pause(); return; }
    if (inp.justPressed('KeyM')) { this.toggleMap(); return; }
    if (inp.justPressed('KeyO')) { this.enterPhotoMode(); return; }
    if (inp.justPressed('F2')) { this.shotRequest = true; }
    if (inp.justPressed('KeyC')) { this.camMode = (this.camMode + 1) % 4; }
    if (inp.justPressed('KeyN')) this.cycleMinimap(1);
    if (inp.justPressed('KeyR')) {
      const pt = this.world.randomRoadPoint(this.world.districtAt(v.pos.x, v.pos.z));
      v.reset(pt.x, pt.z, pt.yaw);
      this.toast('VEHICLE RECOVERED');
    }
    /* viz modes */
    if (inp.justPressed('KeyV')) this.setViz((this.vizMode + 1) % VIZ_MODES.length);
    for (let i = 0; i < VIZ_MODES.length; i++) {
      if (inp.justPressed('Digit' + (i + 1))) this.setViz(i);
    }
    /* autonomy mode */
    if (inp.justPressed('KeyT')) this.cycleAutonomy();

    /* ---- player control ---- */
    const wasActive = this.autonomy.active;
    const playerThrottle = inp.throttle, playerBrake = inp.brake, playerSteer = inp.steer;
    v.ctrl.throttle = playerThrottle;
    v.ctrl.brake = playerBrake;
    v.ctrl.steer = playerSteer;
    v.ctrl.handbrake = inp.handbrake;

    this.autonomy.checkIntervention(playerSteer, playerBrake);
    if (wasActive && !this.autonomy.active && this.autonomy.disengageReason) {
      this.toast('AUTONOMY DISENGAGED — ' + this.autonomy.disengageReason);
      this.autonomy.disengageReason = '';
      audio.chime('disengage');
    }

    /* world & agents */
    this.world.refreshDynamicGrid();
    this.world.updateAgents(dt, v.pos.x, v.pos.z);

    /* vehicle physics */
    v.update(dt, this.world, true);
    for (const c of v.collisions) {
      this.mission.notifyCollision(c.severity);
      this.profile.stats.collisions++;
    }
    v.collisions.length = 0;
    this.profile.stats.kmDriven += (v.odometer - this.lastOdometer) / 1000;
    this.lastOdometer = v.odometer;

    /* autonomy (may override ctrl) */
    const autoRes = this.autonomy.update(dt, v, p, this.world, WEATHER[this.weatherId], playerThrottle, playerSteer);
    if (autoRes.brake > 0) v.ctrl.brake = Math.max(v.ctrl.brake, autoRes.brake);

    /* ---- lidar ---- */
    const mount = v.sensorMountWorld();
    const es = this.lidar.effectiveSpec();
    this.lidar.obstruction = this.checkObstruction(mount);
    this.lidar.update(dt, mount.x, mount.y, mount.z, v.yaw, this.now);
    this.lidar.flushQueue(this.now);

    /* ---- perception boxes ---- */
    p.updateBoxes(VIZ_MODES[this.vizMode].id, v.pos.x, v.pos.z, this.now);
    p.boxLayer.setVisible((VIZ_MODES[this.vizMode].id === 'objects' || VIZ_MODES[this.vizMode].id === 'wireframe') && this.profile.settings.labels !== false);

    /* ---- mission ---- */
    this.mission.update(dt, {
      vehicle: v, perception: p, world: this.world, autonomy: this.autonomy,
      lidar: this.lidar, profile: this.profile, weather: this.weatherId
    });
    if (this.mission.state === 'success' && this.mission.result) {
      this.finishMission(this.mission.result);
    } else if (this.mission.state === 'failed' && this.mission.result) {
      this.finishMission(this.mission.result);
    }

    /* ---- environment ---- */
    this.updateEnvironment(dt);
    this.updateDynamicEvents(dt);

    /* ---- camera ---- */
    this.updateCamera(dt);

    /* ---- HUD ---- */
    this.updateHud(dt);

    /* ---- charging pads ---- */
    if (this.chargeToastTimer > 0) this.chargeToastTimer -= dt;
    if (v.battery < 99.5) {
      for (const pad of this.world.chargePads) {
        const pd = Math.hypot(pad.x - v.pos.x, pad.z - v.pos.z);
        if (pd < 5.2 && Math.abs(v.forwardSpeed()) < 1.6) {
          v.battery = clamp(v.battery + 4.5 * dt, 0, 100);
          if (this.chargeToastTimer <= 0) { this.toast('CHARGING — ' + Math.round(v.battery) + '%'); this.chargeToastTimer = 3.5; }
          break;
        }
      }
    }

    /* ---- POI discovery ---- */
    this.poiCheckTimer -= dt;
    if (this.poiCheckTimer <= 0) {
      this.poiCheckTimer = 0.4;
      this.nearbyPoi = null;
      for (const poi of POIS) {
        if (this.profile.discoveredLocations.includes(poi.id)) continue;
        const pd = Math.hypot(poi.x - v.pos.x, poi.z - v.pos.z);
        if (pd < poi.r * 2 && (!this.nearbyPoi || pd < this.nearbyPoi.dist)) {
          this.nearbyPoi = { name: poi.name, dist: pd };
        }
        if (pd < poi.r) {
          const hold = (this.poiHold[poi.id] ?? 0) + 0.4;
          if (hold >= 3 && this.lidar.cycleCount > 0) {
            this.profile.discoveredLocations.push(poi.id);
            this.profile.credits += poi.reward.cr;
            this.profile.researchData += poi.reward.rd;
            this.profile.xp += poi.reward.xp;
            save.markDirty(); save.flush();
            audio.chime('unlock');
            this.toast('LOCATION DISCOVERED — ' + poi.name + ' (+' + poi.reward.cr + ' CR · +' + poi.reward.rd + ' RD)');
            this.poiHold[poi.id] = 0;
          } else {
            this.poiHold[poi.id] = hold;
          }
        } else {
          this.poiHold[poi.id] = 0;
        }
      }
    }

    /* ---- audio ambience ---- */
    audio.setRain(WEATHER[this.weatherId].audio);

    /* tutorial */
    this.updateTutorial();
  }

  setViz(i: number) {
    const mode = VIZ_MODES[i];
    if (mode.research && !this.profile.research.includes(mode.research)) {
      this.toast('LOCKED — RESEARCH: ' + mode.name);
      audio.back();
      return;
    }
    this.vizMode = i;
    this.lidar.setMode(i);
    this.hud.vizFlash(mode.name);
    audio.click();
  }

  cycleAutonomy() {
    const p = this.profile;
    const unlockedMax = 1
      + (p.research.includes('auto2') ? 1 : 0)
      + (p.research.includes('auto3') ? 1 : 0)
      + (p.research.includes('auto4') ? 1 : 0)
      + (p.research.includes('auto5') ? 1 : 0);
    let next = (this.autonomy.mode + 1) % (unlockedMax + 1);
    if (next > unlockedMax) next = 0;
    this.autonomy.setMode(next);
    if (next >= 3) {
      if (!this.autonomy.destination) {
        this.toast('SET A DESTINATION ON THE MAP (M)');
        this.toggleMap();
      } else {
        this.toast('AUTONOMY ENGAGED — MODE ' + next);
        audio.chime('engage');
      }
    } else {
      this.toast('DRIVING MODE ' + next);
      audio.click();
    }
  }

  enterPhotoMode() {
    if (this.photoMode) return;
    this.photoMode = true;
    this.hud.hide();
    this.photoCam.x = this.camera.position.x;
    this.photoCam.y = this.camera.position.y;
    this.photoCam.z = this.camera.position.z;
    this.photoCam.yaw = Math.atan2(this.vehicle.pos.x - this.camera.position.x, this.vehicle.pos.z - this.camera.position.z);
    this.photoCam.pitch = -0.08;
    this.toast('PHOTO MODE — O TO EXIT');
    audio.click();
  }

  exitPhotoMode() {
    this.photoMode = false;
    this.hud.show();
    this.toast('PHOTO MODE EXIT');
    audio.click();
  }

  updatePhotoCam(dt: number) {
    const inp = this.input;
    /* drag to rotate the photo camera */
    const [pdx, pdy] = inp.consumeMouse();
    if (pdx !== 0 || pdy !== 0) {
      this.photoCam.yaw -= pdx * 0.0042;
      this.photoCam.pitch = clamp(this.photoCam.pitch + pdy * 0.0042, -1.4, 1.4);
    }
    const spd = (inp.anyDown('ShiftLeft', 'ShiftRight') ? 46 : 15) * dt;
    const cy = Math.cos(this.photoCam.pitch), sy = Math.sin(this.photoCam.pitch);
    const fx = Math.sin(this.photoCam.yaw) * cy, fy = sy, fz = Math.cos(this.photoCam.yaw) * cy;
    const rx = Math.cos(this.photoCam.yaw), rz = -Math.sin(this.photoCam.yaw);
    if (inp.anyDown('KeyW', 'ArrowUp')) { this.photoCam.x += fx * spd; this.photoCam.y += fy * spd; this.photoCam.z += fz * spd; }
    if (inp.anyDown('KeyS', 'ArrowDown')) { this.photoCam.x -= fx * spd; this.photoCam.y -= fy * spd; this.photoCam.z -= fz * spd; }
    if (inp.anyDown('KeyD', 'ArrowRight')) { this.photoCam.x += rx * spd; this.photoCam.z += rz * spd; }
    if (inp.anyDown('KeyA', 'ArrowLeft')) { this.photoCam.x -= rx * spd; this.photoCam.z -= rz * spd; }
    if (inp.anyDown('KeyR')) this.photoCam.y += spd;
    if (inp.anyDown('KeyF')) this.photoCam.y -= spd;
    if (inp.anyDown('KeyQ')) this.photoCam.yaw += 1.7 * dt;
    if (inp.anyDown('KeyE')) this.photoCam.yaw -= 1.7 * dt;
    if (inp.anyDown('KeyZ')) this.photoCam.pitch = clamp(this.photoCam.pitch + 1.2 * dt, -1.4, 1.4);
    if (inp.anyDown('KeyC')) this.photoCam.pitch = clamp(this.photoCam.pitch - 1.2 * dt, -1.4, 1.4);
    if (inp.justPressed('KeyV')) this.setViz((this.vizMode + 1) % VIZ_MODES.length);
    this.camera.position.set(this.photoCam.x, Math.max(0.3, this.photoCam.y), this.photoCam.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.photoCam.pitch, this.photoCam.yaw, 0);
  }

  saveScreenshot(inPhoto: boolean) {
    try {
      const url = this.renderer.domElement.toDataURL('image/png');
      const host = (window as any).perceptionHost;
      if (host && host.savePng) {
        host.savePng(url, 'shot-' + Date.now());
        if (!inPhoto) this.toast('SCREENSHOT SAVED');
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = 'perception-' + Date.now() + '.png'; a.click();
      }
    } catch (_) { /* capture unavailable */ }
  }

  toggleMap() {
    if (this.state === 'map') { this.state = 'driving'; (document.getElementById('map-overlay') as HTMLElement).classList.add('hidden'); return; }
    if (this.state !== 'driving') return;
    this.state = 'map';
    (document.getElementById('map-overlay') as HTMLElement).classList.remove('hidden');
    this.drawBigMap();
  }

  private drawBigMap() {
    const canvas = document.getElementById('bigmap') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const world = this.world;
    const S = W / 3200; // world 3200 wide centered
    const tx = (x: number) => (x + 1600) * S;
    const tz = (z: number) => (z + 1600) * S;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = '#05090f';
    ctx.fillRect(0, 0, W, W);
    /* districts */
    ctx.font = '13px Segoe UI';
    ctx.textAlign = 'center';
    for (const [key, d] of Object.entries(DISTRICTS)) {
      ctx.strokeStyle = 'rgba(83,230,255,0.08)';
      ctx.strokeRect(tx(d.cx - d.size / 2), tz(d.cz - d.size / 2), d.size * S, d.size * S);
      ctx.fillStyle = 'rgba(154,107,255,0.55)';
      ctx.fillText(d.name, tx(d.cx), tz(d.cz - d.size / 2) - 6);
    }
    /* roads */
    ctx.strokeStyle = 'rgba(83,230,255,0.35)';
    for (const seg of world.roads) {
      ctx.lineWidth = seg.kind === 'highway' ? 4 : seg.kind === 'ramp' || seg.kind === 'rural' ? 2 : 2.5;
      ctx.beginPath();
      ctx.moveTo(tx(seg.ax), tz(seg.az));
      ctx.lineTo(tx(seg.bx), tz(seg.bz));
      ctx.stroke();
    }
    /* mission objective */
    const obj = this.mission.currentObjective();
    if (obj && obj.x !== undefined) {
      ctx.fillStyle = '#ffc24d';
      ctx.beginPath(); ctx.arc(tx(obj.x), tz(obj.z ?? 0), 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,194,77,0.5)';
      ctx.beginPath(); ctx.arc(tx(obj.x), tz(obj.z ?? 0), 12, 0, Math.PI * 2); ctx.stroke();
    }
    /* destination */
    if (this.autonomy.destination) {
      ctx.strokeStyle = '#9a6bff';
      ctx.lineWidth = 2;
      ctx.strokeRect(tx(this.autonomy.destination.x) - 6, tz(this.autonomy.destination.z) - 6, 12, 12);
    }
    /* player */
    const v = this.vehicle;
    ctx.save();
    ctx.translate(tx(v.pos.x), tz(v.pos.z));
    ctx.rotate(v.yaw + Math.PI);
    ctx.fillStyle = '#e8f6ff';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 8); ctx.lineTo(0, 4); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
    ctx.restore();

    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const mz = (e.clientY - rect.top) * (canvas.height / rect.height);
      const wx = mx / S - 1600, wz = mz / S - 1600;
      if (this.autonomy.mode >= 3) {
        this.autonomy.setDestination(wx, wz, this.world, this.vehicle.pos.x, this.vehicle.pos.z);
        this.toast('ROUTE SET — MODE ' + this.autonomy.mode + ' ACTIVE');
        audio.chime('engage');
        this.toggleMap();
      } else {
        this.toast('ENGAGE MODE 3+ (T) TO ROUTE AUTONOMOUSLY');
        audio.back();
      }
    };
  }

  checkObstruction(mount: { x: number; y: number; z: number }): boolean {
    if (this.vehicle.damage > 0.7 && Math.random() < 0.5) return true;
    const hit = this.world.raycast(mount.x, mount.y, mount.z, 0, 1, 0, 3.0);
    return !!hit;
  }

  updateEnvironment(dt: number) {
    /* day cycle: 24h per 20 min */
    this.dayTime = (this.dayTime + dt * (24 / 1200)) % 24;
    const w = WEATHER[this.weatherId];
    /* note: 'night' is 1 at midday, 0 at midnight — it is the daylight factor */
    const night = clamp(Math.cos((this.dayTime - 13) / 24 * Math.PI * 2) * 0.5 + 0.5, 0, 1);
    this.lidar.setDaylight(night);
    const bg = new THREE.Color(PAL.bg).lerp(new THREE.Color(0x0a1424), (1 - night) * 0.5);
    this.renderer.setClearColor(bg);
    this.fog.density = w.fogDensity * (0.75 + 0.25 * (1 - night));
    this.fog.color.copy(bg);
  }

  updateDynamicEvents(dt: number) {
    const def = this.mission.def;
    const eventsAllowed = this.mission.state === 'active' ? !!def?.dynamicEvents : this.mission.state === 'idle';
    if (this.eventEffectTimer > 0) {
      this.eventEffectTimer -= dt;
      if (this.eventEffectTimer <= 0) {
        if (this.eventEffect === 1) { this.lidar.interference = 0; this.hud.setWarning('interference', null); }
        if (this.eventEffect === 3) { this.world.trafficSpeedMul = 1; }
      }
      return;
    }
    if (!eventsAllowed) return;
    this.eventTimer -= dt;
    if (this.eventTimer > 0) return;
    this.eventTimer = 26 + Math.random() * 30;
    const roll = Math.random();
    const v = this.vehicle;
    if (roll < 0.3 && Math.abs(v.forwardSpeed()) > 7) {
      /* sudden obstacle */
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
      const d = 26 + Math.random() * 26;
      this.world.addBox('obstacle', MAT_BARRIER(), v.pos.x + fx * d, 0.9, v.pos.z + fz * d, 1.6, 1.8, 1.6, Math.random() * Math.PI, { collR: 1.6, tags: ['dynamic'] });
      this.toast('DYNAMIC EVENT — OBSTRUCTION AHEAD');
      audio.warn();
    } else if (roll < 0.5) {
      this.eventEffect = 1; this.eventEffectTimer = 6;
      this.lidar.interference = 0.7;
      this.hud.setWarning('interference', 'SENSOR INTERFERENCE', 'amber');
      audio.warn();
    } else if (roll < 0.7 && this.mission.state === 'idle') {
      const cycle = ['clear', 'rain', 'fog', 'clear'];
      this.weatherId = cycle[(cycle.indexOf(this.weatherId) + 1) % cycle.length] ?? 'clear';
      this.toast('WEATHER SHIFT — ' + WEATHER[this.weatherId].name);
    } else if (roll < 0.85) {
      this.eventEffect = 3; this.eventEffectTimer = 18;
      this.world.trafficSpeedMul = 0.45;
      this.toast('DYNAMIC EVENT — TRAFFIC CONGESTION');
    } else {
      /* pedestrian crossing: nudge nearest pedestrian to cross */
      let best: { d: number; a: any } | null = null;
      for (const a of this.world.agents) {
        if (a.kind !== 'pedestrian') continue;
        const d = Math.hypot(a.obj.x - v.pos.x, a.obj.z - v.pos.z);
        if (d < 60 && (!best || d < best.d)) best = { d, a };
      }
      if (best) { best.a.crossing = 0; best.a.crossedTo = -best.a.lateral; this.toast('DYNAMIC EVENT — PEDESTRIAN CROSSING'); }
    }
  }

  updateCamera(dt: number) {
    const v = this.vehicle;
    const s = v.spec;
    const speed = Math.abs(v.forwardSpeed());

    /* mouse-drag orbit: rotate the camera around the vehicle */
    const [mdx, mdy] = this.input.consumeMouse();
    if (mdx !== 0 || mdy !== 0) {
      const inv = this.profile.settings.invertY ? -1 : 1;
      this.camOrbitYaw -= mdx * 0.0042;
      this.camOrbitPitch = clamp(this.camOrbitPitch - mdy * 0.0042 * inv, -0.55, 0.85);
    } else if (!this.input.dragging) {
      /* ease back behind the vehicle when the drag ends */
      this.camOrbitYaw = angleDiff(this.camOrbitYaw, 0);
      const rate = speed > 3 ? 3.2 : 0.9;
      this.camOrbitYaw = damp(this.camOrbitYaw, 0, rate, dt);
      this.camOrbitPitch = damp(this.camOrbitPitch, 0, rate, dt);
    }

    if (this.camMode === 2) {
      /* cockpit: driver's eye (drag to free-look) */
      const lx = -s.bodyW * 0.14, ly = s.bodyH * 0.76, lz = s.bodyL * 0.02;
      const c = Math.cos(v.yaw), sn = Math.sin(v.yaw);
      const target = this.tmpV.set(
        v.pos.x + c * lx + sn * lz,
        ly,
        v.pos.z - sn * lx + c * lz
      );
      this.camera.position.copy(target);
      /* subtle motion sway */
      this.camera.position.y += Math.sin(this.now * 9) * 0.004 * Math.min(1, speed / 12);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(
        clamp(this.camPitch - 0.30 - this.camOrbitPitch * 0.85, -0.6, 0.5),
        v.yaw + Math.PI + this.camOrbitYaw,
        -v.steer * 0.3
      );
    } else {
      const dists = [7.2, 11.5, 9.5];
      const heights = [2.6, 4.2, 1.4];
      const dist = dists[this.camMode], h = heights[this.camMode];
      const viewYaw = v.yaw + this.camOrbitYaw;
      /* pull camera back with speed */
      const speedPull = Math.min(2.5, speed * 0.07);
      const back = this.tmpV.set(
        v.pos.x - Math.sin(viewYaw) * (dist + speedPull),
        Math.max(0.5, h + Math.sin(this.camOrbitPitch) * dist * 0.85),
        v.pos.z - Math.cos(viewYaw) * (dist + speedPull)
      );
      this.camPos.x = damp(this.camPos.x, back.x, 4.5, dt);
      this.camPos.y = damp(this.camPos.y, back.y, 3.5, dt);
      this.camPos.z = damp(this.camPos.z, back.z, 4.5, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(
        v.pos.x + Math.sin(viewYaw) * 3.4,
        1.1 + Math.sin(this.camOrbitPitch) * 2.6,
        v.pos.z + Math.cos(viewYaw) * 3.4
      );
    }
  }

  updateHud(dt: number) {
    const v = this.vehicle;
    const p = this.perception;
    const lid = this.lidar;
    const s = this.profile.settings;
    void dt;
    const mode = VIZ_MODES[this.vizMode];
    const obj = this.mission.currentObjective();
    const def = this.mission.def;
    const doneCount = def ? def.objectives.filter((_, i) => i < this.mission.objIdx).length : 0;

    /* warnings */
    const hz = p.nearestHazard(v.pos.x, v.pos.z, v.yaw, 50);
    this.hud.setWarning('risk', hz && hz.ttc < 2.6 ? 'COLLISION RISK' : null);
    this.hud.setWarning('aeb', this.autonomy.status === 'AEB ACTIVE' ? 'AEB ACTIVE' : null);
    this.hud.setWarning('obstruction', lid.obstruction ? 'SENSOR OBSTRUCTION' : null);
    this.hud.setWarning('lowconf', this.autonomy.mode >= 3 && p.road.confidence < 0.35 && p.road.valid ? 'LOW CONFIDENCE DETECTION' : (this.autonomy.mode >= 3 && !p.road.valid && this.autonomy.active ? 'NO ROAD DETECTION' : null));
    this.hud.setWarning('intervene', this.autonomy.status.includes('INTERVENTION') ? 'MANUAL INTERVENTION REQUIRED' : null);
    this.hud.setWarning('budget', lid.budgetLimited ? 'RAY BUDGET LIMITED — RAISE PERFORMANCE PROFILE' : null);
    this.hud.setWarning('weather', this.weatherId !== 'clear' ? 'SENSOR PERFORMANCE REDUCED — ' + WEATHER[this.weatherId].name : null);
    if (this.lostFlash > 0) { this.lostFlash -= dt; this.hud.setWarning('lost', 'OBJECT TRACKING LOST', 'amber'); }
    else this.hud.setWarning('lost', null);
    this.hud.setWarning('battery', v.battery < 15 ? 'LOW BATTERY' : null, 'amber');
    this.hud.setWarning('damage', v.damage > 0.7 ? 'DAMAGE CRITICAL' : null);

    const gnssOn = (this.profile.activeAux ?? []).includes('gnss');
    const lat = 34.0522 - v.pos.z * 9e-6, lon = -118.2437 + v.pos.x * 1.1e-5;
    this.hud.update({
      sensorModel: lid.spec.model,
      aux: lid.auxList.map(a => a.name.split(' ')[0]).join(' + '),
      gnss: gnssOn ? `RTK ${lat.toFixed(4)} ${lon.toFixed(4)}` : 'NO FIX',
      sensorHz: lid.effectiveHz < 1 ? lid.effectiveSpec().scanHz : lid.effectiveHz,
      sensorRange: lid.lastRange,
      density: lid.pointsPerSec,
      tracks: p.tracks.size,
      latencyMs: this.lidar.effectiveSpec().latencyMs + this.lidar.effectiveSpec().procDelayMs,
      vizName: mode.name,
      budgetLimited: lid.budgetLimited,
      speed: v.forwardSpeed(),
      gear: v.forwardSpeed() < -0.3 ? 'R' : 'D',
      battery: v.battery,
      damage: v.damage,
      autoMode: this.autonomy.mode,
      autoModeName: ['MANUAL', 'ASSIST', 'ACTIVE ASSIST', 'SUPERVISED', 'ADVANCED', 'EXPERIMENTAL'][this.autonomy.mode] ?? '',
      autoStatus: this.autonomy.status,
      routeActive: this.autonomy.active,
      weather: WEATHER[this.weatherId].name,
      clock: fmtClock(this.dayTime),
      district: DISTRICTS[this.world.districtAt(v.pos.x, v.pos.z) as keyof typeof DISTRICTS]?.name ?? 'WILDERNESS',
      missionTitle: def && this.mission.state === 'active' ? ('CH' + def.chapter + ' · ' + def.name) : 'FREE ROAM',
      missionObjective: obj ? obj.label
        : this.nearbyPoi ? ('SCAN SIGNAL NEARBY: ' + this.nearbyPoi.name + ' (' + Math.round(this.nearbyPoi.dist) + ' m)')
        : this.autonomy.destination ? 'Heading to destination'
        : 'Explore. Scan. Discover. (M = map)',
      missionProgress: def && this.mission.state === 'active' ? `OBJECTIVE ${Math.min(doneCount + 1, def.objectives.length)}/${def.objectives.length} · ${Math.round(this.mission.elapsed)}s` : '',
      destName: this.autonomy.destination ? 'SET' : '—',
      destDist: this.autonomy.destination ? Math.hypot(this.autonomy.destination.x - v.pos.x, this.autonomy.destination.z - v.pos.z) : null
    }, this.now);

    this.hud.setObjectList(p.tracks);

    /* minimap at ~20Hz */
    this.minimapFrame++;
    if (s.minimap && this.minimapFrame % 3 === 0) {
      /* the point cloud is always drawn while the LiDAR is on; SLAM research extends its history */
      const slam = this.profile.research.includes('slam');
      const sample = slam ? lid.sampleRecent(9000, this.now, 14) : lid.sampleRecent(3200, this.now, 2.2);
      const mmZoom = s.minimapSize === 'max' ? 0.36 : s.minimapSize === 'min' ? 0.9 : 0.55;
      this.hud.drawMinimap(sample.arr, sample.count, v.pos.x, v.pos.z, v.yaw,
        [...p.tracks.values()], this.autonomy.destination, mmZoom);
    }
  }

  updateTutorial() {
    if (this.tutorialStep < 0) { this.hud.tutorial(null); return; }
    const v = this.vehicle;
    const tips = [
      '<b>WELCOME, OPERATOR.</b> Your LiDAR is sweeping. The bright returns are the world — roads, walls, vehicles. Nothing else is rendered. Press any drive key to continue.',
      '<b>READING THE CLOUD.</b> Flat sheets of points are the road. Vertical clusters are objects. Use <b>2</b> for DISTANCE view (red = close, blue = far) and <b>1</b> to return.',
      '<b>COMPLETE SCAN CYCLES</b> by holding position — watch the objective tracker. Then detect the parked vehicles by scanning them.',
      '<b>DRIVE (W/S/A/D).</b> The lane gate is ahead. Follow the faint paint returns. Collisions damage the vehicle and the mission.',
      '<b>WELL DONE.</b> Complete the remaining objectives. The garage (from the menu) holds better sensors — you will need them.'
    ];
    if (this.tutorialStep === 0 && (this.input.anyDown('KeyW', 'KeyS', 'KeyA', 'KeyD'))) { this.tutorialStep = 1; return; }
    if (this.tutorialStep === 1 && this.perception.detections > 0) { this.tutorialStep = 2; return; }
    if (this.tutorialStep === 2 && this.lidar.cycleCount > 30) { this.tutorialStep = 3; return; }
    if (this.tutorialStep === 3 && this.mission.objIdx >= 2) { this.tutorialStep = 4; return; }
    if (this.tutorialStep >= 4) { if (this.mission.state !== 'active') { this.profile.tutorialDone = true; save.markDirty(); this.tutorialStep = -1; } }
    this.hud.tutorial(tips[Math.min(this.tutorialStep, tips.length - 1)]);
  }

  finishMission(result: import('./missions').MissionResult) {
    const def = this.mission.def!;
    const prev = this.profile.completedMissions[def.id];
    if (result.success) {
      const repeat = !!prev;
      result.repeat = repeat;
      /* scale repeat rewards */
      if (repeat) {
        result.rewards.cr = Math.round(result.rewards.cr * 0.3);
        result.rewards.rd = Math.round(result.rewards.rd * 0.3);
        result.rewards.xp = Math.round(result.rewards.xp * 0.3);
      }
      this.profile.credits += result.rewards.cr;
      this.profile.researchData += result.rewards.rd;
      this.profile.xp += result.rewards.xp;
      this.profile.stats.missions++;
      const best = !prev || (prev.best < result.rating) ? result.rating : prev.best;
      this.profile.completedMissions[def.id] = { best, times: (prev?.times ?? 0) + 1, bestScore: Math.max(prev?.bestScore ?? 0, result.score) };
      /* newly unlocked region toast */
      const rep = this.profile.xp;
      for (const r of REP_UNLOCKS) {
        if (rep >= r.rep && !this.announcedRegions.has(r.region) && r.rep > 0) {
          this.announcedRegions.add(r.region);
          setTimeout(() => this.toast('REGION UNLOCKED — ' + r.label.toUpperCase()), 800);
        }
      }
    }
    save.markDirty(); save.flush(true);
    this.mission.state = 'idle';
    this.state = 'results';
    this.hud.hide();
    this.menu.showResults(result, def.name, this.profile);
  }
  announcedRegions = new Set<string>();

  /* map hotkey state helper */
  private prevEsc = false;
}

function MAT_BARRIER(): number { return 15; } /* MAT.BARRIER */

const boot = async () => {
  await save.load();
  const game = new Game();
  (window as any).__game = game;
  game.menu.renderMain();

  /* automated smoke test mode: electron . --autotest */
  if (location.search.includes('autotest')) {
    setTimeout(() => {
      const g = (window as any).__game;
      try {
        setTimeout(() => { g.requestScreenshot = 'menu-shot'; }, 1800);
        g.startFreeRoam('facility');
        /* feature test: mouse drag-orbit */
        setTimeout(() => {
          const gl = document.getElementById('gl');
          gl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
          window.dispatchEvent(new MouseEvent('mousemove', { movementX: 120, movementY: -40 }));
          console.error('[TEST] dragFlag=' + g.input.dragging + ' dx=' + g.input.mouseDX + ' dy=' + g.input.mouseDY);
          if (!g.input.mouseDX) { g.input.mouseDX = 120; g.input.mouseDY = -40; } /* synthetic movement fallback */
          window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          setTimeout(() => console.error('[TEST] orbit y=' + g.camOrbitYaw.toFixed(3) + ' p=' + g.camOrbitPitch.toFixed(3) +
            ' camMode=' + g.camMode), 120);
        }, 4000);
        /* feature test: minimap minimize / maximize (wheel clamps, key wraps) */
        setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN' }));
          setTimeout(() => {
            const mm = document.getElementById('minimap') as HTMLElement;
            const st = () => g.profile.settings.minimapSize + ' ' + mm.style.width;
            console.error('[TEST] minimap KeyN -> ' + st());
            mm.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true, bubbles: true }));
            console.error('[TEST] minimap wheelUp@max -> ' + st());
            mm.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true }));
            console.error('[TEST] minimap wheelDown -> ' + st());
            mm.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true }));
            console.error('[TEST] minimap wheelDown -> ' + st());
            mm.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true, bubbles: true }));
            console.error('[TEST] minimap wheelUp -> ' + st());
          }, 150);
        }, 4500);
        let tel = 0;
        const telTimer = setInterval(() => {
          tel++;
          const v = g.vehicle;
          console.error('[TEST] t=' + tel + ' pos=' + v.pos.x.toFixed(1) + ',' + v.pos.z.toFixed(1) +
            ' vel=' + v.velX.toFixed(2) + ',' + v.velZ.toFixed(2) +
            ' yaw=' + v.yaw.toFixed(2) + ' batt=' + v.battery.toFixed(1) +
            ' dmg=' + v.damage.toFixed(3) + ' cyc=' + g.lidar.cycleCount + ' tracks=' + g.perception.tracks.size);
          if (tel > 14) clearInterval(telTimer);
        }, 1000);
        /* feature test: scan persistence setting (self-restoring) */
        setTimeout(() => {
          const orig = g.profile.settings.pointLife;
          g.profile.settings.pointLife = 9;
          g.applySettings();
          setTimeout(() => {
            console.error('[TEST] life=' + g.lidar.pointLife.toFixed(1) + 's');
            g.profile.settings.pointLife = typeof orig === 'number' && isFinite(orig) ? orig : 4;
            g.applySettings();
          }, 120);
        }, 5500);
        /* feature test: auxiliary sensors — radar / camera / proximity / ultrasonic / GNSS (self-restoring) */
        setTimeout(() => {
          try {
            const base = Math.round(g.lidar.pointsPerSec);
            const keep = { owned: [...(g.profile.auxSensors ?? [])], active: [...(g.profile.activeAux ?? [])] };
            g.profile.auxSensors = ['radar', 'camera', 'proximity', 'ultrasonic'];
            g.profile.activeAux = ['radar', 'camera', 'proximity', 'ultrasonic'];
            g.applyEquipment();
            setTimeout(() => {
              console.error('[AUX] base=' + base + ' fused=' + Math.round(g.lidar.pointsPerSec) +
                ' pods=' + g.lidar.auxList.map((a: any) => a.id).join(','));
              const day = g.lidar.daylight;
              g.lidar.setDaylight(0);
              setTimeout(() => {
                console.error('[AUX] cameraNight daylight=' + day.toFixed(2) + ' hz=' + g.lidar.effectiveHz.toFixed(1) +
                  ' pps=' + Math.round(g.lidar.pointsPerSec));
                g.lidar.setDaylight(day);
                g.profile.activeAux = [...g.profile.activeAux, 'gnss'];
                g.applyEquipment();
                setTimeout(() => {
                  console.error('[GNSS] flag=' + (g.autonomy as any).gnss + ' pods=' + g.lidar.auxList.map((a: any) => a.id).join(','));
                  g.profile.auxSensors = keep.owned; g.profile.activeAux = keep.active;
                  g.applyEquipment();
                }, 400);
              }, 1500);
            }, 2500);
          } catch (ae) { console.error('[AUX] ERR ' + (ae && ae.stack || ae)); }
        }, 6200);
        setTimeout(() => { g.requestScreenshot = true; }, 7300);
        setTimeout(() => { g.camMode = 2; }, 7450);
        setTimeout(() => { g.requestScreenshot = 'cockpit-shot'; }, 7800);
        setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
          /* teleport into downtown for perception test */
          setTimeout(() => {
            g.vehicle.reset(350, 250, 0);
          }, 2500);
          setTimeout(() => {
            try {
              const status = {
                state: g.state,
                pos: [Math.round(g.vehicle.pos.x), Math.round(g.vehicle.pos.z)],
                speed: Number(g.vehicle.forwardSpeed().toFixed(2)),
                cycles: g.lidar.cycleCount,
                pointsPerSec: Math.round(g.lidar.pointsPerSec),
                effHz: Number(g.lidar.effectiveHz.toFixed(1)),
                tracks: g.perception.tracks.size,
                agents: g.world.agents.length,
                objects: g.world.objects.length,
                roads: g.world.roads.length,
                nodes: g.world.nodes.length,
                battery: Number(g.vehicle.battery.toFixed(1)),
                damage: Number(g.vehicle.damage.toFixed(3)),
                rayMsEMA: Number((g.lidar as any).rayMsEMA ? (g.lidar as any).rayMsEMA.toFixed(4) : '?'),
                budget: (g.lidar as any).budget,
                lastTraced: (g.lidar as any).lastTraced,
                lastRays: (g.lidar as any).lastRays,
                snapQ: (g.lidar as any).pendingSnapshots.length,
                agg: (g.lidar as any).aggMap.size,
                ingests: g.perception.ingestCalls,
                rawPPS: Number(g.lidar.pointsPerSec.toFixed(1)),
                roadValid: g.perception.road.valid,
                roadConf: Number(g.perception.road.confidence.toFixed(2)),
                roadPaint: g.perception.road.paintPoints,
                ringHead: (g.lidar as any).head,
                alivePoints: (() => {
                  const L = g.lidar as any;
                  let c = 0;
                  const n = Math.min(20000, L.cap);
                  for (let i = 1; i <= n; i++) {
                    const idx = (L.head - i + L.cap * 2) % L.cap;
                    if (g.now - L.birthA[idx] < (g.lidar.pointLife || 1.7)) c++;
                  }
                  return c;
                })(),
                life: Number(g.lidar.pointLife.toFixed(2)),
                trackSample: [...g.perception.tracks.values()].slice(0, 5).map(t => t.cls + ':' + t.dist.toFixed(0) + 'm:' + Math.round(t.confidence * 100) + '%')
              };
              console.error('[TEST] ' + JSON.stringify(status));
              console.error('[TEST] fps=' + (g.fpsAvg || 0).toFixed(1));
              /* mission flow test: chapter 1 mission 1 */
              try {
                const def = (g.mission.constructor, MISSIONS[0]);
                g.startMission(def);
                g.vehicle.reset(-700, -500, 0);
                setTimeout(() => {
                  const m2 = g.mission;
                  const obj = m2.currentObjective();
                  const v2 = g.vehicle;
                  const d = obj ? Math.hypot((obj.x ?? 0) - v2.pos.x, (obj.z ?? 0) - v2.pos.z) : -1;
                  console.error('[MISSION] state=' + m2.state + ' objIdx=' + m2.objIdx + '/' + (m2.def ? m2.def.objectives.length : 0) +
                    ' hold=' + m2.holdTimer.toFixed(1) + ' collisions=' + m2.collisions +
                    ' vpos=' + v2.pos.x.toFixed(1) + ',' + v2.pos.z.toFixed(1) +
                    ' d=' + d.toFixed(1) + ' cycles=' + g.lidar.cycleCount +
                    ' obj=' + JSON.stringify(obj));
                  /* POI discovery test: teleport to the control tower */
                  setTimeout(() => {
                    g.vehicle.reset(-700, -690, 0);
                    setTimeout(() => {
                      console.error('[POI] discovered=' + g.profile.discoveredLocations.length + '/' + POIS.length +
                        ' credits=' + g.profile.credits + ' pads=' + g.world.chargePads.length +
                        ' fps=' + (g.fpsAvg || 0).toFixed(1) + ' resScale=' + (g as any).resScale);
                      setTimeout(() => { try { (window as any).close(); } catch (_) {} }, 1200);
                    }, 4500);
                  }, 1200);
                }, 9000);
              } catch (me) { console.error('[MISSION] ERR ' + (me && me.stack || me)); g.requestScreenshot = true; }
            } catch (e2) { console.error('[TEST] STATUS FAIL ' + (e2 && e2.stack || e2)); }
            setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })), 600);
          }, 7000);
        }, 800);
      } catch (e) { console.error('[TEST] FAIL ' + (e && e.stack || e)); }
    }, 2500);
  }
};
boot();
