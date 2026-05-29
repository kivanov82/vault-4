/**
 * Procedural synthwave bed for the Vault-4 promo — fully original/royalty-free.
 * Renders A-minor at 120 BPM with kick / bass / arp / pad / hats and section
 * dynamics that follow the scene cuts (Promo.tsx DURATIONS @ 30fps):
 *   boot 0-3.33s | hero 3.33-8.83 | chart 8.83-13.83 | how 13.83-19.33 | cta 19.33-23.67
 *
 * Usage: node scripts/gen-music.js   ->   public/music.wav
 * (Root.tsx then muxes it via <Audio>; encode to mp3 with `npm run music:mp3`.)
 */
const fs = require("fs");
const path = require("path");

const SR = 44100;
const BPM = 120;
const SPB = 60 / BPM; // seconds per beat = 0.5
const DUR = 710 / 30; // match TOTAL_FRAMES @ 30fps
const N = Math.floor(SR * DUR);

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// A2=45, C3=48, E3=52, F2=41, G2=43, B3=59, D4=62, C4=60, E4=64, A4=69...
// 4-bar progression (1 bar = 4 beats = 2s): Am - F - C - G
const PROG = [
  { bass: 33, chord: [57, 60, 64] }, // Am  (A2 / A3 C4 E4)
  { bass: 29, chord: [57, 60, 65] }, // F   (F2 / A3 C4 F4)
  { bass: 36, chord: [60, 64, 67] }, // C   (C3 / C4 E4 G4)
  { bass: 31, chord: [59, 62, 67] }, // G   (G2 / B3 D4 G4)
];

const out = new Float32Array(N);
const arpBuf = new Float32Array(N); // separate so we can echo it

const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
const square = (ph) => (ph - Math.floor(ph) < 0.5 ? 1 : -1);
const tri = (ph) => 2 * Math.abs(2 * (ph - Math.floor(ph + 0.5))) - 1;

// section gain envelope (0..1) over time t (seconds)
function sectionGain(t) {
  if (t < 3.0) return 0.35 + 0.25 * (t / 3.0); // boot: build
  if (t < 3.33) return 0.6 + 0.4 * ((t - 3.0) / 0.33); // riser into hero
  if (t > DUR - 1.2) return Math.max(0, (DUR - t) / 1.2); // outro fade
  return 1.0;
}
const kickActive = (t) => t >= 3.2;
const hatActive = (t) => t >= 8.83; // hats kick in at the chart scene
const fullArp = (t) => t >= 3.33;

// one-pole lowpass state for arp warmth
let lp = 0;

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const beat = t / SPB; // beat index (float)
  const bar = Math.floor(beat / 4);
  const chordIdx = bar % 4;
  const { bass, chord } = PROG[chordIdx];
  const sg = sectionGain(t);

  // --- Bass: eighth notes on root, saw + sub sine ---
  const eighth = beat * 2;
  const eFrac = eighth - Math.floor(eighth);
  const bEnv = Math.exp(-eFrac * 3.2);
  const bf = midi(bass);
  const bassSig =
    (0.6 * saw(t * bf) + 0.5 * Math.sin(2 * Math.PI * t * bf * 0.5)) * bEnv;

  // --- Pad: sustained chord, detuned sines, soft ---
  let pad = 0;
  for (const note of chord) {
    const f = midi(note);
    pad += Math.sin(2 * Math.PI * t * f) + Math.sin(2 * Math.PI * t * f * 1.005);
  }
  pad = (pad / (chord.length * 2)) * 0.5;

  // --- Arp: 16th notes cycling chord tones across two octaves, square ---
  const six = beat * 4;
  const step = Math.floor(six) % 8;
  const arpNotes = [chord[0], chord[1], chord[2], chord[1], chord[0] + 12, chord[2], chord[1] + 12, chord[2] + 12];
  const af = midi(arpNotes[step]);
  const aFrac = six - Math.floor(six);
  const aEnv = Math.exp(-aFrac * 4.5);
  const arpRaw = square(t * af) * aEnv * (fullArp(t) ? 0.5 : 0.22);
  // warm one-pole lowpass
  lp += 0.28 * (arpRaw - lp);
  arpBuf[i] = lp;

  // --- Kick: 4-on-the-floor, sine pitch sweep ---
  let kick = 0;
  if (kickActive(t)) {
    const bFrac = beat - Math.floor(beat);
    const kEnv = Math.exp(-bFrac * 9);
    const kf = 120 * Math.exp(-bFrac * 18) + 42;
    kick = Math.sin(2 * Math.PI * (kf * bFrac)) * kEnv * 0.9;
  }

  // --- Hat: white noise on off-beats ---
  let hat = 0;
  if (hatActive(t)) {
    const off = (beat + 0.5) % 1;
    if (off < 0.06) hat = (Math.random() * 2 - 1) * Math.exp(-off * 50) * 0.25;
  }

  out[i] = (bassSig * 0.7 + pad * 0.35 + kick) * sg;
  out[i] += hat * sg;
}

// --- Feedback delay on the arp (dotted-eighth echo) then mix in ---
const delay = Math.floor(SPB * 0.75 * SR);
for (let i = 0; i < N; i++) {
  if (i >= delay) arpBuf[i] += arpBuf[i - delay] * 0.4;
}
for (let i = 0; i < N; i++) {
  out[i] += arpBuf[i] * 0.5 * sectionGain(i / SR);
}

// --- Soft-clip + normalize ---
let peak = 0;
for (let i = 0; i < N; i++) {
  out[i] = Math.tanh(out[i] * 1.1);
  if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]);
}
const norm = peak > 0 ? 0.89 / peak : 1;

// --- Write 16-bit mono WAV ---
const buf = Buffer.alloc(44 + N * 2);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + N * 2, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) {
  const s = Math.max(-1, Math.min(1, out[i] * norm));
  buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
}

const outPath = path.join(__dirname, "..", "public", "music.wav");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);
console.log(`wrote ${outPath} (${(buf.length / 1e6).toFixed(2)} MB, ${DUR.toFixed(2)}s)`);
