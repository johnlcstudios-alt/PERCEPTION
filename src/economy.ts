/* PERCEPTION - economy helpers: pricing, rewards, rating math */

import { Profile } from './save';
import { SENSORS } from './lidar';
import { VEHICLES } from './vehicle';
import { UPGRADES, RESEARCH, repLevel } from './data';

export interface MissionRewards { cr: number; rd: number; xp: number; }

export function ratingFromScore(score: number): 'C' | 'B' | 'A' | 'S' {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 58) return 'B';
  return 'C';
}

export function ratingMultiplier(r: string): number {
  return r === 'S' ? 1.5 : r === 'A' ? 1.25 : r === 'B' ? 1.0 : 0.7;
}

export function applyRewards(p: Profile, rw: MissionRewards, repeat: boolean) {
  const m = repeat ? 0.3 : 1;
  p.credits += Math.round(rw.cr * m);
  p.researchData += Math.round(rw.rd * m);
  p.xp += Math.round(rw.xp * m);
}

export function sensorPrice(tier: number): number {
  return SENSORS[tier - 1].price;
}

export function vehiclePrice(id: string): number {
  return VEHICLES.find(v => v.id === id)?.price ?? 0;
}

export function upgradeCost(id: string, p: Profile): number | null {
  const def = UPGRADES.find(u => u.id === id);
  if (!def) return null;
  const lvl = p.upgrades[id] ?? 0;
  if (lvl >= def.maxLevel) return null;
  return def.costs[lvl];
}

export function upgradeMaxLevel(id: string, p: Profile): number {
  const def = UPGRADES.find(u => u.id === id);
  if (!def) return 0;
  let max = def.maxLevel;
  if (id === 'filtering' && p.research.includes('filter2')) max += 1;
  return max;
}

export function researchAvailable(id: string, p: Profile): boolean {
  const def = RESEARCH.find(r => r.id === id);
  if (!def || p.research.includes(id)) return false;
  return def.req.every(q => p.research.includes(q));
}

export function repairCost(p: Profile, damage: number): number {
  return Math.round(damage * 1200);
}

export function repLevelOf(p: Profile): number {
  return repLevel(p.xp);
}
