// ============================================================
// DSP Metal Synthesizer — Multi-Track Polyphonic Engine
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
// Applies per-sample gain + slope envelope.
// slope is in gain-units per beat (BPM-independent).
// If frequency is missing/0, produces silence (pause/rest).
// frequency can be a single number or an array of numbers (chord).
// timeOffset (seconds) is added to t — used for continuousPhase.
// ============================================================
function renderNote(instrumentFn, note, sampleRate, secondsPerBeat, timeOffset = 0) {
  const durationSec = note.duration * secondsPerBeat;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buf = new Float64Array(numSamples);

  const isPause = !note.frequency || (Array.isArray(note.frequency) && note.frequency.length === 0);
  const frequencies = Array.isArray(note.frequency) ? note.frequency : [note.frequency];
  const startGain = note.gain !== undefined ? note.gain : 1.0;
  const slope = note.slope || 0;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;

    if (!isPause) {
      // Sum all frequencies in the chord
      let sample = 0;
      for (let f = 0; f < frequencies.length; f++) {
        sample += instrumentFn(frequencies[f], timeOffset + t);
      }
      buf[i] = sample;
    }

    // gain(t) = start + slope * beats, clamped to [0, 2]
    let g = startGain + slope * (t / secondsPerBeat);
    if (g < 0) g = 0;
    if (g > 2) g = 2;

    buf[i] *= g;
  }

  applyEnvelope(buf, sampleRate);
  return buf;
}

// ============================================================
// Constant-power panning: pan ∈ [-1, 1]
// ============================================================
function panGains(pan) {
  const angle = (pan + 1) * Math.PI / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

// ============================================================
// Render one track into stereo { left, right } buffers
// If the instrument has continuousPhase=true, the oscillator
// phase is preserved across note boundaries (including pauses).
// Pan and frequencyOffset: track-level default, note-level override.
// Elements with "type": "control" are meta-events that update
// the running defaults without rendering audio or consuming time.
// ============================================================
function renderTrack(track, instrumentFn, continuousPhase, sampleRate, secondsPerBeat) {
  let totalSec = 0;
  for (const n of track.notes) {
    if (n.type === 'control') continue; // control events consume no time
    totalSec += n.duration * secondsPerBeat;
  }

  const totalSamples = Math.ceil(sampleRate * totalSec);
  const left = new Float64Array(totalSamples);
  const right = new Float64Array(totalSamples);

  // Mutable running defaults (can be updated by control events)
  let trackPan = track.pan || 0;
  let trackFreqOff = track.frequencyOffset || 0;
  let cursor = 0;
  let trackTime = 0;

  for (const note of track.notes) {
    // --- Control event (automation): update defaults, no audio ---
    if (note.type === 'control') {
      if (note.pan !== undefined) trackPan = note.pan;
      if (note.frequencyOffset !== undefined) trackFreqOff = note.frequencyOffset;
      continue;
    }

    const noteLen = Math.floor(sampleRate * note.duration * secondsPerBeat);
    const timeOffset = continuousPhase ? trackTime : 0;

    // Per-note frequencyOffset: note overrides running track default
    const freqOff = note.frequencyOffset !== undefined ? note.frequencyOffset : trackFreqOff;
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

    // Per-note pan: note overrides running track default
    const notePan = note.pan !== undefined ? note.pan : trackPan;
    const { left: panL, right: panR } = panGains(notePan);

    const buf = renderNote(instrumentFn, adjustedNote, sampleRate, secondsPerBeat, timeOffset);

    for (let i = 0; i < buf.length && cursor + i < totalSamples; i++) {
      const s = buf[i];
      left[cursor + i] += s * panL;
      right[cursor + i] += s * panR;
    }
    cursor += noteLen;
    trackTime += note.duration * secondsPerBeat;
  }

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

  // Find the longest track for total duration (skip control events)
  let totalSec = 0;
  for (const track of song.tracks) {
    let trackSec = 0;
    for (const n of track.notes) {
      if (n.type === 'control') continue;
      trackSec += n.duration * secondsPerBeat;
    }
    if (trackSec > totalSec) totalSec = trackSec;
  }

  const totalSamples = Math.ceil(sampleRate * totalSec);
  const master = { left: new Float64Array(totalSamples), right: new Float64Array(totalSamples) };

  // Render each track independently, then sum into master
  for (const track of song.tracks) {
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
