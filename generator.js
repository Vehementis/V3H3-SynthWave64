// ============================================================
// V3H3-SynthWave64 — Multi-Track Polyphonic Engine
// ============================================================
const fs = require('fs');
const path = require('path');

// ============================================================
// Constants
// ============================================================
const SAMPLE_RATE = 44100;
const MAX_AMP = 32760;

// ============================================================
// Instrument resolution — instruments are defined as JS
// function bodies in song.json and compiled at runtime.
// Each receives (frequency, t) and must return [-1, 1].
// Returns { fn, continuousPhase } for each instrument.
// ============================================================
function resolveInstruments(instruments) {
  const resolved = {};
  for (const [name, def] of Object.entries(instruments)) {
    try {
      resolved[name] = {
        fn: new Function('frequency', 't', def.fn),
        continuousPhase: def.continuousPhase === true
      };
    } catch (err) {
      console.warn(`⚠ Failed to compile instrument "${name}", falling back to silence: ${err.message}`);
      resolved[name] = { fn: () => 0, continuousPhase: false };
    }
  }
  return resolved;
}

// ============================================================
// Load song.json
// ============================================================
function loadSong(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

// ============================================================
// Envelope — attack / release ramps
// ============================================================
function applyEnvelope(samples, sampleRate, attackTime = 0.02, releaseTime = 0.05) {
  const numSamples = samples.length;
  const attackLen = Math.min(Math.floor(sampleRate * attackTime), numSamples);
  const releaseLen = Math.min(Math.floor(sampleRate * releaseTime), numSamples);

  for (let i = 0; i < attackLen; i++) {
    samples[i] *= i / attackLen;
  }
  for (let i = 0; i < releaseLen; i++) {
    const idx = numSamples - 1 - i;
    samples[idx] *= i / releaseLen;
  }
  return samples;
}

// ============================================================
// Distortion — Soft Clipping via tanh (Master Bus)
// Processes stereo master { left, right } in-place.
// ============================================================
function applyMasterDistortion(master, drive = 3.0) {
  for (let i = 0; i < master.left.length; i++) {
    master.left[i] = Math.tanh(master.left[i] * drive);
    master.right[i] = Math.tanh(master.right[i] * drive);
  }
  return master;
}

// ============================================================
// Render a single note using an instrument function
// Applies per-sample gain-slope, frequency-slope (glide),
// and pan-slope (auto-panning).
// All slope values are in units-per-beat (BPM-independent).
// All starting values come from noteState (resolved at note onset).
// If frequency is missing/0, produces silence (pause/rest).
// frequency can be a single number or an array of numbers (chord).
// timeOffset (seconds) is added to t — used for continuousPhase.
// For continuousPhase instruments, phase accumulates per sample.
// Returns { left: Float64Array, right: Float64Array }.
// ============================================================
function renderNote(instrumentFn, note, sampleRate, secondsPerBeat, timeOffset = 0, continuousPhase = false, noteState = {}) {
  const durationSec = note.duration * secondsPerBeat;
  const numSamples = Math.floor(sampleRate * durationSec);
  const bufL = new Float64Array(numSamples);
  const bufR = new Float64Array(numSamples);

  const isPause = !note.frequency || (Array.isArray(note.frequency) && note.frequency.length === 0);
  const frequencies = Array.isArray(note.frequency) ? note.frequency : [note.frequency];

  // All starting values come from resolved noteState
  const startGain = noteState.gain;
  const startPan = noteState.pan;
  const gainSlope = noteState.gainSlope || 0;
  const frequencySlope = noteState.frequencySlope || 0;
  const panSlope = noteState.panSlope || 0;
  const pSlopePerSample = panSlope / (sampleRate * secondsPerBeat);

  // Per-sample accumulators
  let phase = 0;
  let currentPan = startPan;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beats = t / secondsPerBeat;

    // Per-sample pan sweep
    currentPan += pSlopePerSample;
    const clampedPan = Math.max(-1.0, Math.min(1.0, currentPan));
    const angle = (clampedPan + 1) * Math.PI / 4;
    const panL = Math.cos(angle);
    const panR = Math.sin(angle);

    if (!isPause) {
      let sample = 0;
      for (let f = 0; f < frequencies.length; f++) {
        const freq = frequencies[f] + frequencySlope * beats;
        if (continuousPhase) {
          phase += (2 * Math.PI * freq) / sampleRate;
          sample += instrumentFn(freq, phase / (2 * Math.PI * freq));
        } else {
          sample += instrumentFn(freq, timeOffset + t);
        }
      }
      bufL[i] = sample * panL;
      bufR[i] = sample * panR;
    }

    // gain(t) = startGain + gainSlope * beats, clamped to [0, 2]
    let g = startGain + gainSlope * beats;
    if (g < 0) g = 0;
    if (g > 2) g = 2;

    bufL[i] *= g;
    bufR[i] *= g;
  }

  applyEnvelope(bufL, sampleRate);
  applyEnvelope(bufR, sampleRate);
  return { left: bufL, right: bufR };
}

