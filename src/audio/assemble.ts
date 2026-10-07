import type { PCM } from '../engines/types';

/** Linear-interpolation resampler (adequate for speech; avoids needing an AudioContext in workers). */
export function resample(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return pcm;
  const ratio = from / to;
  const n = Math.floor(pcm.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const f = pos - i0;
    out[i] = pcm[i0] * (1 - f) + pcm[i1] * f;
  }
  return out;
}

/**
 * Cut the silence engines leave around a sentence (Kokoro pads generously), keeping a short
 * margin, so the configured pauses are the pauses you hear.
 */
export function trimSilence(audio: PCM, threshold = 0.004, keepMs = 30): PCM {
  const { pcm, sampleRate } = audio;
  const keep = Math.round((keepMs / 1000) * sampleRate);
  let start = 0;
  let end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < threshold) start++;
  while (end > start && Math.abs(pcm[end - 1]) < threshold) end--;
  if (start === end) return audio;
  return { pcm: pcm.slice(Math.max(0, start - keep), Math.min(pcm.length, end + keep)), sampleRate };
}

export interface Segment {
  audio: PCM;
  gain: number;
  pauseAfterMs: number;
}

export interface Assembled {
  pcm: Float32Array;
  /** Where each segment starts and ends in the output, in samples. */
  spans: { start: number; end: number }[];
}

/** Concatenate segments at one output rate, applying gain and trailing pauses. */
export function assemble(segments: Segment[], rate: number): Assembled {
  const resampled = segments.map((s) => resample(s.audio.pcm, s.audio.sampleRate, rate));
  const pauses = segments.map((s) => Math.round((s.pauseAfterMs / 1000) * rate));
  const total = resampled.reduce((n, r, i) => n + r.length + pauses[i], 0);
  const out = new Float32Array(total);
  const spans: Assembled['spans'] = [];
  let off = 0;
  for (let s = 0; s < segments.length; s++) {
    const r = resampled[s];
    const gain = segments[s].gain;
    for (let i = 0; i < r.length; i++) out[off + i] = r[i] * gain;
    spans.push({ start: off, end: off + r.length });
    off += r.length + pauses[s];
  }
  return { pcm: out, spans };
}
