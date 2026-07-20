// Synthesizes a short seamless drum loop (kick/snare/hihat) as a 16-bit PCM
// WAV. Used as background music since this environment's network egress
// policy blocks external hosts (Pixabay etc.) — this is the documented
// fallback, not a shortcut taken by choice.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 44100;
const BPM = 120;
const BEATS_PER_LOOP = 8; // 2 bars of 4/4
const LOOP_SECONDS = (BEATS_PER_LOOP * 60) / BPM; // 4.0s exactly -> 120 frames @30fps
const TOTAL_SAMPLES = Math.round(LOOP_SECONDS * SAMPLE_RATE);
const SIXTEENTH = LOOP_SECONDS / (BEATS_PER_LOOP * 4); // 32 steps total

const buffer = new Float64Array(TOTAL_SAMPLES);

function addAt(startSample, samples) {
  for (let i = 0; i < samples.length; i++) {
    const idx = startSample + i;
    if (idx >= 0 && idx < TOTAL_SAMPLES) buffer[idx] += samples[i];
  }
}

function kick() {
  const dur = 0.18;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 150 * Math.exp(-t * 28) + 45;
    const env = Math.exp(-t * 22);
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.9;
  }
  return out;
}

function snare() {
  const dur = 0.15;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 26);
    const tone = Math.sin(2 * Math.PI * 190 * t) * 0.35;
    const noise = (Math.random() * 2 - 1) * 0.65;
    out[i] = (tone + noise) * env * 0.7;
  }
  return out;
}

function hihat(accent) {
  const dur = 0.05;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 90);
    const noise = Math.random() * 2 - 1;
    out[i] = noise * env * (accent ? 0.28 : 0.16);
  }
  return out;
}

const kickSteps = [0, 8, 16, 24];
const snareSteps = [4, 12, 20, 28];

for (let step = 0; step < 32; step++) {
  const startSample = Math.round(step * SIXTEENTH * SAMPLE_RATE);
  if (kickSteps.includes(step)) addAt(startSample, kick());
  if (snareSteps.includes(step)) addAt(startSample, snare());
  addAt(startSample, hihat(step % 4 === 0));
}

// Soft clip to avoid harsh digital clipping where hits overlap.
let peak = 0;
for (let i = 0; i < TOTAL_SAMPLES; i++) peak = Math.max(peak, Math.abs(buffer[i]));
const scale = peak > 0.98 ? 0.98 / peak : 1;

const pcm = new Int16Array(TOTAL_SAMPLES);
for (let i = 0; i < TOTAL_SAMPLES; i++) {
  const v = Math.max(-1, Math.min(1, buffer[i] * scale));
  pcm[i] = Math.round(v * 32767);
}

function writeWav(filePath, samples, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }

  writeFileSync(filePath, buf);
}

const wavPath = path.join(__dirname, '..', 'public', 'music.wav');
writeWav(wavPath, pcm, SAMPLE_RATE);
console.log('Wrote', wavPath, `(${LOOP_SECONDS}s, ${TOTAL_SAMPLES} samples)`);
console.log('LOOP_SECONDS', LOOP_SECONDS, 'LOOP_FRAMES_AT_30FPS', LOOP_SECONDS * 30);
