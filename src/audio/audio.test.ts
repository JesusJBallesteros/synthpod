import { Mp3Encoder } from '@breezystack/lamejs';
import { describe, expect, it } from 'vitest';
import type { TTSEngine } from '../engines/types';
import { announcement, normaliseText } from '../parse/normalise';
import { gainToTarget, limitPeaks, measureLufs } from './loudness';
import { planChunks, type Cast, type PlanOptions } from './render';
import { buildInfoFrame, countFrames, effectiveBitrate, readFrameHeader } from './xing';

function sine(freq: number, amplitude: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe('loudness', () => {
  it('measures a full-scale 997 Hz sine at -3.01 LUFS, at any sample rate', () => {
    // Reference value from ITU-R BS.1770 for a single channel.
    for (const rate of [22050, 24000, 44100, 48000]) {
      expect(measureLufs(sine(997, 1, 3, rate), rate)).toBeCloseTo(-3.01, 1);
    }
  });

  it('measures audio given in pieces exactly as if it were joined', () => {
    const rate = 22050;
    const whole = sine(997, 0.3, 4, rate).map((v, i) => v * (0.5 + 0.5 * Math.sin(i / 5000)));
    const pieces = [whole.subarray(0, 1234), whole.subarray(1234, 40000), whole.subarray(40000)];
    expect(measureLufs(pieces, rate)).toBe(measureLufs(whole, rate));
    expect(measureLufs([new Float32Array(10)], rate)).toBe(-Infinity);
  });

  it('ignores silence between speech when measuring', () => {
    const rate = 24000;
    const tone = sine(997, 0.1, 2, rate);
    const padded = new Float32Array(tone.length * 3);
    padded.set(tone, tone.length);
    // Blocks that straddle the edges of the tone pull the result down slightly; ungated it would be 4.8 dB lower.
    expect(Math.abs(measureLufs(padded, rate) - measureLufs(tone, rate))).toBeLessThan(1);
  });

  it('computes the gain to a target', () => {
    const rate = 24000;
    const quiet = sine(997, 0.05, 2, rate);
    const gain = gainToTarget(measureLufs(quiet, rate), -16);
    const louder = quiet.map((v) => v * gain);
    expect(measureLufs(louder, rate)).toBeCloseTo(-16, 1);
    expect(gainToTarget(-Infinity, -16)).toBe(1);
  });

  it('limits peaks without turning the rest down', () => {
    const rate = 24000;
    const ceiling = Math.pow(10, -1 / 20);
    // Two seconds of moderate tone with a short burst well over full scale in the middle.
    const pcm = sine(440, 0.5, 2, rate);
    for (let i = rate; i < rate + 480; i++) pcm[i] *= 4;
    const before = pcm.slice();
    limitPeaks(pcm, rate, -1);
    expect(pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(ceiling + 1e-6);
    // Half a second away from the burst nothing has changed.
    expect(pcm.subarray(0, rate / 2)).toEqual(before.subarray(0, rate / 2));
    expect(pcm.subarray(rate * 1.5)).toEqual(before.subarray(rate * 1.5));
    // Audio already under the ceiling is left untouched.
    const calm = sine(440, 0.5, 1, rate);
    limitPeaks(calm, rate, -1);
    expect(calm).toEqual(sine(440, 0.5, 1, rate));
  });
});

function encode(rate: number, kbps: number, channels: number, seconds: number): Uint8Array {
  const enc = new Mp3Encoder(channels, rate, kbps);
  const samples = Int16Array.from(sine(440, 0.5, seconds, rate), (v) => v * 32767);
  const parts = [channels === 2 ? enc.encodeBuffer(samples, samples) : enc.encodeBuffer(samples), enc.flush()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe('Info (Xing) frame', () => {
  it.each([
    [22050, 128, 1],
    [24000, 96, 1],
    [44100, 192, 1],
    [44100, 128, 2],
  ])('describes a %i Hz, %i kbps, %i-channel stream', (rate, kbps, channels) => {
    const audio = encode(rate, kbps, channels, 3);
    const frames = countFrames(audio);
    // Every frame holds 1152 samples (MPEG-1) or 576 (MPEG-2); the encoder adds a little padding.
    const expected = (3 * rate) / (rate >= 32000 ? 1152 : 576);
    expect(frames).toBeGreaterThanOrEqual(Math.floor(expected));
    expect(frames).toBeLessThanOrEqual(Math.ceil(expected) + 3);

    const info = buildInfoFrame(audio)!;
    const header = readFrameHeader(info, 0)!;
    expect(header.size).toBe(info.length);
    const tag = 4 + (header.mpeg1 ? (header.mono ? 17 : 32) : header.mono ? 9 : 17);
    expect(new TextDecoder().decode(info.subarray(tag, tag + 4))).toBe('Info');
    const view = new DataView(info.buffer);
    expect(view.getUint32(tag + 8)).toBe(frames);
    expect(view.getUint32(tag + 12)).toBe(audio.length + info.length);
    // The stream continues with a valid frame right after the Info frame.
    const file = new Uint8Array([...info, ...audio]);
    expect(countFrames(file)).toBe(frames + 1);
  });

  it('caps the bitrate that low sample rates cannot carry', () => {
    expect(effectiveBitrate(22050, 192)).toBe(160);
    expect(effectiveBitrate(44100, 192)).toBe(192);
    expect(effectiveBitrate(24000, 64)).toBe(64);
  });
});

describe('text normalisation', () => {
  it('applies the pronunciation dictionary to whole words only', () => {
    const dictionary = [{ find: 'SQL', say: 'sequel' }, { find: 'Jeffers', say: 'Jeffurs' }];
    expect(normaliseText('sql and MySQL, says Jeffers.', { family: 'en', expand: false, dictionary })).toBe('sequel and MySQL, says Jeffurs.');
  });

  it('expands abbreviations, symbols and web addresses per language', () => {
    const en = normaliseText('Dr. Lee, e.g., walked 5 km & gained 20% vs. last year. See https://www.example.org/a/b.', { family: 'en', expand: true, dictionary: [] });
    expect(en).toBe('Doctor Lee, for example, walked 5 kilometres and gained 20 percent versus last year. See example dot org.');
    expect(normaliseText('Das sind z. B. ca. 20 % bzw. mehr.', { family: 'de', expand: true, dictionary: [] })).toBe('Das sind zum Beispiel circa 20 Prozent beziehungsweise mehr.');
    expect(normaliseText('El Sr. Ruiz, p. ej., etc.', { family: 'es', expand: true, dictionary: [] })).toBe('El señor Ruiz, por ejemplo, etcétera');
    expect(normaliseText('Dr. Lee at 5 km', { family: 'en', expand: false, dictionary: [] })).toBe('Dr. Lee at 5 km');
  });

  it('words speaker announcements in the transcript language', () => {
    expect(announcement('Anna', 'en', 'says')).toBe('Anna says:');
    expect(announcement('Anna', 'de', 'says')).toBe('Anna sagt:');
    expect(announcement('Anna', 'xx', 'says')).toBe('Anna:');
    expect(announcement('Anna', 'en', 'name')).toBe('Anna:');
  });
});

describe('planChunks', () => {
  const engine = { id: 'test' } as TTSEngine;
  const cast = (voice: string): Cast => ({ engine, voice, speed: 1, gain: 1, locale: 'en' });
  const turns = [
    { speaker: null, text: 'A teaser.' },
    { speaker: 'Anna', text: 'Hello there. How are you?\n\nNew paragraph.' },
    { speaker: 'Ben', text: 'Fine.' },
    { speaker: 'Ben', text: 'Really.' },
    { speaker: 'Anna', text: 'Good.' },
  ];
  const base: PlanOptions = {
    mode: 'distinct',
    turnPauseMs: 450,
    paragraphPauseMs: 250,
    sentencePauseMs: 150,
    coldOpenPauseMs: 0,
    coldOpenTurns: 1,
    castFor: (speaker) => cast(speaker ?? 'unassigned'),
    prepare: (text) => text,
    announce: (speaker) => `${speaker} says:`,
  };
  const texts = (opts: PlanOptions) => planChunks(turns, opts).map((c) => c.text);

  it('splits turns into sentences with the configured pauses', () => {
    const chunks = planChunks(turns, { ...base, coldOpenPauseMs: 1200 });
    expect(chunks.map((c) => c.pauseAfterMs)).toEqual([1200, 150, 250, 450, 450, 450, 450]);
    expect(chunks[1].cast.voice).toBe('Anna');
  });

  it('has the narrator name the speaker whenever it changes', () => {
    expect(texts({ ...base, mode: 'narrator' })).toEqual([
      'A teaser.', 'Anna says:', 'Hello there.', 'How are you?', 'New paragraph.', 'Ben says:', 'Fine.', 'Really.', 'Anna says:', 'Good.',
    ]);
  });

  it('names each speaker once in hybrid mode', () => {
    expect(texts({ ...base, mode: 'hybrid' })).toEqual([
      'A teaser.', 'Anna says:', 'Hello there.', 'How are you?', 'New paragraph.', 'Ben says:', 'Fine.', 'Really.', 'Good.',
    ]);
  });

  it('applies text preparation before splitting', () => {
    expect(texts({ ...base, prepare: (t) => t.replace('Fine.', 'Fine. Thanks.') })).toContain('Thanks.');
  });
});
