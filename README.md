# V3H3-SynthWave64

**A code-based mathematical synthesizer — no DAWs, no samples, just code.**

V3H3-SynthWave64 is a lightweight music sequencer/synthesizer written in Node.js. Songs are written as pure JSON (defining frequencies, timing, and instrument algorithms) and rendered directly to `.wav` files using mathematical formulas, digital signal processing (DSP), and algorithmic generation.

The approach is intentionally **mathematical and raw** — treating sound generation as pure data, from sterile sine waves to heavily saturated distortion.

---

## Features

- **Multi-track polyphonic engine** — drums, bass, rhythm guitars, and leads play simultaneously
- **Code-defined instruments** — each instrument is a JavaScript function that processes `(frequency, t)` at runtime (e.g. `sin`, `sawtooth`, `square`, custom FM, noise, or anything you can write)
- **Stereo panning** — constant-power panning per track or per note, plus per-sample `panSlope` for auto-panning effects
- **Three independent slope systems** — `gainSlope`, `panSlope`, and `frequencySlope` work per-sample inside each note for smooth gain, pan, and pitch transitions
- **Per-beat drift automation** — `dGain`, `dPan`, `dFrequencyOffset` accumulate as continuous drift rates, shifting the track's state note by note
- **Chord support** — `frequency` accepts either a single number or an array for polyphonic chords in one note event
- **Drum synthesis** — kick drums (pitch-drop sine), snares (shaped noise), hi-hats (filtered noise bursts) — all generated from functions, no samples
- **Master distortion** — `tanh()` soft-clipping for rich harmonic saturation
- **Zero external dependencies** — the entire renderer uses only Node.js built-ins
- **Fully self-contained songs** — every `song.json` carries its own instrument definitions; share a single file and anyone can render it

---

## Project Structure

```
V3H3-SynthWave64/
├── generator.js          # The DSP engine — renderer and WAV writer
├── .gitignore
├── LICENSE               # MIT License
└── music/                # Your songs (local, gitignored)
    └── <songname>/
        ├── <songname>.json   # Song definition
        └── <songname>.wav    # Generated output
```

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or later)

### Create a Song

1. Create a folder inside `music/` with the same name as your song:
   ```
   music/my_first_riff/my_first_riff.json
   ```