// ============================================================
// Constant-power panning: pan ∈ [-1, 1]
// ============================================================
function panGains(pan) {
  const angle = (pan + 1) * Math.PI / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

// ============================================================
// Update track state from a control event.
// Absolute fields (gain, pan, frequencyOffset, gainSlope,
// panSlope, frequencySlope) set the current track values.
// Delta fields (dGain, dPan, dFrequencyOffset) accumulate
// the per-beat drift rate.
// ============================================================
function updateTrackState(trackState, note) {
  // Absolute overrides → set current value
  if (note.pan !== undefined) trackState.currentPan = clamp(note.pan, -1, 1);
  if (note.gain !== undefined) trackState.currentGain = clamp(note.gain, 0, 2);
  if (note.frequencyOffset !== undefined) trackState.currentFrequencyOffset = note.frequencyOffset;
  if (note.gainSlope !== undefined) trackState.currentGainSlope = note.gainSlope;
  if (note.panSlope !== undefined) trackState.currentPanSlope = note.panSlope;
  if (note.frequencySlope !== undefined) trackState.currentFrequencySlope = note.frequencySlope;
  // Backward compat: "slope" on a control event sets gainSlope
  if (note.slope !== undefined) trackState.currentGainSlope = note.slope;

  // Per-beat drift rates → accumulate
  if (note.dGain !== undefined) trackState.dGain = (trackState.dGain || 0) + note.dGain;
  if (note.dPan !== undefined) trackState.dPan = clamp((trackState.dPan || 0) + note.dPan, -1, 1);
  if (note.dFrequencyOffset !== undefined) trackState.dFrequencyOffset = (trackState.dFrequencyOffset || 0) + note.dFrequencyOffset;
}

// ============================================================
// Resolve a note's effective state from the track's current values.
//
// - Note-level absolute fields (gain, pan, gainSlope, panSlope,
//   frequencySlope) override the track's current value for this note.
// - Note-level offset fields (gainOffset, panOffset, frequencyOffset)
//   are static offsets added to the track's current value.
// - Note-level "slope" is a backward-compat alias for gainSlope.
// ============================================================
function getNoteState(trackState, note) {
  return {
    gain: clamp(
      (note.gain !== undefined ? note.gain : trackState.currentGain) + (note.gainOffset || 0),
      0, 2
    ),
    pan: clamp(
      (note.pan !== undefined ? note.pan : trackState.currentPan) + (note.panOffset || 0),
      -1, 1
    ),
    frequencyOffset: trackState.currentFrequencyOffset + (note.frequencyOffset || 0),
    gainSlope: note.gainSlope !== undefined ? note.gainSlope : (note.slope !== undefined ? note.slope : trackState.currentGainSlope),
    panSlope: note.panSlope !== undefined ? note.panSlope : trackState.currentPanSlope,
    frequencySlope: note.frequencySlope !== undefined ? note.frequencySlope : trackState.currentFrequencySlope
  };
}

// ============================================================
// Clamp a number between min and max.
// ============================================================
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ============================================================
// Helper: process an array of note/control/repeat events.
// Recursively handles repeat blocks with shared mutable state.
// ============================================================
function processNotes(notes, instrumentFn, continuousPhase, sampleRate, secondsPerBeat, trackState, left, right, cursorObj, trackTimeObj) {
  for (const note of notes) {
    // --- Control event (automation) ---
    if (note.type === 'control') {
      updateTrackState(trackState, note);
      continue;
    }

    // --- Repeat event ---
    if (note.type === 'repeat') {
      for (let r = 0; r < note.count; r++) {
        processNotes(note.sequence, instrumentFn, continuousPhase, sampleRate, secondsPerBeat, trackState, left, right, cursorObj, trackTimeObj);
      }
      continue;
    }

    // --- Regular note ---
    const noteLen = Math.floor(sampleRate * note.duration * secondsPerBeat);
    const timeOffset = continuousPhase ? trackTimeObj.value : 0;

    const noteState = getNoteState(trackState, note);
    const freqOff = noteState.frequencyOffset;
    let adjustedNote;
    if (freqOff && note.frequency) {
      if (Array.isArray(note.frequency)) {
        adjustedNote = { ...note, frequency: note.frequency.map(f => f + freqOff) };
      } else {
        adjustedNote = { ...note, frequency: note.frequency + freqOff };
      }
    } else {
      adjustedNote = note;
    }

    const stereo = renderNote(instrumentFn, adjustedNote, sampleRate, secondsPerBeat, timeOffset, continuousPhase, noteState);

    for (let i = 0; i < stereo.left.length && cursorObj.value + i < left.length; i++) {
      left[cursorObj.value + i] += stereo.left[i];
      right[cursorObj.value + i] += stereo.right[i];
    }
    cursorObj.value += noteLen;
    trackTimeObj.value += note.duration * secondsPerBeat;

    // Apply per-beat delta accumulation — track current values drift over time
    const beats = note.duration;
    trackState.currentGain += trackState.dGain * beats;
    trackState.currentPan = Math.max(-1.0, Math.min(1.0, trackState.currentPan + (trackState.dPan * beats)));
    trackState.currentFrequencyOffset += trackState.dFrequencyOffset * beats;
  }
}

// ============================================================
// Render one track into stereo { left, right } buffers
// If the instrument has continuousPhase=true, the oscillator
// phase is preserved across note boundaries (including pauses).
// Track state tracks currentGain/currentPan/currentFrequencyOffset
// which drift over time via per-beat dGain/dPan/dFrequencyOffset.
// Three independent slope values (gainSlope, panSlope, frequencySlope)
// work per-sample within each note for smooth transitions.
// Elements with "type": "control" update running defaults;
// elements with "type": "repeat" loop a sequence count times.
// ============================================================
function renderTrack(track, instrumentFn, continuousPhase, sampleRate, secondsPerBeat) {
  let totalSec = 0;
  for (const n of track.notes) {
    if (n.type === 'control') continue;
    if (n.type === 'repeat') {
      let seqSec = 0;
      for (const s of n.sequence) {
        if (s.type === 'control') continue;
        seqSec += s.duration * secondsPerBeat;
      }
      totalSec += seqSec * n.count;
      continue;
    }
    totalSec += n.duration * secondsPerBeat;
  }

  const totalSamples = Math.ceil(sampleRate * totalSec);
  const left = new Float64Array(totalSamples);
  const right = new Float64Array(totalSamples);

  // Track state: current values drift via dX per-beat rates.
  // Slopes (gainSlope, panSlope, frequencySlope) work per-sample
  // inside renderNote and do NOT affect the track-level state.
  const trackState = {
    currentGain: track.gain !== undefined ? track.gain : 1.0,
    currentPan: track.pan || 0,
    currentFrequencyOffset: track.frequencyOffset || 0,
    currentGainSlope: track.gainSlope !== undefined ? track.gainSlope : (track.slope || 0),
    currentPanSlope: track.panSlope || 0,
    currentFrequencySlope: track.frequencySlope || 0,
    dGain: track.dGain || 0,
    dPan: track.dPan || 0,
    dFrequencyOffset: track.dFrequencyOffset || 0
  };

  const cursorObj = { value: 0 };
  const trackTimeObj = { value: 0 };

  processNotes(track.notes, instrumentFn, continuousPhase, sampleRate, secondsPerBeat, trackState, left, right, cursorObj, trackTimeObj);

  return { left, right };
}

// ============================================================
// Render the full song — mix all tracks into stereo master
// ============================================================
function renderSong(song, sampleRate) {
  const beatsPerSecond = song.bpm / 60.0;
  const secondsPerBeat = 1.0 / beatsPerSecond;

  // Resolve instrument names → compiled functions from JSON
  const resolved = resolveInstruments(song.instruments);

  // Find the longest track for total duration (skip control events, handle repeats)
  let totalSec = 0;
  for (const track of song.tracks) {
    if (track.disabled) continue;
    let trackSec = 0;
    for (const n of track.notes) {
      if (n.type === 'control') continue;
      if (n.type === 'repeat') {
        let seqSec = 0;
        for (const s of n.sequence) {
          if (s.type === 'control') continue;
          seqSec += s.duration * secondsPerBeat;
        }
        trackSec += seqSec * n.count;
        continue;
      }
      trackSec += n.duration * secondsPerBeat;
    }
    if (trackSec > totalSec) totalSec = trackSec;
  }

  const totalSamples = Math.ceil(sampleRate * totalSec);
  const master = { left: new Float64Array(totalSamples), right: new Float64Array(totalSamples) };

  // Render each track independently, then sum into master
  for (const track of song.tracks) {
    if (track.disabled) {
      console.log(`  - Track "${track.instrument}" (disabled)`);
      continue;
    }
    const inst = resolved[track.instrument];
    if (!inst) {
      console.warn(`⚠ Unknown instrument "${track.instrument}", skipping track`);
      continue;
    }
    const trackBuf = renderTrack(track, inst.fn, inst.continuousPhase, sampleRate, secondsPerBeat);
    for (let i = 0; i < trackBuf.left.length && i < totalSamples; i++) {
      master.left[i] += trackBuf.left[i];
      master.right[i] += trackBuf.right[i];
    }
    console.log(`  ✓ Track "${track.instrument}": ${track.notes.filter(n => n.type !== 'control').length} notes, pan ${track.pan || 0}, ${(trackBuf.left.length / sampleRate).toFixed(2)}s`);
  }

  return master;
}

// ============================================================
// Normalization (peak-based) — stereo { left, right }
// ============================================================
function normalize(master, ceiling = 0.95) {
  let maxAbs = 0;
  for (let i = 0; i < master.left.length; i++) {
    const a = Math.abs(master.left[i]);
    const b = Math.abs(master.right[i]);
    if (a > maxAbs) maxAbs = a;
    if (b > maxAbs) maxAbs = b;
  }
  if (maxAbs < 1e-12) return master;
  const scale = ceiling / maxAbs;
  for (let i = 0; i < master.left.length; i++) {
    master.left[i] *= scale;
    master.right[i] *= scale;
  }
  return master;
}

// ============================================================
// WAV writer (stereo 16-bit PCM, interleaved)
// ============================================================
function writeWAV(filePath, master, sampleRate) {
  const numChannels = 2;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample >> 3);
  const byteRate = sampleRate * blockAlign;
  const numFrames = master.left.length;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  // fmt
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  // data
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  // Interleave: L, R, L, R, ...
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, master.left[i]));
    const r = Math.max(-1, Math.min(1, master.right[i]));
    buf.writeInt16LE(Math.round(l * MAX_AMP), off);
    buf.writeInt16LE(Math.round(r * MAX_AMP), off + 2);
    off += 4;
  }

  fs.writeFileSync(filePath, buf);
  console.log(`✓ Wrote ${filePath}  (${numFrames} frames, ${(numFrames / sampleRate).toFixed(2)}s, stereo ${bitsPerSample}-bit)`);
}

