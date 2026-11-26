/* PERCEPTION - synthesized audio engine (WebAudio, zero assets) */

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private motorGain!: GainNode;
  private motorOsc1!: OscillatorNode;
  private motorOsc2!: OscillatorNode;
  private motorFilter!: BiquadFilterNode;
  private whineOsc!: OscillatorNode;
  private whineGain!: GainNode;
  private rainGain!: GainNode;
  private windGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  enabled = true;
  volume = 0.8;
  private started = false;

  ensure() {
    if (this.started) { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new AudioContext(); } catch (_) { return; }
    this.started = true;
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.master);

    /* noise buffer */
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    /* EV motor */
    this.motorGain = ctx.createGain(); this.motorGain.gain.value = 0;
    this.motorFilter = ctx.createBiquadFilter(); this.motorFilter.type = 'lowpass'; this.motorFilter.frequency.value = 500; this.motorFilter.Q.value = 4;
    this.motorOsc1 = ctx.createOscillator(); this.motorOsc1.type = 'sawtooth'; this.motorOsc1.frequency.value = 60;
    this.motorOsc2 = ctx.createOscillator(); this.motorOsc2.type = 'triangle'; this.motorOsc2.frequency.value = 91;
    this.motorOsc1.connect(this.motorFilter); this.motorOsc2.connect(this.motorFilter);
    this.motorFilter.connect(this.motorGain); this.motorGain.connect(this.master);
    this.motorOsc1.start(); this.motorOsc2.start();

    /* inverter whine */
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    this.whineOsc = ctx.createOscillator(); this.whineOsc.type = 'sine'; this.whineOsc.frequency.value = 1200;
    this.whineOsc.connect(this.whineGain); this.whineGain.connect(this.master);
    this.whineOsc.start();

    /* rain loop */
    const rainSrc = ctx.createBufferSource(); rainSrc.buffer = this.noiseBuf; rainSrc.loop = true;
    const rainFilter = ctx.createBiquadFilter(); rainFilter.type = 'bandpass'; rainFilter.frequency.value = 5200; rainFilter.Q.value = 0.6;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    rainSrc.connect(rainFilter); rainFilter.connect(this.rainGain); this.rainGain.connect(this.master);
    rainSrc.start();

    /* wind loop */
    const windSrc = ctx.createBufferSource(); windSrc.buffer = this.noiseBuf; windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 320;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    windSrc.connect(windFilter); windFilter.connect(this.windGain); this.windGain.connect(this.master);
    windSrc.start();
  }

  setVolume(v: number) { this.volume = v; if (this.master) this.master.gain.value = v; }

  updateDrive(speed: number, throttle: number, dt: number) {
    if (!this.ctx || !this.enabled) return;
    if (!Number.isFinite(speed) || !Number.isFinite(throttle)) return;
    void dt;
    const t = this.ctx.currentTime;
    const sp = Math.abs(speed);
    const target = 0.03 + 0.05 * Math.min(1, sp / 40) + 0.05 * throttle;
    this.motorGain.gain.setTargetAtTime(this.enabled ? target : 0, t, 0.1);
    const f = 55 + sp * 3.4 + throttle * 24;
    this.motorOsc1.frequency.setTargetAtTime(f, t, 0.08);
    this.motorOsc2.frequency.setTargetAtTime(f * 1.51, t, 0.08);
    this.motorFilter.frequency.setTargetAtTime(300 + sp * 60, t, 0.15);
    this.whineGain.gain.setTargetAtTime(this.enabled ? 0.006 + Math.min(0.02, sp * 0.0006) : 0, t, 0.2);
    this.whineOsc.frequency.setTargetAtTime(900 + sp * 55, t, 0.1);
    this.windGain.gain.setTargetAtTime(this.enabled ? Math.min(0.12, sp * 0.003) : 0, t, 0.3);
  }

  setRain(v: number) { if (this.ctx && this.rainGain) this.rainGain.gain.setTargetAtTime(this.enabled ? v * 0.14 : 0, this.ctx.currentTime, 0.8); }

  private beep(freq: number, dur: number, type: OscillatorType, gain: number, slide = 0) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx; const t = ctx.currentTime;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.02);
  }

  click() { this.beep(1900, 0.05, 'sine', 0.10); }
  back() { this.beep(1100, 0.06, 'sine', 0.08); }
  scanTick() { this.beep(2400, 0.025, 'sine', 0.015); }
  detect() { this.beep(880, 0.07, 'sine', 0.05); this.beep(1320, 0.05, 'sine', 0.03); }
  warn() { this.beep(660, 0.09, 'square', 0.05); setTimeout(() => this.beep(520, 0.11, 'square', 0.05), 90); }
  aeb() { this.beep(980, 0.16, 'square', 0.07); }
  collision(strength: number) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx; const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const g = ctx.createGain();
    const v = Math.min(0.5, 0.12 + strength * 0.02);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    src.connect(f); f.connect(g); g.connect(this.sfx);
    src.start(t); src.stop(t + 0.3);
    this.beep(64, 0.3, 'sine', Math.min(0.4, 0.15 + strength * 0.015), -20);
  }
  chime(kind: 'engage' | 'disengage' | 'success' | 'fail' | 'buy' | 'unlock') {
    const seqs: Record<string, [number, number][]> = {
      engage:    [[520, 0], [660, 90], [880, 180]],
      disengage: [[880, 0], [660, 90], [520, 180]],
      success:   [[523, 0], [659, 110], [784, 220], [1047, 330]],
      fail:      [[400, 0], [320, 140], [240, 280]],
      buy:       [[700, 0], [1050, 80]],
      unlock:    [[440, 0], [554, 100], [659, 200], [880, 320]]
    };
    for (const [f, d] of seqs[kind]) setTimeout(() => this.beep(f, 0.18, 'sine', 0.08), d);
  }
  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(v ? this.volume : 0, this.ctx.currentTime, 0.05);
  }
}

export const audio = new AudioEngine();
