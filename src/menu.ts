/* PERCEPTION - menu system: main menu, career, garage, research, settings, results */

import { Profile, save } from './save';
import { MISSIONS, MissionDef, MissionResult } from './missions';
import { SENSORS, AUX_SENSORS } from './lidar';
import { VEHICLES, VehicleSpec } from './vehicle';
import { UPGRADES, RESEARCH, PAINTS, RANKS } from './data';
import { REP_UNLOCKS, QUALITY } from './config';
import { sensorPrice, vehiclePrice, upgradeCost, upgradeMaxLevel, researchAvailable, repairCost, repLevelOf } from './economy';
import { audio } from './audio';

export interface MenuCallbacks {
  onMissionStart: (def: MissionDef) => void;
  onFreeRoam: (region: string) => void;
  onEquipmentChanged: () => void;
  onSettingsChanged: () => void;
  onProfileEdited: () => void;
  onResume: () => void;
  onRestartMission: () => void;
  onAbort: () => void;
  onResultsContinue: () => void;
  onResultsRetry: () => void;
  onResultsMenu: () => void;
}

export class MenuSystem {
  private cb: MenuCallbacks;
  profile: Profile;
  private screens: Record<string, HTMLElement> = {};
  private currentResult: MissionResult | null = null;

  constructor(profile: Profile, cb: MenuCallbacks) {
    this.profile = profile;
    this.cb = cb;
    for (const id of ['menu-screen', 'career-screen', 'garage-screen', 'research-screen', 'settings-screen', 'about-screen', 'pause-screen', 'results-screen']) {
      this.screens[id] = document.getElementById(id)!;
    }
    this.bindMainButtons();
    document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => { audio.back(); this.showScreen('menu-screen'); this.renderMain(); }));
  }

  showScreen(id: string | null) {
    for (const k of Object.keys(this.screens)) this.screens[k].classList.toggle('hidden', k !== id);
  }
  hideAll() { this.showScreen(null); }
  visible(): string | null {
    for (const k of Object.keys(this.screens)) if (!this.screens[k].classList.contains('hidden')) return k;
    return null;
  }

  private bindMainButtons() {
    const main = document.getElementById('main-buttons')!;
    main.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      audio.ensure(); audio.click();
      const action = btn.dataset.action;
      switch (action) {
        case 'continue': this.cb.onFreeRoam('__continue__'); break;
        case 'career': this.showScreen('career-screen'); this.renderCareer(); break;
        case 'freeroam': this.showScreen('career-screen'); this.renderCareer(true); break;
        case 'garage': this.showScreen('garage-screen'); this.renderGarage(); break;
        case 'research': this.showScreen('research-screen'); this.renderResearch(); break;
        case 'settings': this.showScreen('settings-screen'); this.renderSettings(); break;
        case 'about': this.showScreen('about-screen'); break;
      }
    });
    /* pause */
    document.querySelector('#pause-screen')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      audio.click();
      switch (btn.dataset.action) {
        case 'resume': this.cb.onResume(); break;
        case 'restart': this.cb.onRestartMission(); break;
        case 'abort': this.cb.onAbort(); break;
        case 'settings-pause': this.showScreen('settings-screen'); this.renderSettings(true); break;
      }
    });
    /* results */
    document.querySelector('#results-screen')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      audio.click();
      switch (btn.dataset.action) {
        case 'results-continue': this.cb.onResultsContinue(); break;
        case 'results-retry': this.cb.onResultsRetry(); break;
        case 'results-menu': this.cb.onResultsMenu(); break;
      }
    });
  }

  renderMain() {
    const p = this.profile;
    const hasProgress = p.stats.missions > 0 || p.credits !== 3000 || Object.keys(p.completedMissions).length > 0;
    (document.querySelector('[data-action="continue"]') as HTMLButtonElement).style.display = hasProgress ? '' : 'none';
    document.getElementById('menu-profile')!.innerHTML =
      `RANK <b>${RANKS[repLevelOf(p)]}</b> · <b>${p.credits.toLocaleString()}</b> CR · <b>${p.researchData}</b> RD`;
  }

  renderCareer(freeRoamMode = false) {
    const p = this.profile;
    const info = document.getElementById('career-info')!;
    info.innerHTML = freeRoamMode
      ? 'SELECT A REGION FOR FREE ROAM'
      : `<b>${p.credits.toLocaleString()}</b> CR · <b>${p.researchData}</b> RD · RANK <b>${RANKS[repLevelOf(p)]}</b>`;
    const rep = repLevelOf(p);
    const container = document.getElementById('chapters')!;
    container.innerHTML = '';

    if (freeRoamMode) {
      const box = document.createElement('div');
      box.className = 'chapter';
      box.innerHTML = '<h3>REGIONS</h3>';
      for (const r of REP_UNLOCKS) {
        const unlocked = rep >= (REP_UNLOCKS.find(u => u.region === r.region)?.rep ?? 0);
        const row = document.createElement('div');
        row.className = 'mission-row' + (unlocked ? '' : ' locked');
        row.innerHTML = `<span class='mission-name'>${r.label}</span><span class='mission-brief'>${unlocked ? 'Endless interstate — drive, scan, dodge traffic' : 'Requires ' + r.rep + ' reputation'}</span>` +
          (unlocked ? "<span class='mission-play'>DRIVE</span>" : '');
        if (unlocked) row.addEventListener('click', () => { audio.click(); this.cb.onFreeRoam(r.region); });
        box.appendChild(row);
      }
      container.appendChild(box);
      return;
    }

    const chapters = new Map<number, MissionDef[]>();
    for (const m of MISSIONS) {
      if (!chapters.has(m.chapter)) chapters.set(m.chapter, []);
      chapters.get(m.chapter)!.push(m);
    }
    let prevComplete = true;
    for (const [ch, list] of [...chapters.entries()].sort((a, b) => a[0] - b[0])) {
      const box = document.createElement('div');
      box.className = 'chapter' + (prevComplete ? '' : ' chapter-locked');
      const names = ['FIRST CONTACT', 'LEARNING TO PERCEIVE', 'INTERSTATE NAVIGATION', 'HIGH-SPEED PERCEPTION', 'ENVIRONMENTAL CHALLENGES', 'THE AUTONOMOUS FUTURE'];
      box.innerHTML = `<h3>CHAPTER ${ch} — ${names[ch - 1] ?? ''}${prevComplete ? '' : ' (LOCKED)'}</h3>`;
      for (const m of list) {
        const rec = p.completedMissions[m.id];
        const sensorOk = !m.requireSensorTier || p.sensorTier >= m.requireSensorTier;
        const unlocked = prevComplete && sensorOk;
        const row = document.createElement('div');
        row.className = 'mission-row' + (unlocked ? '' : ' locked');
        const lock = sensorOk ? '' : ` — REQUIRES ${SENSORS[m.requireSensorTier! - 1].model}`;
        row.innerHTML = `<span class='mission-name'>${m.name}</span>` +
          `<span class='mission-brief'>${m.brief}${lock}</span>` +
          `<span class='mission-record'>${rec ? rec.best : ''}</span>` +
          (unlocked ? "<span class='mission-play'>START</span>" : '');
        if (unlocked) row.addEventListener('click', () => { audio.click(); this.cb.onMissionStart(m); });
        box.appendChild(row);
      }
      container.appendChild(box);
      prevComplete = list.every(m => p.completedMissions[m.id]);
    }
  }

  renderGarage() {
    const p = this.profile;
    document.getElementById('garage-info')!.innerHTML =
      `<b>${p.credits.toLocaleString()}</b> CR · <b>${p.researchData}</b> RD`;
    const rep = repLevelOf(p);

    /* vehicles */
    const vcol = document.getElementById('garage-vehicles')!;
    vcol.innerHTML = '<h3>VEHICLES</h3>';
    for (const v of VEHICLES) {
      const owned = p.ownedVehicles.includes(v.id);
      const selected = p.selectedVehicle === v.id;
      const priceOk = p.credits >= v.price;
      const repOk = v.price === 0 || rep >= Math.min(4, Math.floor(v.price / 40000));
      const item = document.createElement('div');
      item.className = 'shop-item' + (selected ? ' active' : '');
      item.innerHTML = `<h4>${v.name}</h4><div class='desc'>${v.desc}</div>` +
        `<div class='spec'>TOP ${Math.round(v.maxSpeed * 3.6)} km/h · ACC ${v.accel} · SLOTS T${v.sensorSlots}</div>`;
      const btn = document.createElement('button');
      btn.className = 'buy-btn';
      if (owned) {
        btn.textContent = selected ? 'SELECTED' : 'SELECT';
        btn.disabled = selected;
        btn.onclick = () => { p.selectedVehicle = v.id; save.markDirty(); save.flush(); audio.click(); this.cb.onEquipmentChanged(); this.renderGarage(); };
      } else {
        btn.textContent = `BUY — ${v.price.toLocaleString()} CR`;
        btn.disabled = !priceOk || !repOk;
        btn.onclick = () => {
          p.credits -= v.price; p.ownedVehicles.push(v.id); p.selectedVehicle = v.id;
          save.markDirty(); save.flush(); audio.chime('buy');
          this.cb.onEquipmentChanged(); this.renderGarage();
        };
      }
      item.appendChild(btn);
      vcol.appendChild(item);
    }

    /* sensors */
    const scol = document.getElementById('garage-sensors')!;
    scol.innerHTML = '<h3>LiDAR SENSORS</h3>';
    const curVehicle = VEHICLES.find(v => v.id === p.selectedVehicle)!;
    for (const s of SENSORS) {
      const owned = p.sensorTier >= s.tier;
      const active = p.sensorTier === s.tier;
      const fits = s.tier <= curVehicle.sensorSlots;
      const item = document.createElement('div');
      item.className = 'shop-item' + (active ? ' active' : '');
      item.innerHTML = `<h4>${s.model} <span class='spec'>T${s.tier}</span></h4>` +
        `<div class='spec'>${s.scanHz} Hz · ${s.maxRange} m · ${s.channels}CH · ${s.azStepDeg}° · ${s.noiseM * 100 | 0}cm noise</div>` +
        (fits ? '' : "<div class='desc'>Incompatible mount — needs a vehicle with T" + s.tier + " capacity.</div>");
      const btn = document.createElement('button');
      btn.className = 'buy-btn';
      if (owned) {
        btn.textContent = fits ? (active ? 'INSTALLED' : 'INSTALL') : 'INCOMPATIBLE MOUNT';
        btn.disabled = active || !fits;
        btn.onclick = () => { p.sensorTier = s.tier; save.markDirty(); save.flush(); audio.click(); this.cb.onEquipmentChanged(); this.renderGarage(); };
      } else {
        btn.textContent = `BUY — ${s.price.toLocaleString()} CR`;
        btn.disabled = p.credits < s.price || !fits;
        btn.onclick = () => {
          p.credits -= s.price; p.sensorTier = s.tier;
          save.markDirty(); save.flush(); audio.chime('buy');
          this.cb.onEquipmentChanged(); this.renderGarage();
        };
      }
      item.appendChild(btn);
      scol.appendChild(item);
    }

    /* auxiliary sensor pods: radar / camera / proximity fusion */
    const auxHead = document.createElement('h3');
    auxHead.textContent = 'AUX SENSORS — FUSION';
    auxHead.style.marginTop = '14px';
    scol.appendChild(auxHead);
    for (const a of AUX_SENSORS) {
      const owned = (p.auxSensors ?? []).includes(a.id);
      const active = (p.activeAux ?? []).includes(a.id);
      const item = document.createElement('div');
      item.className = 'shop-item' + (active ? ' active' : '');
      item.innerHTML = `<h4>${a.name}</h4><div class='desc'>${a.desc}</div>` +
        `<div class='spec'>${a.maxRange} m · ${a.scanHz} Hz · ${a.immune >= 0.85 ? 'WEATHERPROOF' : a.immune >= 0.5 ? 'WEATHER RESISTANT' : 'NEEDS CLEAR SKIES'}</div>`;
      const btn = document.createElement('button');
      btn.className = 'buy-btn';
      if (active) {
        btn.textContent = 'ACTIVE — DISABLE';
        btn.onclick = () => {
          p.activeAux = (p.activeAux ?? []).filter(x => x !== a.id);
          save.markDirty(); save.flush(); audio.click();
          this.cb.onEquipmentChanged(); this.renderGarage();
        };
      } else if (owned) {
        btn.textContent = 'ACTIVATE';
        btn.onclick = () => {
          p.activeAux = [...(p.activeAux ?? []), a.id];
          save.markDirty(); save.flush(); audio.click();
          this.cb.onEquipmentChanged(); this.renderGarage();
        };
      } else {
        btn.textContent = `BUY — ${a.price.toLocaleString()} CR`;
        btn.disabled = p.credits < a.price;
        btn.onclick = () => {
          p.credits -= a.price;
          p.auxSensors = [...(p.auxSensors ?? []), a.id];
          p.activeAux = [...(p.activeAux ?? []), a.id];
          save.markDirty(); save.flush(); audio.chime('buy');
          this.cb.onEquipmentChanged(); this.renderGarage();
        };
      }
      item.appendChild(btn);
      scol.appendChild(item);
    }

    /* upgrades */
    const ucol = document.getElementById('garage-upgrades')!;
    ucol.innerHTML = '<h3>UPGRADES</h3>';
    for (const u of UPGRADES) {
      const lvl = p.upgrades[u.id] ?? 0;
      const max = upgradeMaxLevel(u.id, p);
      const cost = upgradeCost(u.id, p);
      const item = document.createElement('div');
      item.className = 'shop-item';
      const pips = Array.from({ length: max }, (_, i) => `<span class='upg-pip ${i < lvl ? 'on' : ''}'></span>`).join('');
      item.innerHTML = `<h4>${u.name}<span class='upg-level'>${pips}</span></h4>` +
        `<div class='desc'>${u.desc}</div><div class='spec'>${u.effectText(lvl)}</div>`;
      const btn = document.createElement('button');
      btn.className = 'buy-btn';
      if (cost === null) { btn.textContent = lvl >= max ? 'MAXED' : 'LOCKED'; btn.disabled = true; }
      else {
        btn.textContent = `UPGRADE — ${cost.toLocaleString()} CR`;
        btn.disabled = p.credits < cost;
        btn.onclick = () => {
          p.credits -= cost; p.upgrades[u.id] = lvl + 1;
          save.markDirty(); save.flush(); audio.chime('buy');
          this.cb.onEquipmentChanged(); this.renderGarage();
        };
      }
      item.appendChild(btn);
      ucol.appendChild(item);
    }

    /* customization + repair */
    const kcol = document.getElementById('garage-style')!;
    kcol.innerHTML = '<h3>CUSTOMIZATION</h3>';
    const paintBox = document.createElement('div');
    for (const paint of PAINTS) {
      const sw = document.createElement('div');
      sw.className = 'paint-swatch' + (p.paint === paint.color ? ' active' : '');
      sw.style.background = '#' + paint.color.toString(16).padStart(6, '0');
      sw.title = paint.name + (paint.price ? ` (${paint.price} CR)` : '');
      sw.onclick = () => {
        if (p.paint !== paint.color && p.credits >= paint.price) {
          p.credits -= paint.price; p.paint = paint.color;
          save.markDirty(); save.flush(); audio.chime('buy');
          this.cb.onEquipmentChanged(); this.renderGarage();
        }
      };
      paintBox.appendChild(sw);
    }
    kcol.appendChild(paintBox);
    const dmg = (window as any).__gameVehicleDamage ?? 0;
    const repair = document.createElement('div');
    repair.className = 'shop-item';
    repair.innerHTML = `<h4>REPAIR BAY</h4><div class='desc'>Restore body and sensor alignment.</div>`;
    const rbtn = document.createElement('button');
    rbtn.className = 'buy-btn';
    const rc = repairCost(p, dmg);
    rbtn.textContent = dmg > 0.01 ? `REPAIR — ${rc.toLocaleString()} CR` : 'NO DAMAGE';
    rbtn.disabled = dmg <= 0.01 || p.credits < rc;
    rbtn.onclick = () => {
      p.credits -= rc; save.markDirty(); save.flush(); audio.chime('buy');
      (window as any).__gameRepair?.();
      this.renderGarage();
    };
    repair.appendChild(rbtn);
    kcol.appendChild(repair);
  }

  renderResearch() {
    const p = this.profile;
    document.getElementById('research-info')!.innerHTML =
      `<b>${p.researchData}</b> RESEARCH DATA · <b>${p.credits.toLocaleString()}</b> CR`;
    const list = document.getElementById('research-list')!;
    list.innerHTML = '';
    for (const r of RESEARCH) {
      const done = p.research.includes(r.id);
      const avail = researchAvailable(r.id, p);
      const afford = p.researchData >= r.costRD && p.credits >= r.costCR;
      const item = document.createElement('div');
      item.className = 'research-item' + (done ? ' unlocked' : avail ? '' : ' locked');
      item.innerHTML = `<div class='cat'>${r.category}</div><h4>${r.name}</h4>` +
        `<div class='desc'>${r.desc}</div>` +
        (done ? "<div class='unlocked-tag'>✓ UNLOCKED</div>" : `<button class='buy-btn'>${r.costRD} RD + ${r.costCR.toLocaleString()} CR</button>`);
      if (!done) {
        const btn = item.querySelector('button')!;
        btn.disabled = !avail || !afford;
        btn.onclick = () => {
          p.researchData -= r.costRD; p.credits -= r.costCR;
          p.research.push(r.id);
          save.markDirty(); save.flush(); audio.chime('unlock');
          this.cb.onEquipmentChanged(); this.renderResearch();
        };
      }
      list.appendChild(item);
    }
  }

  renderSettings(fromPause = false) {
    const p = this.profile;
    const body = document.getElementById('settings-body')!;
    body.innerHTML = '';
    const row = (label: string, control: HTMLElement) => {
      const d = document.createElement('div');
      d.className = 'set-row';
      const l = document.createElement('label');
      l.textContent = label;
      d.appendChild(l); d.appendChild(control);
      body.appendChild(d);
    };
    const section = (label: string) => {
      const h = document.createElement('h3');
      h.className = 'set-section';
      h.textContent = label;
      body.appendChild(h);
    };

    section('DISPLAY & PERFORMANCE');
    const sel = document.createElement('select');
    for (const q of ['low', 'medium', 'high', 'ultra']) {
      const o = document.createElement('option');
      o.value = q; o.textContent = q.toUpperCase() + ` (${QUALITY[q].maxPoints.toLocaleString()} pts)`;
      if (p.settings.quality === q) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { p.settings.quality = sel.value; save.markDirty(); save.flush(); this.cb.onSettingsChanged(); };
    row('PERFORMANCE PROFILE', sel);

    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.value = String(p.settings.volume);
    vol.oninput = () => { p.settings.volume = parseFloat(vol.value); save.markDirty(); audio.setVolume(p.settings.volume); };
    vol.onchange = () => save.flush();
    row('MASTER VOLUME', vol);

    const fov = document.createElement('input');
    fov.type = 'range'; fov.min = '55'; fov.max = '95'; fov.step = '1'; fov.value = String(p.settings.fov);
    const fovVal = document.createElement('span'); fovVal.className = 'val'; fovVal.textContent = p.settings.fov + '°';
    fov.oninput = () => { p.settings.fov = parseInt(fov.value); fovVal.textContent = fov.value + '°'; save.markDirty(); this.cb.onSettingsChanged(); };
    const fovWrap = document.createElement('div'); fovWrap.style.display = 'flex'; fovWrap.style.gap = '8px'; fovWrap.style.alignItems = 'center';
    fovWrap.appendChild(fov); fovWrap.appendChild(fovVal);
    row('CAMERA FIELD OF VIEW', fovWrap);

    section('POINT CLOUD');
    const life = document.createElement('input');
    life.type = 'range'; life.min = '1'; life.max = '120'; life.step = '0.5';
    life.value = String(Math.min(120, Math.max(1, typeof p.settings.pointLife === 'number' && isFinite(p.settings.pointLife) ? p.settings.pointLife : 4)));
    const lifeVal = document.createElement('span'); lifeVal.className = 'val';
    const syncLife = () => {
      const forever = p.settings.pointForever === true;
      life.disabled = forever;
      lifeVal.textContent = forever ? '∞' : parseFloat(life.value).toFixed(1) + 's';
    };
    life.oninput = () => {
      p.settings.pointLife = parseFloat(life.value);
      save.markDirty(); this.cb.onSettingsChanged();
      syncLife();
    };
    life.onchange = () => save.flush();
    const lifeWrap = document.createElement('div'); lifeWrap.className = 'set-inline';
    lifeWrap.appendChild(life); lifeWrap.appendChild(lifeVal);
    row('SCAN PERSISTENCE', lifeWrap);

    const spd = document.createElement('input');
    spd.type = 'range'; spd.min = '0.25'; spd.max = '4'; spd.step = '0.05';
    spd.value = String(typeof p.settings.sweepSpeed === 'number' && isFinite(p.settings.sweepSpeed) ? Math.min(4, Math.max(0.25, p.settings.sweepSpeed)) : 1);
    const spdVal = document.createElement('span'); spdVal.className = 'val';
    const syncSpd = () => { spdVal.textContent = '×' + parseFloat(spd.value).toFixed(2); };
    spd.oninput = () => {
      p.settings.sweepSpeed = parseFloat(spd.value);
      save.markDirty(); this.cb.onSettingsChanged();
      syncSpd();
    };
    spd.onchange = () => save.flush();
    const spdWrap = document.createElement('div'); spdWrap.className = 'set-inline';
    spdWrap.appendChild(spd); spdWrap.appendChild(spdVal);
    row('SWEEP SPEED (SCAN RATE)', spdWrap);
    syncSpd();

    const forever = document.createElement('input');
    forever.type = 'checkbox'; forever.checked = p.settings.pointForever === true;
    forever.onchange = () => {
      p.settings.pointForever = forever.checked;
      save.markDirty(); save.flush(); this.cb.onSettingsChanged();
      syncLife();
    };
    row('POINT CLOUD — KEEP FOREVER', forever);
    const lifeNote = document.createElement('div');
    lifeNote.className = 'set-note';
    lifeNote.textContent = 'How long scanned points stay in the world. "Keep forever" holds the cloud until the point buffer recycles (' + (QUALITY[p.settings.quality]?.maxPoints ?? 0).toLocaleString() + ' pts). Sweep speed multiplies the sensor rotation rate — very high rates are capped by the ray budget of your performance profile.';
    body.appendChild(lifeNote);

    const check = (key: 'labels' | 'minimap' | 'sweep', label: string) => {
      const c = document.createElement('input');
      c.type = 'checkbox'; c.checked = (p.settings as any)[key];
      c.onchange = () => { (p.settings as any)[key] = c.checked; save.markDirty(); save.flush(); this.cb.onSettingsChanged(); };
      row(label, c);
    };
    check('labels', 'OBJECT LABELS / BOXES');
    check('minimap', 'SCAN MINIMAP');
    check('sweep', 'SCAN SWEEP EFFECT');

    section('OPERATOR FUNDS');
    const fundsNote = document.createElement('div');
    fundsNote.className = 'set-note';
    fundsNote.textContent = 'Debug controls — set your career resources directly. Changes apply and save immediately.';
    body.appendChild(fundsNote);
    const moneyRow = (label: string, key: 'credits' | 'researchData' | 'xp', quick: number[]) => {
      const wrap = document.createElement('div'); wrap.className = 'set-inline';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.className = 'num-in';
      inp.value = String(Math.max(0, Math.floor((p as any)[key] ?? 0)));
      const commit = () => {
        let v = Math.floor(parseFloat(inp.value));
        if (!isFinite(v) || v < 0) v = 0;
        (p as any)[key] = v;
        save.markDirty(); save.flush(); audio.click();
        this.cb.onProfileEdited();
      };
      const setBtn = document.createElement('button'); setBtn.className = 'mini-btn'; setBtn.textContent = 'SET';
      setBtn.onclick = commit;
      inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { inp.blur(); commit(); } };
      wrap.appendChild(inp); wrap.appendChild(setBtn);
      for (const q of quick) {
        const qb = document.createElement('button'); qb.className = 'mini-btn ghost';
        qb.textContent = '+' + q.toLocaleString();
        qb.onclick = () => {
          (p as any)[key] = Math.max(0, Math.floor((p as any)[key] ?? 0)) + q;
          inp.value = String(Math.floor((p as any)[key]));
          save.markDirty(); save.flush(); audio.click();
          this.cb.onProfileEdited();
        };
        wrap.appendChild(qb);
      }
      row(label, wrap);
    };
    moneyRow('CREDITS (MONEY)', 'credits', [10000, 100000]);
    moneyRow('RESEARCH DATA (RD)', 'researchData', [100, 500]);
    moneyRow('EXPERIENCE (XP / RANK)', 'xp', [500, 2000]);

    const unlockAll = document.createElement('button');
    unlockAll.className = 'mini-btn wide';
    unlockAll.textContent = 'UNLOCK ALL RESEARCH';
    unlockAll.onclick = () => {
      let added = 0;
      for (const r of RESEARCH) if (!p.research.includes(r.id)) { p.research.push(r.id); added++; }
      save.markDirty(); save.flush();
      if (added > 0) audio.chime('unlock'); else audio.click();
      this.cb.onProfileEdited();
    };
    row('RESEARCH LAB', unlockAll);

    const danger = document.createElement('div');
    danger.className = 'danger-zone';
    const reset = document.createElement('button');
    reset.textContent = 'RESET ALL PROGRESS';
    reset.onclick = () => {
      if (confirm('Erase all progress, vehicles, credits and research?')) {
        save.reset().then(() => location.reload());
      }
    };
    danger.appendChild(reset);
    body.appendChild(danger);

    /* back button behavior when opened from pause */
    const back = document.querySelector('#settings-screen [data-back]') as HTMLElement;
    back.onclick = () => {
      audio.back();
      if (fromPause) { this.showScreen('pause-screen'); }
      else { this.showScreen('menu-screen'); this.renderMain(); }
    };
  }

  showResults(r: MissionResult, missionName: string, profile: Profile) {
    this.currentResult = r;
    const ratingEl = document.getElementById('r-rating')!;
    ratingEl.textContent = r.success ? r.rating : '✕';
    ratingEl.className = 'results-rating' + (r.success ? '' : ' fail');
    document.getElementById('r-title')!.textContent = r.success ? missionName + ' — COMPLETE' : missionName + ' — FAILED';
    const grid = document.getElementById('r-grid')!;
    if (r.success) {
      grid.innerHTML = `
        <span>SCORE</span><b>${r.score}</b>
        <span>TIME</span><b>${r.time.toFixed(1)}s</b>
        <span>COLLISIONS</span><b>${r.collisions}</b>
        <span>CREDITS</span><b>+ ${r.rewards.cr.toLocaleString()}</b>
        <span>RESEARCH DATA</span><b>+ ${r.rewards.rd}</b>
        <span>EXPERIENCE</span><b>+ ${r.rewards.xp}</b>`;
    } else {
      grid.innerHTML = `<span>REASON</span><b>${r.reason}</b><span>TIME</span><b>${r.time.toFixed(1)}s</b>`;
    }
    this.showScreen('results-screen');
    if (r.success) audio.chime('success'); else audio.chime('fail');
  }

  showPause() { this.showScreen('pause-screen'); }
  get lastResult(): MissionResult | null { return this.currentResult; }
}
