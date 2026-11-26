/* PERCEPTION - upgrade, sensor and research catalogs */

export interface UpgradeDef {
  id: string;
  category: string;
  name: string;
  desc: string;
  maxLevel: number;
  costs: number[];
  effectText: (lvl: number) => string;
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'scanFreq', category: 'Scan Frequency', name: 'OSCILLATOR ARRAY', desc: 'Faster complete scan cycles. Fresher environment data.',
    maxLevel: 5, costs: [4000, 8500, 16000, 30000, 52000],
    effectText: (l) => `+12% scan frequency per level (now +${l * 12}%)`
  },
  {
    id: 'density', category: 'Point Density', name: 'DENSITY MODULE', desc: 'More measurement rays per cycle. Denser surfaces.',
    maxLevel: 5, costs: [5000, 10000, 19000, 35000, 60000],
    effectText: (l) => `-9% angular spacing per level (now -${l * 9}%)`
  },
  {
    id: 'channels', category: 'Point Density', name: 'VERTICAL EXPANDER', desc: 'Additional vertical scan channels. Thicker reconstruction.',
    maxLevel: 4, costs: [7000, 14000, 26000, 45000],
    effectText: (l) => `+2 scan channels per level (now +${l * 2})`
  },
  {
    id: 'range', category: 'Detection Range', name: 'RANGE OPTICS', desc: 'Detect obstacles earlier. Essential for highways.',
    maxLevel: 5, costs: [4500, 9000, 17000, 32000, 55000],
    effectText: (l) => `+14% detection range per level (now +${l * 14}%)`
  },
  {
    id: 'recognition', category: 'Object Recognition', name: 'RECOGNITION NET', desc: 'Better classification and confidence.',
    maxLevel: 4, costs: [6000, 12000, 22000, 38000],
    effectText: (l) => `Recognition quality ${(55 + l * 11).toFixed(0)}%`
  },
  {
    id: 'filtering', category: 'Environmental Filtering', name: 'WEATHER FILTER', desc: 'Rejects weather noise. Stabilizes bad conditions.',
    maxLevel: 3, costs: [8000, 15000, 27000],
    effectText: (l) => `-25% weather degradation per level (now -${l * 25}%)`
  },
  {
    id: 'aiUnit', category: 'AI Processing Unit', name: 'NEURAL ACCELERATOR', desc: 'Less processing latency. Faster reactions.',
    maxLevel: 4, costs: [7000, 13000, 24000, 42000],
    effectText: (l) => `-15% latency per level (now -${l * 15}%)`
  },
  {
    id: 'calibration', category: 'Sensor Calibration', name: 'CALIBRATION RIG', desc: 'Cleaner measurements, less noise.',
    maxLevel: 4, costs: [5000, 10000, 18000, 32000],
    effectText: (l) => `-12% measurement noise per level (now -${l * 12}%)`
  }
];

export interface ResearchDef {
  id: string;
  name: string;
  desc: string;
  costRD: number;
  costCR: number;
  req: string[];
  category: string;
}

export const RESEARCH: ResearchDef[] = [
  { id: 'vizHeight',    name: 'Elevation Mapping',      desc: 'Unlocks HEIGHT visualization mode.', costRD: 30,  costCR: 2000,  req: [], category: 'Point Cloud Processing' },
  { id: 'vizIntensity', name: 'Reflectivity Analysis',  desc: 'Unlocks INTENSITY visualization mode.', costRD: 30,  costCR: 2000,  req: [], category: 'Point Cloud Processing' },
  { id: 'vizObjects',   name: 'Object Detection Suite', desc: 'Unlocks DETECTION mode with bounding boxes.', costRD: 60, costCR: 5000, req: ['vizHeight'], category: 'Object Recognition' },
  { id: 'vizSemantic',  name: 'Semantic Segmentation',  desc: 'Unlocks SEMANTIC visualization mode.', costRD: 90, costCR: 8000, req: ['vizObjects'], category: 'Object Recognition' },
  { id: 'vizWireframe', name: 'Geometry Reconstruction', desc: 'Unlocks WIREFRAME visualization mode.', costRD: 90, costCR: 8000, req: ['vizObjects'], category: 'Point Cloud Processing' },
  { id: 'auto2',        name: 'Active Assist Stack',    desc: 'Unlocks driving MODE 2: AEB + ACC + lane keeping.', costRD: 80, costCR: 6000, req: [], category: 'Autonomous Navigation' },
  { id: 'auto3',        name: 'Supervised Autonomy',    desc: 'Unlocks driving MODE 3: route following.', costRD: 160, costCR: 14000, req: ['auto2'], category: 'Autonomous Navigation' },
  { id: 'auto4',        name: 'Advanced Autonomy',      desc: 'Unlocks driving MODE 4: assertive navigation + avoidance.', costRD: 260, costCR: 26000, req: ['auto3'], category: 'Autonomous Navigation' },
  { id: 'auto5',        name: 'Experimental Autonomy',  desc: 'Unlocks driving MODE 5: full navigation authority.', costRD: 420, costCR: 50000, req: ['auto4'], category: 'Autonomous Navigation' },
  { id: 'slam',         name: 'Scan History Mapping',   desc: 'Minimap scan history is greatly extended.', costRD: 60, costCR: 4000, req: [], category: 'Environmental Filtering' },
  { id: 'filter2',      name: 'Multi-Band Filtering',   desc: 'Environmental filter gains one extra level.', costRD: 70, costCR: 6000, req: [], category: 'Environmental Filtering' }
];

export const PAINTS: { name: string; color: number; price: number }[] = [
  { name: 'GRAPHITE', color: 0x2b3540, price: 0 },
  { name: 'CYAN PULSE', color: 0x0e4a5e, price: 800 },
  { name: 'VIOLET SHIFT', color: 0x3a2450, price: 1200 },
  { name: 'ARCTIC', color: 0xbfd8e2, price: 1200 },
  { name: 'SOLAR', color: 0x8a5a14, price: 1500 },
  { name: 'MIDNIGHT', color: 0x10141c, price: 900 }
];

/* reputation thresholds are in config REP_UNLOCKS */
export function repLevel(xp: number): number {
  if (xp >= 950) return 5;
  if (xp >= 650) return 4;
  if (xp >= 420) return 3;
  if (xp >= 220) return 2;
  if (xp >= 80) return 1;
  return 0;
}

export const RANKS = ['ROOKIE OPERATOR', 'OPERATOR', 'SPECIALIST', 'ENGINEER', 'AUTONOMOUS OPERATOR', 'MASTER OPERATOR'];
