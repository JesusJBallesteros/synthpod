import { onWorkerRestart } from '../engines/client';
import type { PCM, TTSEngine } from '../engines/types';
import type { Turn } from '../parse/parse';
import { assemble, trimSilence, type Segment } from './assemble';
import { chunkKey, getChunk, putChunk } from './cache';
import type { Cue } from './captions';
import { gainToTarget, limitPeaks, measureLufs } from './loudness';

/** How one speaker is voiced. */
export interface Cast {
  engine: TTSEngine;
  voice: string;
  speed: number;
  gain: number;
  locale: string; // BCP 47, for sentence segmentation
}

/** distinct: a voice per speaker. narrator: one voice that names each speaker. hybrid: distinct voices that introduce themselves once. */
export type Mode = 'distinct' | 'narrator' | 'hybrid';

export interface PlanOptions {
  mode: Mode;
  turnPauseMs: number;
  paragraphPauseMs: number;
  sentencePauseMs: number;
  /** A longer pause after the opening teaser; 0 = none. Applies after the first `coldOpenTurns` turns. */
  coldOpenPauseMs: number;
  coldOpenTurns: number;
  castFor(speaker: string | null): Cast;
  /** Apply the pronunciation dictionary and abbreviation expansion. */
  prepare(text: string, cast: Cast): string;
  /** The words that introduce a speaker, e.g. "Anna says:". */
  announce(speaker: string, cast: Cast): string;
}

export interface RenderOptions extends PlanOptions {
  /** Target loudness in LUFS, or null to leave levels alone. */
  loudnessTarget: number | null;
  /** Output sample rate, or 0 to keep the highest rate any engine produced. */
  sampleRate: number;
  onProgress(done: number, total: number): void;
  /** Called while a voice model that is needed for the next chunk downloads. */
  onVoiceLoad(cast: Cast, fraction: number, stage?: 'download' | 'engine'): void;
  signal: AbortSignal;
}

export interface RenderResult {
  pcm: Float32Array;
  sampleRate: number;
  /** Sentences that could not be synthesised and were left out. */
  skipped: string[];
  /** Every spoken sentence with its real position in the audio, for captions and chapters. */
  cues: Cue[];
}

export interface Chunk {
  text: string;
  cast: Cast;
  pauseAfterMs: number;
  /** Index of the turn this sentence belongs to, and who speaks it (null = unassigned). */
  turn: number;
  speaker: string | null;
  title?: string;
}

const MAX_CHUNK_CHARS = 300;
const ANNOUNCE_PAUSE_MS = 250;