2. Write your song definition (see [Song Format](#song-format) below).

3. Run the generator:
   ```bash
   node generator.js my_first_riff
   ```

4. Find your render at `music/my_first_riff/my_first_riff.wav`.

---

## Song Format

### Minimal Example

```json
{
  "bpm": 130,
  "masterDrive": 3.0,
  "instruments": {
    "bass": {
      "fn": "return 2.0 * ((t * frequency) % 1.0) - 1.0;",
      "continuousPhase": true
    }
  },
  "tracks": [
    {
      "instrument": "bass",
      "pan": 0,
      "notes": [
        { "frequency": 98.0, "duration": 1.0, "gain": 0.8 },
        { "frequency": 110.0, "duration": 0.5, "gain": 0.8 },
        { "duration": 0.5 },
        { "frequency": 98.0, "duration": 2.0, "gain": 1.0, "slope": -0.3 }
      ]
    }
  ]
}
```

### Top-Level Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `bpm` | number | — | Beats per minute. All `duration` values are in beats. |
| `masterDrive` | number | `3.0` | Distortion drive applied to the master mix via `tanh(x * drive)`. Higher = more saturation. |
| `instruments` | object | — | Map of instrument name → instrument definition (see below). |
| `tracks` | array | — | Array of track objects (see below). |

### Instrument Definition

Each instrument is a JavaScript function body compiled at runtime:

```json
"instrument_name": {
  "fn": "return Math.sin(2 * Math.PI * frequency * t);",
  "continuousPhase": true
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `fn` | string | — | JavaScript function body. Receives `frequency` (Hz) and `t` (seconds since note start or absolute if `continuousPhase`). Must return a value in `[-1, 1]`. |
| `continuousPhase` | boolean | `false` | If true, the oscillator phase continues across note boundaries (no phase reset). Ideal for sustained sounds. Set to `false` for drums/percussion. |

#### Waveform Examples

```javascript
// Sine
"fn": "return Math.sin(2 * Math.PI * frequency * t);"

// Sawtooth
"fn": "return 2.0 * ((t * frequency) % 1.0) - 1.0;"

// Square
"fn": "return ((t * frequency) % 1.0) < 0.5 ? 1.0 : -1.0;"

// Triangle
"fn": "return 4.0 * Math.abs(((t * frequency) % 1.0) - 0.5) - 1.0;"

// Clean guitar (plucked sine + saw blend)
"fn": "const pluck = Math.exp(-t * 8); const sine = Math.sin(2 * Math.PI * frequency * t); const saw = 2.0 * ((t * frequency) % 1.0) - 1.0; return (sine * 0.6 + saw * 0.15) * pluck;"

// Kick drum (pitch-drop sine + noise click)
"fn": "const pitchEnv = Math.exp(-t * 50); const click = Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 200); const body = Math.sin(2 * Math.PI * (45 + 180 * pitchEnv) * t) * Math.exp(-t * 12); return body + click * 0.3;"

// Snare (shaped noise)
"fn": "const noise = Math.random() * 2.0 - 1.0; const env = Math.exp(-t * 15); return noise * env;"

// Hi-hat (filtered metallic noise)
"fn": "let noise = 0; for(let i=0; i<6; i++) { noise += Math.sin(2 * Math.PI * (i * 1430 + 800) * t); } const env = Math.exp(-t * 75); return (noise / 6.0) * env;"

// Rhythm guitar (detuned sawtooth stack)
"fn": "const q = 1.5; const ok = 2.0; const w1 = 2.0 * ((t * frequency) % 1.0) - 1.0; const w2 = 2.0 * ((t * (frequency * q + 0.4)) % 1.0) - 1.0; const w3 = 2.0 * ((t * (frequency * ok - 0.3)) % 1.0) - 1.0; return (w1 + w2 * 0.7 + w3 * 0.5) / 2.2;"
```

### Track Object

```json
{
  "instrument": "bass",
  "gain": 0.8,
  "dGain": 0.2,
  "pan": 0,
  "dPan": -0.3,
  "frequencyOffset": 0,
  "frequencySlope": 50,
  "panSlope": 0.5,
  "gainSlope": -0.1,
  "notes": [...]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `instrument` | string | — | Name of an instrument defined in `instruments`. |
| `disabled` | boolean | `false` | If `true`, the track is skipped entirely — useful for temporarily muting a track without deleting it. |
| `gain` | number | `1.0` | Starting gain for this track. Drifts over time via `dGain`. |
| `dGain` | number | `0` | **Per-beat drift rate** for gain. After each note, `currentGain += dGain * noteDuration`. |
| `pan` | number | `0` | Starting pan. `-1` = full left, `0` = center, `1` = full right. Drifts via `dPan`. |
| `dPan` | number | `0` | **Per-beat drift rate** for pan. After each note, `currentPan += dPan * noteDuration`, clamped to [-1, 1]. |
| `frequencyOffset` | number | `0` | Starting frequency offset (Hz). Drifts via `dFrequencyOffset`. |
| `dFrequencyOffset` | number | `0` | **Per-beat drift rate** for frequency offset. After each note, `currentFreqOff += dFreqOff * noteDuration`. |
| `gainSlope` | number | `0` | Per-sample gain slope (gain-units per beat) applied inside each note. See also `slope` (alias). |
| `frequencySlope` | number | `0` | Per-sample frequency glide (Hz per beat). Positive = pitch up, negative = pitch down. |
| `panSlope` | number | `0` | Per-sample pan glide (pan-units per beat). Positive = sweeps right, negative = sweeps left. |
| `notes` | array | — | Array of note events and control events. |

### Note Event

```json
{ "frequency": 98.0, "duration": 1.0, "gain": 0.8, "gainSlope": -0.3, "gainOffset": 0.1, "panOffset": -0.2 }
```

| Field | Type | Default | Description |
|---|---|---|---|
| `frequency` | number or array | — | Frequency in Hz. Use an array for chords: `[82.41, 123.47, 164.81]`. Omit or set to `0` for a rest/pause. |
| `duration` | number | — | Length in beats. |
| `gain` | number | *track current* | Overrides the track's `currentGain` for this note. Then `gainSlope` ramps from here. |
| `gainOffset` | number | `0` | Static offset added to `track.currentGain` (or `note.gain` if set) for this note only. |
| `slope` | number | *track default* | **Alias for `gainSlope`** — gain change per beat. E.g. `gain: 1.0, slope: -0.5, duration: 2` ramps from 100% to 0% over 2 beats. |
| `gainSlope` | number | *track default* | Per-sample gain slope for this note only (overrides track's `gainSlope`). |
| `pan` | number | *track current* | Overrides the track's `currentPan` for this note only. |
| `panOffset` | number | `0` | Static offset added to `track.currentPan` (or `note.pan` if set) for this note only. |
| `panSlope` | number | *track default* | Per-sample pan slope for this note only (overrides track's `panSlope`). |
| `frequencyOffset` | number | `0` | Static offset added to the track's `currentFrequencyOffset` for this note only (Hz). |
| `frequencySlope` | number | *track default* | Per-sample frequency glide for this note only (overrides track's `frequencySlope`). |

### Control Event (Automation)

```json
{ "type": "control", "pan": 0.8, "gain": 0.5, "dPan": -0.3, "dGain": 0.2, "gainSlope": -0.2 }
```

Control events consume no time and produce no audio. They update the **running track state** for all subsequent notes. Absolute fields (`gain`, `pan`, `frequencyOffset`, `gainSlope`, `panSlope`, `frequencySlope`) set the current value immediately. Delta fields (`dGain`, `dPan`, `dFrequencyOffset`) accumulate into the per-beat drift rate (the track's value changes gradually note by note). The fields `slope` and `gainSlope` are aliases and can be used interchangeably.

| Field | Type | Description |
|---|---|---|
| `type` | string | Must be `"control"`. |
| `gain` | number | (optional) Sets the current gain value immediately. |
| `dGain` | number | (optional) Adds to the per-beat gain drift rate. |
| `pan` | number | (optional) Sets the current pan value immediately. |
| `dPan` | number | (optional) Adds to the per-beat pan drift rate. |
| `frequencyOffset` | number | (optional) Sets the current frequency offset immediately. |
| `dFrequencyOffset` | number | (optional) Adds to the per-beat frequency offset drift rate. |
| `slope` | number | (optional) **Alias for `gainSlope`** — sets the per-sample gain slope immediately. |
| `gainSlope` | number | (optional) Sets the per-sample gain slope immediately. |
| `panSlope` | number | (optional) Sets the per-sample pan slope immediately. |
| `frequencySlope` | number | (optional) Sets the per-sample frequency slope immediately. |

### Repeat Event

```json
{
  "type": "repeat",
  "count": 8,
  "sequence": [
    { "frequency": 1, "duration": 1.0, "gain": 0.8 },
    { "duration": 1.0 },
    { "frequency": 1, "duration": 0.5, "gain": 0.6 },
    { "frequency": 1, "duration": 0.5, "gain": 0.8 },
    { "duration": 1.0 }
  ]
}
```

Repeat events loop a sequence of sub-events a given number of times. The sequence can contain any combination of notes, pauses, and control events.

| Field | Type | Description |
|---|---|---|
| `type` | string | Must be `"repeat"`. |
| `count` | number | How many times to repeat the sequence. |
| `sequence` | array | Array of note events, control events, or nested repeats. |

Control events inside a repeat sequence modify the **running defaults** (gain, pan, frequencyOffset, slopes) — the change persists for all subsequent events, even across repeat boundaries and into the next track events. Delta fields (`dGain`, `dPan`, `dFrequencyOffset`) accumulate as per-beat drift rates.

---

## Full Example

A multi-track piece with a synth pad (chords with frequencyOffset automation), a plucked clean guitar pattern with pan automation, and a percussion track:

```json
{
  "bpm": 110,
  "masterDrive": 1.2,
  "instruments": {
    "clean_guitar": {
      "fn": "const pluck = Math.exp(-t * 6); const sine = Math.sin(2 * Math.PI * frequency * t); const saw = 2.0 * ((t * frequency) % 1.0) - 1.0; return (sine * 0.7 + saw * 0.1) * pluck;",
      "continuousPhase": false
    },
    "synth_pad": {
      "fn": "const tri = Math.abs(2.0 * ((t * frequency) % 1.0) - 1.0) * 2.0 - 1.0; const vibrato = Math.sin(2 * Math.PI * 5 * t) * 0.005; return Math.sin(2 * Math.PI * frequency * t * (1 + vibrato)) * 0.4 + tri * 0.2;",
      "continuousPhase": true
    },
    "percussion": {
      "fn": "const noise = Math.random() * 2.0 - 1.0; const click = Math.sin(2 * Math.PI * 800 * t) * Math.exp(-t * 300); return (noise * Math.exp(-t * 80) * 0.3) + (click * 0.7);",
      "continuousPhase": false
    }
  },
  "tracks": [
    {
      "instrument": "synth_pad",
      "pan": 0.0,
      "notes": [
        { "frequency": [110.00, 164.81, 220.00], "duration": 4.0, "gain": 0.3 },
        { "frequency": [130.81, 196.00, 261.63], "duration": 4.0, "gain": 0.3 },
        { "type": "control", "frequencyOffset": 0.5 },
        { "frequency": [146.83, 196.00, 293.66], "duration": 4.0, "gain": 0.3 },
        { "frequency": [110.00, 164.81, 220.00], "duration": 4.0, "gain": 0.4 }
      ]
    },
    {
      "instrument": "clean_guitar",
      "pan": -0.7,
      "notes": [
        { "frequency": 220.00, "duration": 1.0, "gain": 0.7 },
        { "frequency": 329.63, "duration": 1.0, "gain": 0.6 },
        { "frequency": 440.00, "duration": 1.0, "gain": 0.6 },
        { "frequency": 329.63, "duration": 1.0, "gain": 0.6 },

        { "type": "control", "pan": 0.7 },
        { "frequency": 261.63, "duration": 1.0, "gain": 0.7 },
        { "frequency": 392.00, "duration": 1.0, "gain": 0.6 },
        { "frequency": 523.25, "duration": 1.0, "gain": 0.6 },
        { "frequency": 392.00, "duration": 1.0, "gain": 0.6 },

        { "type": "control", "pan": -0.5 },
        { "frequency": 293.66, "duration": 1.0, "gain": 0.7 },
        { "frequency": 392.00, "duration": 1.0, "gain": 0.6 },
        { "frequency": 587.33, "duration": 1.0, "gain": 0.6 },
        { "frequency": 392.00, "duration": 1.0, "gain": 0.6 },

        { "type": "control", "pan": 0.0 },
        { "frequency": [220.00, 277.18, 329.63, 440.00], "duration": 4.0, "gain": 0.8 }
      ]
    },
    {
      "instrument": "percussion",
      "pan": 0.2,
      "notes": [
        { "duration": 4.0 },
        { "duration": 4.0 },
        { "frequency": 1, "duration": 1.0, "gain": 0.5 },
        { "frequency": 1, "duration": 1.0, "gain": 0.5 },
        { "frequency": 1, "duration": 1.0, "gain": 0.5 },
        { "frequency": 1, "duration": 1.0, "gain": 0.5 },
        { "frequency": 1, "duration": 4.0, "gain": 0.8 }
      ]
    }
  ]
}
```

This example demonstrates:
- **Chord arrays** — `synth_pad` plays 3-note chords
- **Control events** — `clean_guitar` uses `"type": "control"` to automate pan across phrases; `synth_pad` shifts frequency offset mid-song
- **Hybrid instruments** — `clean_guitar` blends sine wave with a hint of sawtooth, shaped by an exponential pluck envelope
- **Percussion** — noise-based with a click transient, gated by an exponential decay
- **Pauses** — the percussion track starts with two 4-beat rests before the rhythm enters

---

## How It Works

1. **`generator.js`** reads `music/<name>/<name>.json`
2. Instrument functions are compiled from their `"fn"` strings using `new Function()`
3. Each track is rendered independently with a persistent **track state** (`currentGain`, `currentPan`, `currentFrequencyOffset`) that drifts via per-beat `dGain`/`dPan`/`dFrequencyOffset` — plus three independent **slope** values (`gainSlope`, `panSlope`, `frequencySlope`) for per-sample interpolation inside each note
4. All tracks are summed into a master stereo buffer (additive mixing)
5. Master distortion (`tanh`) is applied for harmonic saturation
6. The signal is peak-normalized and written as a 16-bit stereo WAV file

---

## License

MIT — see [LICENSE](./LICENSE).
