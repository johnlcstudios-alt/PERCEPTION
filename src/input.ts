/* PERCEPTION - input system */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0; mouseDY = 0; wheel = 0;
  dragging = false;
  private el: HTMLElement;
  private enabled = true;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code); this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); this.released.add(e.code); });
    window.addEventListener('blur', () => { this.down.clear(); this.dragging = false; });
    el.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.el) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    /* drag-to-orbit: accumulate mouse deltas while a button is held on the game canvas */
    window.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement | null) === this.el) this.dragging = true;
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (this.dragging && document.pointerLockElement !== this.el) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  }

  setEnabled(v: boolean) { this.enabled = v; if (!v) { this.down.clear(); this.pressed.clear(); } }

  isDown(code: string): boolean { return this.enabled && this.down.has(code); }
  anyDown(...codes: string[]): boolean { for (const c of codes) if (this.isDown(c)) return true; return false; }
  justPressed(code: string): boolean { return this.enabled && this.pressed.has(code); }
  anyPressed(...codes: string[]): boolean { for (const c of codes) if (this.justPressed(c)) return true; return false; }
  justReleased(code: string): boolean { return this.enabled && this.released.has(code); }
  consumeMouse(): [number, number] { const r: [number, number] = [this.mouseDX, this.mouseDY]; this.mouseDX = 0; this.mouseDY = 0; return r; }
  consumeWheel(): number { const w = this.wheel; this.wheel = 0; return w; }
  endFrame() { this.pressed.clear(); this.released.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }

  /* driving axes */
  get throttle(): number { return this.anyDown('KeyW', 'ArrowUp') ? 1 : 0; }
  get brake(): number { return this.anyDown('KeyS', 'ArrowDown') ? 1 : 0; }
  get steer(): number {
    const l = this.anyDown('KeyA', 'ArrowLeft') ? 1 : 0;
    const r = this.anyDown('KeyD', 'ArrowRight') ? 1 : 0;
    return l - r;
  }
  get handbrake(): boolean { return this.isDown('Space'); }
}

export function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