/** Break an over-long sentence at clause boundaries (then at spaces), since engines truncate or degrade on long input. */
function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_CHARS) return [sentence];
  const out: string[] = [];
  let current = '';
  const push = (piece: string) => {
    if ((current + piece).length > MAX_CHUNK_CHARS && current.trim()) {
      out.push(current.trim());
      current = '';
    }
    current += piece;
  };
  for (const clause of sentence.match(/[^,;:—–]+[,;:—–]*\s*/g) ?? [sentence]) {
    if (clause.length <= MAX_CHUNK_CHARS) push(clause);
    else for (const word of clause.match(/\S+\s*/g) ?? [clause]) push(word);
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function sentences(text: string, locale: string): string[] {
  const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
  return [...seg.segment(text)]
    .map((s) => s.segment.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
    .flatMap(splitLong);
}

export function planChunks(turns: Turn[], opts: PlanOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const introduced = new Set<string>();
  let previous: string | null = null;
  turns.forEach((turn, index) => {
    const cast = opts.castFor(turn.speaker);
    const start = chunks.length;
    // The narrator names the speaker whenever it changes; in hybrid mode each speaker is named once.
    const announceNow = turn.speaker !== null && (opts.mode === 'narrator' ? turn.speaker !== previous : opts.mode === 'hybrid' && !introduced.has(turn.speaker));
    const where = { turn: index, speaker: turn.speaker, title: turn.title };
    if (announceNow) chunks.push({ text: opts.announce(turn.speaker!, cast), cast, pauseAfterMs: ANNOUNCE_PAUSE_MS, ...where });
    if (turn.speaker) introduced.add(turn.speaker);
    previous = turn.speaker;

    const body = chunks.length;
    for (const para of opts.prepare(turn.text, cast).split(/\n{2,}/)) {
      const paraStart = chunks.length;
      for (const s of sentences(para, cast.locale)) chunks.push({ text: s, cast, pauseAfterMs: opts.sentencePauseMs, ...where });
      if (chunks.length > paraStart) chunks[chunks.length - 1].pauseAfterMs = opts.paragraphPauseMs;
    }
    if (chunks.length === body) {
      chunks.length = start; // nothing to say: drop the announcement too
      return;
    }
    const afterColdOpen = opts.coldOpenPauseMs > 0 && index === opts.coldOpenTurns - 1;
    chunks[chunks.length - 1].pauseAfterMs = afterColdOpen ? opts.coldOpenPauseMs : opts.turnPauseMs;
  });
  return chunks;
}

const loadedVoices = new Set<string>();
// A restarted worker has no voices loaded, so they must be loaded (with progress shown) again.
onWorkerRestart(() => loadedVoices.clear());

/** The voice itself could not be loaded; no sentence for it can succeed. */
export class VoiceLoadError extends Error {}

/** Synthesise one sentence, reusing the cached audio when the same engine, voice, speed and text were rendered before. */
export async function synthCached(cast: Cast, text: string, onVoiceLoad: (fraction: number, stage?: 'download' | 'engine') => void): Promise<PCM> {
  const key = await chunkKey(cast.engine.id, cast.voice, cast.speed, text);
  const hit = await getChunk(key);
  if (hit) return hit;
  // Only download a model once something actually needs synthesising.
  const voiceKey = `${cast.engine.id}/${cast.voice}`;
  if (!loadedVoices.has(voiceKey)) {
    try {
      await cast.engine.load(cast.voice, onVoiceLoad);
    } catch (err) {
      throw new VoiceLoadError((err as Error).message);
    }
    loadedVoices.add(voiceKey);
  }
  const audio = trimSilence(await cast.engine.synth(text, { voice: cast.voice, speed: cast.speed }));
  await putChunk(key, audio);
  return audio;
}

/**
 * Voices come out at different levels. Measure each voice over everything it says and bring them
 * all to the same target, so no speaker is quieter than another.
 */
function balanceVoices(segments: Segment[], casts: Cast[], target: number): void {
  const groups = new Map<string, number[]>();
  casts.forEach((c, i) => {
    const key = `${c.engine.id}/${c.voice}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const indexes of groups.values()) {
    const rate = segments[indexes[0]].audio.sampleRate;
    const gain = gainToTarget(measureLufs(indexes.map((i) => segments[i].audio.pcm), rate), target);
    for (const i of indexes) segments[i].gain *= gain;
  }
}

/** Synthesise every chunk and assemble one mono PCM buffer. */
export async function renderTurns(turns: Turn[], opts: RenderOptions): Promise<RenderResult> {
  const chunks = planChunks(turns, opts);
  const segments: Segment[] = [];
  const spoken: Chunk[] = [];
  const skipped: string[] = [];
  let failures = 0;
  opts.onProgress(0, chunks.length);
  // Rejects as soon as the user cancels, so Cancel does not have to wait for the current sentence.
  const cancelled = new Promise<never>((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
  cancelled.catch(() => {});
  for (let i = 0; i < chunks.length; i++) {
    opts.signal.throwIfAborted();
    const c = chunks[i];
    try {
      const audio = await Promise.race([synthCached(c.cast, c.text, (f, stage) => opts.onVoiceLoad(c.cast, f, stage)), cancelled]);
      segments.push({ audio, gain: c.cast.gain, pauseAfterMs: c.pauseAfterMs });
      spoken.push(c);
    } catch (err) {
      // One bad sentence should not lose the whole render, but a cancelled render, a voice that
      // will not load or a broken engine should stop it.
      if (opts.signal.aborted || err instanceof VoiceLoadError) throw err;
      skipped.push(c.text);
      if (++failures > 5 && segments.length === 0) throw err;
      console.warn('Skipped a sentence that failed to synthesise:', c.text, err);
      if (segments.length) segments[segments.length - 1].pauseAfterMs = c.pauseAfterMs;
    }
    opts.onProgress(i + 1, chunks.length);
  }
  opts.signal.throwIfAborted();
  if (!segments.length) throw new Error('Nothing could be synthesised.');
  if (opts.loudnessTarget !== null) balanceVoices(segments, spoken.map((c) => c.cast), opts.loudnessTarget);
  // Engines differ in sample rate (Piper 22.05 kHz, Kokoro 24 kHz); by default keep the highest one used.
  const sampleRate = opts.sampleRate || Math.max(...segments.map((s) => s.audio.sampleRate));
  const { pcm, spans } = assemble(segments, sampleRate);
  limitPeaks(pcm, sampleRate);
  const cues = spans.map((span, i) => ({
    start: span.start / sampleRate,
    end: span.end / sampleRate,
    turn: spoken[i].turn,
    speaker: spoken[i].speaker,
    text: spoken[i].text,
    title: spoken[i].title,
  }));
  return { pcm, sampleRate, skipped, cues };
}
