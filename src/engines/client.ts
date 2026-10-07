import type { Lang, PCM, ProgressFn, SynthOptions, TTSEngine, Voice } from './types';
import type { TtsRequest, TtsResponse } from './tts.worker';

type Body = TtsRequest extends infer R ? (R extends unknown ? Omit<R, 'id' | 'engine'> : never) : never;
interface Pending {
  request: TtsRequest;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressFn;
  timer: number;
  /** What the worker last said it was doing, for the error message if it then goes silent. */
  stage: string;
}

// How long to wait for a sign of life before giving up, in seconds. A download resets the clock
// with every progress report, so this is about silence, not total duration.
const PATIENCE: Record<TtsRequest['type'], number> = { languages: 60, listVoices: 60, load: 120, synth: 240 };
// Starting the engine takes a second or two. If it takes this long, its helper threads have
// failed to start (seen in some browsers and embedded web views) and it will never finish.
const ENGINE_START_PATIENCE = 40;
const SINGLE_THREAD_KEY = 'synthpod.singleThread';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const restartListeners: (() => void)[] = [];
const fallbackListeners: (() => void)[] = [];

function readFlag(): boolean {
  try {
    return localStorage.getItem(SINGLE_THREAD_KEY) === '1';
  } catch {
    return false;
  }
}
let singleThread = readFlag();

/** True once multi-threading turned out not to work in this browser, now or on an earlier visit. */
export function usesSingleThread(): boolean {
  return singleThread;
}

/** Be told when the worker had to be replaced, which means loaded voices are gone. */
export function onWorkerRestart(listener: () => void): void {
  restartListeners.push(listener);
}

/** Be told when the app gives up on multi-threading and continues on one thread. */
export function onThreadFallback(listener: () => void): void {
  fallbackListeners.push(listener);
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
  for (const listener of restartListeners) listener();
}

/**
 * The worker crashed or went silent. Without this, every waiting request would wait forever
 * and the page would look frozen; instead they all fail with a message and a fresh worker is
 * started for whatever is asked next.
 */
function abandonWorker(reason: string): void {
  const waiting = [...pending.values()];
  pending.clear();
  stopWorker();
  for (const p of waiting) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
}

/** Threads did not start: carry on with one thread, re-sending what was being waited for. */
function fallBackToSingleThread(): void {
  singleThread = true;
  try {
    localStorage.setItem(SINGLE_THREAD_KEY, '1');
  } catch {
    // remembered for this visit only
  }
  stopWorker();
  for (const listener of fallbackListeners) listener();
  for (const p of pending.values()) {
    p.stage = '';
    watch(p);
    getWorker().postMessage(p.request);
  }
}

function watch(p: Pending): void {
  clearTimeout(p.timer);
  const startingEngine = p.stage === 'engine';
  const patience = startingEngine ? ENGINE_START_PATIENCE : PATIENCE[p.request.type];
  p.timer = self.setTimeout(() => {
    if (startingEngine && !singleThread) return fallBackToSingleThread();
    const doing = startingEngine ? ' while starting' : p.stage === 'download' ? ' while downloading a voice' : '';
    abandonWorker(`The speech engine did not respond for ${patience} seconds${doing} and was restarted. Please try again.`);
  }, patience * 1000);
}

function getWorker(): Worker {
  if (worker) return worker;
  // The name tells the worker whether it may use several threads.
  worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module', name: singleThread ? 'synthpod-single-thread' : 'synthpod' });
  worker.onmessage = (e: MessageEvent<TtsResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.stage = msg.stage ?? 'download';
      watch(p);
      return p.onProgress?.(msg.fraction, msg.stage);
    }
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.type === 'done') p.resolve(msg.result);
    else p.reject(new Error(msg.message));
  };
  worker.onerror = (e) => {
    e.preventDefault();
    abandonWorker(`The speech engine stopped unexpectedly (${e.message || 'possibly out of memory'}) and was restarted. Please try again.`);
  };
  return worker;
}

/** Main-thread proxy for an engine that lives in the TTS worker. */
export class WorkerEngine implements TTSEngine {
  constructor(public id: string) {}

  private call<T>(body: Body, onProgress?: ProgressFn): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { request: { ...body, id, engine: this.id } as TtsRequest, resolve, reject, onProgress, timer: 0, stage: '' };
      pending.set(id, p);
      watch(p);
      getWorker().postMessage(p.request);
    });
  }

  languages(): Promise<Lang[]> {
    return this.call({ type: 'languages' });
  }
  listVoices(lang: string): Promise<Voice[]> {
    return this.call({ type: 'listVoices', lang });
  }
  load(voiceId: string, onProgress: ProgressFn): Promise<void> {
    return this.call({ type: 'load', voice: voiceId }, onProgress);
  }
  synth(text: string, opts: SynthOptions): Promise<PCM> {
    return this.call({ type: 'synth', text, ...opts });
  }
}
