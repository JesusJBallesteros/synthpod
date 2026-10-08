// Integrated loudness after ITU-R BS.1770 (mono): K-weighting, 400 ms blocks, absolute and relative gates.

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting filters, derived for any sample rate (the standard only tabulates 48 kHz). */
function kWeighting(rate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, modelling the acoustic effect of the head.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / rate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass (the "RLB" curve).
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / rate);
  const d = 1 + K1 / Q1 + K1 * K1;
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K1 * K1 - 1)) / d, a2: (1 - K1 / Q1 + K1 * K1) / d };
  return [shelf, highpass];
}

/**
 * Integrated loudness in LUFS, or -Infinity for silence. The audio may be given in pieces (the
 * sentences of one voice); they are measured as one continuous signal without being copied
 * together, which matters for recordings of an hour or more.
 */
export function measureLufs(audio: Float32Array | Float32Array[], rate: number): number {
  const pieces = Array.isArray(audio) ? audio : [audio];
  const [s1, s2] = kWeighting(rate);
  const hop = Math.round(0.1 * rate);
  if (pieces.reduce((n, p) => n + p.length, 0) < hop * 4) return -Infinity;

  // Mean square of the filtered signal per 100 ms hop; a 400 ms block is four consecutive hops.
  const hops: number[] = [];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
  let sum = 0;
  let filled = 0;
  for (const pcm of pieces) {
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      const y = s1.b0 * x + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const v = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * v1 - s2.a2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      sum += v * v;
      if (++filled === hop) {
        hops.push(sum / hop);
        sum = 0;
        filled = 0;
      }
    }
  }
  const blocks: number[] = [];
  for (let h = 0; h + 4 <= hops.length; h++) blocks.push((hops[h] + hops[h + 1] + hops[h + 2] + hops[h + 3]) / 4);

  const toLufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const audible = blocks.filter((b) => toLufs(b) > -70);
  if (!audible.length) return -Infinity;
  const relativeGate = toLufs(mean(audible)) - 10;
  const gated = audible.filter((b) => toLufs(b) > relativeGate);
  return gated.length ? toLufs(mean(gated)) : -Infinity;
}

/** Gain factor that brings audio measured at `lufs` to `target`. */
export function gainToTarget(lufs: number, target: number): number {
  return Number.isFinite(lufs) ? Math.pow(10, (target - lufs) / 20) : 1;
}

/**
 * Peak limiter: turns the volume down only around the moments that would exceed the ceiling
 * (5 ms before, recovering over about 80 ms), so the overall loudness stays where it was set.
 * Gain is computed per millisecond block to keep memory small on long recordings.
 */
export function limitPeaks(pcm: Float32Array, rate: number, ceilingDb = -1): void {
  const ceiling = Math.pow(10, ceilingDb / 20);
  const size = Math.max(1, Math.round(rate / 1000));
  const blocks = Math.ceil(pcm.length / size);
  const gain = new Float32Array(blocks + 2).fill(1); // gain[b + 1] belongs to block b
  let limiting = false;
  for (let b = 0; b < blocks; b++) {
    let peak = 0;
    for (let i = b * size, end = Math.min(pcm.length, i + size); i < end; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak > ceiling) {
      gain[b + 1] = ceiling / peak;
      limiting = true;
    }
  }
  if (!limiting) return;
  // Both passes only ever lower the gain, so no block ends up louder than its own limit.
  const release = 1 / 80;
  const attack = 1 / 5;
  for (let b = 1; b < gain.length; b++) gain[b] = Math.min(gain[b], gain[b - 1] + release);
  for (let b = gain.length - 2; b >= 0; b--) gain[b] = Math.min(gain[b], gain[b + 1] + attack);
  for (let b = 0; b < blocks; b++) {
    // Glide between block edges; each edge takes the lower of its two neighbours.
    const from = Math.min(gain[b], gain[b + 1]);
    const to = Math.min(gain[b + 1], gain[b + 2]);
    if (from === 1 && to === 1) continue;
    for (let i = b * size, end = Math.min(pcm.length, i + size), k = 0; i < end; i++, k++) {
      pcm[i] *= from + ((to - from) * k) / size;
    }
  }
}