// ============================================================
// Main
// ============================================================
function main() {
  const songName = process.argv[2];
  if (!songName) {
    console.error('Usage: node generator.js <songname>');
    console.error('  Creates <songname>/<songname>.json → <songname>/<songname>.wav');
    process.exit(1);
  }

  const folder = path.join(__dirname, 'music', songName);
  const jsonPath = path.join(folder, `${songName}.json`);
  const wavPath = path.join(folder, `${songName}.wav`);

  if (!fs.existsSync(jsonPath)) {
    console.error(`✗ Song not found: ${jsonPath}`);
    process.exit(1);
  }

  const song = loadSong(jsonPath);
  const drive = song.masterDrive !== undefined ? song.masterDrive : 3.0;
  console.log(`Loaded song: ${song.bpm} BPM`);
  console.log(`Instruments: ${Object.keys(song.instruments).join(', ')}`);
  console.log(`Tracks: ${song.tracks.length}`);
  console.log(`Master Drive: ${drive}`);

  let master = renderSong(song, SAMPLE_RATE);
  console.log(`\nRendered ${master.left.length} frames (${(master.left.length / SAMPLE_RATE).toFixed(2)}s)`);

  // Distortion on the mixed master (both channels)
  master = applyMasterDistortion(master, drive);
  // Normalize before export (peak across both channels)
  master = normalize(master);

  writeWAV(wavPath, master, SAMPLE_RATE);
}

main();
