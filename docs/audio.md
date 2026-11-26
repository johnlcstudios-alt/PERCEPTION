# Audio

**Source:** `src/audio.ts`

All sound is synthesized at runtime with the Web Audio API. There are **no audio assets** in the
repository — the EV drivetrain, scan ticks, detection blips, AEB alarm, collisions and weather
ambience are all generated from oscillators and a noise buffer.

## Tech stack

- **Web Audio API** — `AudioContext`, `GainNode`, `OscillatorNode`, `BiquadFilterNode`,
  `AudioBufferSourceNode`.
- A single 2-second white-noise `AudioBuffer` reused for rain, wind and impacts.
- Lazy initialization on the first user gesture (browser autoplay policy).
- One exported singleton: `audio`.

## Signal graph

```
motorOsc1 (sawtooth 60 Hz) ┐
motorOsc2 (triangle 91 Hz) ├─► lowpass (Q=4) ─► motorGain ─┐
                           ┘                               │
whineOsc (sine 1200 Hz) ────► whineGain ────────────────────┤
noiseBuf ─► bandpass 5.2 kHz ─► rainGain ───────────────────┤► master ─► destination
noiseBuf ─► lowpass 320 Hz ───► windGain ───────────────────┤
beeps / impacts ─────────────► sfx ─────────────────────────┘
```

- `master` gain = user volume; `setEnabled(false)` ramps it to 0 without stopping nodes.
- Engine pitch tracks speed and throttle; filter cutoff opens with speed.
- Inverter whine adds a faint high-frequency EV character.

## Drivetrain

`updateDrive(speed, throttle, dt)` is called every frame by `Vehicle.update()`:

| Parameter | Mapping |
|-----------|---------|
| Motor gain | `0.03 + 0.05·min(1, speed/40) + 0.05·throttle` |
| Motor base frequency | `55 + speed·3.4 + throttle·24` Hz |
| Second oscillator | 1.51× base (detuned fifth-ish) |
| Filter cutoff | `300 + speed·60` Hz |
| Whine gain | `0.006 + min(0.02, speed·0.0006)` |
| Whine frequency | `900 + speed·55` Hz |
| Wind gain | `min(0.12, speed·0.003)` |

All values use `setTargetAtTime` for smooth glide; non-finite inputs are ignored.

## Sound effects

| Method | Sound |
|--------|-------|
| `click()` | 1900 Hz sine blip — UI confirm |
| `back()` | 1100 Hz sine blip — UI back |
| `scanTick()` | 2400 Hz, 25 ms, very quiet — LiDAR scan |
| `detect()` | 880 + 1320 Hz pair — new object confirmed |
| `warn()` | Two square-wave pulses — hazard warning |
| `aeb()` | 980 Hz square, 160 ms — emergency braking |
| `collision(strength)` | Filtered noise burst + 64 Hz thump, scaled by impact |
| `chime(kind)` | Sequenced notes for `engage`, `disengage`, `success`, `fail`, `buy`, `unlock` |

One-shot sounds create a short oscillator/noise chain, ramp gain up over 8 ms and exponentially
down, then self-stop. Nodes are not pooled; the volume of simultaneous sounds is low.

## Weather ambience

`setRain(v)` maps the current weather's `audio` value (0–1 from `WEATHER` in `config.ts`) to the
rain bus gain with a slow 0.8 s ramp. Wind is speed-driven instead of weather-driven.

## Lifecycle

- `ensure()` constructs the context and graph once; subsequent calls resume a suspended context.
- `setVolume(v)` and `setEnabled(v)` are safe before initialization (guarded).
- All synthesis methods early-return when the context is missing, disabled, or the game is muted.
- Settings UI persists `volume` in the profile and calls `setVolume` on change.

## Why synthesized

- Zero download size and no licensing for audio assets.
- Engine sound can track physical parameters continuously instead of looping samples.
- Impacts scale with real collision severity.

## Related documentation

- [Vehicle](vehicle.md) — calls `updateDrive` and `collision`
- [UI](ui.md) — volume settings and menu feedback
- [World engine](world-engine.md) — weather model feeding ambience
