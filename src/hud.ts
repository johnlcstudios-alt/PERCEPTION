/* PERCEPTION - driving HUD: panels, warnings, object list, minimap */

import { Track } from './perception';
import { clamp } from './input';

export interface HudCtx {
  sensorModel: string; aux: string; sensorHz: number; sensorRange: number; density: number;
  tracks: number; latencyMs: number; vizName: string; budgetLimited: boolean;
  speed: number; gear: string; battery: number; damage: number;
  autoMode: number; autoModeName: string; autoStatus: string; routeActive: boolean;
  weather: string; clock: string; district: string; gnss: string;
  missionTitle: string; missionObjective: string; missionProgress: string;
  destName: string; destDist: number | null;
}

export class HUD {
  private el: Record<string, HTMLElement> = {};
  private objectList!: HTMLElement;
  private warningsEl!: HTMLElement;
  private minimap!: HTMLCanvasElement;
  private mmCtx: CanvasRenderingContext2D | null = null;
  private tutorialEl!: HTMLElement;
  private vizHint!: HTMLElement;
  private toastEl!: HTMLElement;
  private lastPanel = 0;
  private toastTimer = 0;
  private vizTimer = 0;

  constructor() {
    const $ = (id: string) => document.getElementById(id);
    for (const id of ['hud', 's-model', 's-aux', 's-hz', 's-range', 's-density', 's-tracks', 's-latency', 's-viz',
      'v-speed', 'v-gear', 'v-batt', 'v-batt-bar', 'v-dmg', 'v-dmg-bar',
      'a-mode', 'a-status', 'a-route', 'e-weather', 'e-time', 'e-district', 'e-gnss',
      'm-title', 'm-objective', 'm-progress', 'n-dest', 'n-dist']) {
      this.el[id] = $(id)!;
    }
    this.objectList = $('object-list')!;
    this.warningsEl = $('warnings')!;
    this.minimap = $('minimap') as HTMLCanvasElement;
    this.mmCtx = this.minimap.getContext('2d');
    this.tutorialEl = $('tutorial-tip')!;
    this.vizHint = $('viz-hint')!;
    this.toastEl = $('toast')!;
  }

  show() { this.el['hud'].classList.remove('hidden'); }
  hide() { this.el['hud'].classList.add('hidden'); }

  private warnings = new Map<string, { text: string; kind: string }>();
  setWarning(key: string, text: string | null, kind = 'red') {
    if (!text) this.warnings.delete(key);
    else this.warnings.set(key, { text, kind });
  }

