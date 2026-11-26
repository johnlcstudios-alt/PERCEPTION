/* PERCEPTION - save manager (Electron userData via preload bridge, localStorage fallback) */

export interface MissionRecord { best: string; times: number; bestScore: number; }

export interface Settings {
  quality: string; volume: number; fov: number; labels: boolean;
  minimap: boolean; minimapSize: string; sweep: boolean; camera: string; invertY: boolean;
  pointLife: number; // seconds scanned points stay visible
}

export interface Profile {
  version: number;
  credits: number;
  researchData: number;
  xp: number;
  selectedVehicle: string;
  ownedVehicles: string[];
  sensorTier: number;
  upgrades: Record<string, number>;
  research: string[];
  paint: number;
  completedMissions: Record<string, MissionRecord>;
  discoveredLocations: string[];
  tutorialDone: boolean;
  settings: Settings;
  stats: { kmDriven: number; scans: number; detections: number; missions: number; collisions: number; aeb: number };
}

export function defaultProfile(): Profile {
  return {
    version: 1,
    credits: 3000,
    researchData: 0,
    xp: 0,
    selectedVehicle: 'compact',
    ownedVehicles: ['compact'],
    sensorTier: 1,
    upgrades: {},
    research: [],
    paint: 0x2b3540,
    completedMissions: {},
    discoveredLocations: [],
    tutorialDone: false,
    settings: { quality: 'high', volume: 0.8, fov: 70, labels: true, minimap: true, minimapSize: 'normal', sweep: true, camera: 'chase', invertY: false, pointLife: 4 },
    stats: { kmDriven: 0, scans: 0, detections: 0, missions: 0, collisions: 0, aeb: 0 }
  };
}

type Host = { readSave(n: string): Promise<string | null>; writeSave(n: string, d: string): Promise<boolean> };

export class SaveManager {
  profile: Profile = defaultProfile();
  private host: Host | null = (window as any).perceptionHost ?? null;
  private dirty = false;
  private lastWrite = 0;

  async load(): Promise<Profile> {
    try {
      let raw: string | null = null;
      if (this.host) raw = await this.host.readSave('profile');
      if (!raw) raw = localStorage.getItem('perception.profile');
      if (raw) {
        const data = JSON.parse(raw);
        this.profile = { ...defaultProfile(), ...data };
        this.profile.settings = { ...defaultProfile().settings, ...(data.settings || {}) };
        this.profile.stats = { ...defaultProfile().stats, ...(data.stats || {}) };
      }
    } catch (_) { /* corrupt save -> fresh profile */ }
    return this.profile;
  }

  markDirty() { this.dirty = true; }

  async flush(force = false) {
    if (!this.dirty && !force) return;
    const now = performance.now();
    if (!force && now - this.lastWrite < 2000) return;
    this.lastWrite = now;
    this.dirty = false;
    const raw = JSON.stringify(this.profile);
    try {
      if (this.host) await this.host.writeSave('profile', raw);
      else localStorage.setItem('perception.profile', raw);
    } catch (_) {
      try { localStorage.setItem('perception.profile', raw); } catch (_2) { /* give up quietly */ }
    }
  }

  async reset(): Promise<Profile> {
    this.profile = defaultProfile();
    await this.flush(true);
    return this.profile;
  }
}

export const save = new SaveManager();
