/* PERCEPTION - global configuration and tuning constants */

export const WORLD = {
  size: 3200,          // world extent (meters, centered on 0,0)
  gridCell: 16,        // spatial hash cell size
  groundY: 0
};

export interface QualityPreset {
  maxPoints: number;         // point cloud ring buffer capacity
  rayBudgetPerFrame: number; // max scan rays traced per rendered frame
  pointSize: number;         // base point size in px
  labels: boolean;           // 3D object labels
}

export const QUALITY: Record<string, QualityPreset> = {
  low:    { maxPoints: 60000,  rayBudgetPerFrame: 1400, pointSize: 2.0, labels: false },
  medium: { maxPoints: 150000, rayBudgetPerFrame: 3000, pointSize: 2.2, labels: false },
  high:   { maxPoints: 280000, rayBudgetPerFrame: 4800, pointSize: 2.4, labels: true  },
  ultra:  { maxPoints: 450000, rayBudgetPerFrame: 7000, pointSize: 2.6, labels: true  }
};

export const PAL = {
  bg: 0x04060b,
  fogNear: 0x0a1420,
  pointBase: [0.55, 0.86, 1.0],
  accent: 0x53e6ff,
  violet: 0x9a6bff,
  warnRed: 0xff4d5e,
  okGreen: 0x51ffa8,
  amber: 0xffc24d
};

/* weather model: multipliers applied to the simulated sensor */
export interface WeatherModel {
  id: string; name: string;
  rangeMul: number;     // detection range multiplier
  noiseMul: number;     // measurement noise multiplier
  dropout: number;      // chance a qualifying return is dropped
  fogDensity: number;   // scene fog density (visual)
  audio: number;        // rain/ambience intensity
}

export const WEATHER: Record<string, WeatherModel> = {
  clear:      { id: 'clear',      name: 'CLEAR',       rangeMul: 1.00, noiseMul: 1.00, dropout: 0.00, fogDensity: 0.0000, audio: 0.0 },
  rain:       { id: 'rain',       name: 'RAIN',        rangeMul: 0.88, noiseMul: 1.60, dropout: 0.06, fogDensity: 0.0016, audio: 0.5 },
  heavyrain:  { id: 'heavyrain',  name: 'HEAVY RAIN',  rangeMul: 0.74, noiseMul: 2.30, dropout: 0.13, fogDensity: 0.0030, audio: 1.0 },
  fog:        { id: 'fog',        name: 'FOG',         rangeMul: 0.62, noiseMul: 1.90, dropout: 0.10, fogDensity: 0.0055, audio: 0.1 },
  dust:       { id: 'dust',       name: 'DUST',        rangeMul: 0.70, noiseMul: 2.60, dropout: 0.14, fogDensity: 0.0040, audio: 0.2 }
};

/* material classes - drive raycast intensity + semantic coloring */
export const MAT = {
  ASPHALT: 0, PAINT: 1, CONCRETE: 2, GRASS: 3, DIRT: 4,
  BUILDING: 5, VEHICLE: 6, PEDESTRIAN: 7, TREE: 8, METAL: 9,
  SIGN: 10, GLASS: 11, DARK: 12, TARMAC_DARK: 13, ROCK: 14, BARRIER: 15
} as const;
export type MatId = typeof MAT[keyof typeof MAT];

export const MAT_INFO: { reflectivity: number; semantic: string; semanticColor: [number, number, number] }[] = [];
function mat(id: number, reflectivity: number, semantic: string, r: number, g: number, b: number) {
  MAT_INFO[id] = { reflectivity, semantic, semanticColor: [r, g, b] };
}
mat(MAT.ASPHALT,     0.14, 'ROAD',        0.30, 0.34, 0.55);
mat(MAT.PAINT,       0.65, 'ROAD MARK',   0.95, 0.95, 0.98);
mat(MAT.CONCRETE,    0.38, 'STRUCTURE',   0.55, 0.55, 0.58);
mat(MAT.GRASS,       0.20, 'VEGETATION',  0.25, 0.75, 0.35);
mat(MAT.DIRT,        0.16, 'TERRAIN',     0.55, 0.45, 0.30);
mat(MAT.BUILDING,    0.32, 'BUILDING',    0.45, 0.50, 0.75);
mat(MAT.VEHICLE,     0.55, 'VEHICLE',     0.20, 0.75, 1.00);
mat(MAT.PEDESTRIAN,  0.30, 'PED',         0.30, 1.00, 0.55);
mat(MAT.TREE,        0.24, 'VEGETATION',  0.30, 0.85, 0.40);
mat(MAT.METAL,       0.70, 'METAL',       0.85, 0.88, 0.95);
mat(MAT.SIGN,        0.80, 'SIGN',        1.00, 0.90, 0.40);
mat(MAT.GLASS,       0.06, 'GLASS',       0.35, 0.40, 0.45);
mat(MAT.DARK,        0.03, 'UNKNOWN',     0.20, 0.20, 0.24);
mat(MAT.TARMAC_DARK, 0.05, 'ROAD',        0.26, 0.28, 0.42);
mat(MAT.ROCK,        0.28, 'TERRAIN',     0.60, 0.58, 0.55);
mat(MAT.BARRIER,     0.50, 'BARRIER',     1.00, 0.60, 0.25);

export const REP_UNLOCKS: { rep: number; region: string; label: string }[] = [
  { rep: 0,    region: 'facility',     label: 'Test Sector (south)' },
  { rep: 80,   region: 'city',         label: 'Meridian Sector' },
  { rep: 220,  region: 'highway',      label: 'Interstate Core' },
  { rep: 420,  region: 'industrial',   label: 'Freight Sector' },
  { rep: 650,  region: 'mountain',     label: 'Ridge Pass' },
  { rep: 950,  region: 'experimental', label: 'Polar Gate (north)' }
];

export const AUTONOMY_MODES = [
  { mode: 0, name: 'MANUAL',              desc: 'Full player control. The LiDAR is only your eyes.' },
  { mode: 1, name: 'DRIVER ASSIST',       desc: 'Collision warnings, distance alerts, AEB.' },
  { mode: 2, name: 'ACTIVE ASSIST',       desc: 'Automatic braking, adaptive cruise, lane keeping.' },
  { mode: 3, name: 'SUPERVISED AUTONOMY', desc: 'Vehicle follows the route. Intervene any time.' },
  { mode: 4, name: 'ADVANCED AUTONOMY',   desc: 'Confident route completion with limited intervention.' },
  { mode: 5, name: 'EXPERIMENTAL',        desc: 'Endgame autonomy. Full navigation authority.' }
];

export const VIZ_MODES = [
  { id: 'points',    name: 'POINT CLOUD',  key: '1', research: null },
  { id: 'distance',  name: 'DISTANCE',     key: '2', research: null },
  { id: 'height',    name: 'HEIGHT',       key: '3', research: 'vizHeight' },
  { id: 'intensity', name: 'INTENSITY',    key: '4', research: 'vizIntensity' },
  { id: 'objects',   name: 'DETECTION',    key: '5', research: 'vizObjects' },
  { id: 'semantic',  name: 'SEMANTIC',     key: '6', research: 'vizSemantic' },
  { id: 'wireframe', name: 'WIREFRAME',    key: '7', research: 'vizWireframe' }
];

export const SAVE_KEY = 'perception.save.v1';