  update(ctx: HudCtx, now: number) {
    /* fast items every frame */
    this.el['v-speed'].textContent = Math.abs(ctx.speed).toFixed(1);
    if (now - this.lastPanel > 0.12) {
      this.lastPanel = now;
      const e = this.el;
      e['s-model'].textContent = ctx.sensorModel;
      e['s-aux'].textContent = ctx.aux || '—';
      e['s-hz'].textContent = ctx.sensorHz.toFixed(1) + ' Hz' + (ctx.budgetLimited ? ' !' : '');
      e['s-hz'].style.color = ctx.budgetLimited ? 'var(--amber)' : '';
      e['s-range'].textContent = Math.round(ctx.sensorRange) + ' m';
      e['s-density'].textContent = Math.round(ctx.density).toLocaleString() + ' /s';
      e['s-tracks'].textContent = String(ctx.tracks);
      e['s-latency'].textContent = Math.round(ctx.latencyMs) + ' ms';
      e['s-viz'].textContent = ctx.vizName;
      e['v-gear'].textContent = ctx.gear;
      e['v-batt'].textContent = Math.round(ctx.battery) + '%';
      (e['v-batt-bar'] as HTMLElement).style.width = ctx.battery + '%';
      (e['v-batt-bar'] as HTMLElement).style.background = ctx.battery < 15 ? 'var(--red)' : ctx.battery < 35 ? 'var(--amber)' : 'var(--accent)';
      const cond = Math.round((1 - ctx.damage) * 100);
      e['v-dmg'].textContent = cond + '%';
      (e['v-dmg-bar'] as HTMLElement).style.width = cond + '%';
      (e['v-dmg-bar'] as HTMLElement).style.background = cond < 35 ? 'var(--red)' : cond < 70 ? 'var(--amber)' : 'var(--green)';
      e['a-mode'].textContent = ctx.autoMode + ' ' + ctx.autoModeName;
      e['a-status'].textContent = ctx.autoStatus;
      e['a-route'].textContent = ctx.routeActive ? 'ACTIVE' : '—';
      e['e-weather'].textContent = ctx.weather;
      e['e-time'].textContent = ctx.clock;
      e['e-district'].textContent = ctx.district;
      e['e-gnss'].textContent = ctx.gnss || '—';
      e['m-title'].textContent = ctx.missionTitle;
      e['m-objective'].textContent = ctx.missionObjective;
      e['m-progress'].textContent = ctx.missionProgress;
      e['n-dest'].textContent = ctx.destName;
      e['n-dist'].textContent = ctx.destDist === null ? '—' : Math.round(ctx.destDist) + ' m';

      /* warnings render */
      this.warningsEl.innerHTML = '';
      for (const w of this.warnings.values()) {
        const d = document.createElement('div');
        d.className = 'warning ' + w.kind;
        d.textContent = w.text;
        this.warningsEl.appendChild(d);
      }
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= 0.016;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    if (this.vizTimer > 0) {
      this.vizTimer -= 0.016;
      if (this.vizTimer <= 0) this.vizHint.style.opacity = '0';
    }
  }

  setObjectList(tracks: Map<string, Track>) {
    const arr = [...tracks.values()].filter(t => t.confidence > 0.3).sort((a, b) => a.dist - b.dist).slice(0, 7);
    if (!arr.length) {
      this.objectList.innerHTML = '<div class="obj-empty">NO TRACKS</div>';
      return;
    }
    let html = '';
    for (const t of arr) {
      const cls = t.cls === 'unknown' ? 'cls-unknown' : 'cls-' + t.cls;
      const rel = Math.hypot(t.velX, t.velZ);
      html += `<div class='obj-row'><span class='cls ${cls} ${t.hazard ? 'cls-hazard' : ''}'>${t.cls.toUpperCase()}${t.hazard ? ' !' : ''}</span>` +
        `<span class='meta'>${t.dist.toFixed(0)}m · ${rel.toFixed(1)}m/s · ${Math.round(t.confidence * 100)}%</span></div>`;
    }
    this.objectList.innerHTML = html;
  }

  drawMinimap(pts: Float32Array, ptCount: number, px: number, pz: number, yaw: number,
    tracks: Track[], dest: { x: number; z: number } | null, zoom = 0.55) {
    const ctx = this.mmCtx;
    if (!ctx) return;
    const W = 220, H = 220, cx = W / 2, cy = H / 2;
    const scale = zoom; // px per meter
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-yaw + Math.PI); // heading up
    /* scan points — the live LiDAR point cloud, always visible while the sensor is on */
    ctx.fillStyle = 'rgba(83, 230, 255, 0.5)';
    const n = Math.min(ptCount, 9000);
    for (let i = 0; i < n; i++) {
      const dx = (pts[i * 2] - px) * scale;
      const dz = (pts[i * 2 + 1] - pz) * scale;
      if (dx * dx + dz * dz > 120 * 120) continue;
      ctx.fillRect(dx - 0.5, dz - 0.5, 1.4, 1.4);
    }
    /* tracks */
    for (const t of tracks) {
      const dx = (t.x - px) * scale, dz = (t.z - pz) * scale;
      if (dx * dx + dz * dz > 110 * 110) continue;
      ctx.fillStyle = t.hazard ? '#ff4d5e' : t.cls === 'pedestrian' ? '#51ffa8' : t.dynamic ? '#53e6ff' : '#5c6b7a';
      ctx.beginPath();
      ctx.arc(dx, dz, t.hazard ? 3.4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    /* destination */
    if (dest) {
      const dx = (dest.x - px) * scale, dz = (dest.z - pz) * scale;
      ctx.strokeStyle = '#9a6bff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(dx, dz); ctx.stroke();
      const len = Math.hypot(dx, dz);
      const cl = Math.min(len, 100);
      const nx = len > 0 ? dx / len : 0, nz = len > 0 ? dz / len : 0;
      ctx.fillStyle = '#9a6bff';
      ctx.save();
      ctx.translate(nx * cl, nz * cl);
      ctx.rotate(Math.atan2(nx, -nz));
      ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4.5, 4); ctx.lineTo(-4.5, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    /* player arrow */
    ctx.fillStyle = '#e8f6ff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7); ctx.lineTo(cx + 5, cy + 6); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx - 5, cy + 6);
    ctx.closePath(); ctx.fill();
    /* border ring */
    ctx.strokeStyle = 'rgba(83,230,255,0.25)';
    ctx.beginPath(); ctx.arc(cx, cy, 105, 0, Math.PI * 2); ctx.stroke();
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this.toastTimer = 2.6;
  }

  vizFlash(name: string) {
    this.vizHint.textContent = name;
    this.vizHint.style.opacity = '1';
    this.vizTimer = 1.6;
  }

  tutorial(html: string | null) {
    if (!html) { this.tutorialEl.classList.add('hidden'); return; }
    this.tutorialEl.classList.remove('hidden');
    this.tutorialEl.innerHTML = html;
  }
}

export function fmtClock(t: number): string {
  const h = Math.floor(t) % 24;
  const m = Math.floor((t % 1) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
