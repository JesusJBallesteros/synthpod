import createPiperPhonemize from '@diffusionstudio/piper-wasm/build/piper_phonemize.js';
import phonemizeDataUrl from '@diffusionstudio/piper-wasm/build/piper_phonemize.data?url';
import phonemizeWasmUrl from '@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type * as Ort from 'onnxruntime-web/wasm';
import ortLibraryUrl from 'onnxruntime-web/wasm?url';
import { toIds } from './piper-ids';
import type { Lang, PCM, ProgressFn, SynthOptions, TTSEngine, Voice } from './types';

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const MAX_SESSIONS = 4;
const MAX_SPEAKERS_PER_MODEL = 20;
const PHONEMIZER_MAX_CALLS = 25;

let runtime: Promise<typeof Ort> | null = null;

/**
 * onnxruntime is loaded at run time from its own, untouched file instead of being bundled into
 * this worker. It starts its helper threads by loading "the file I am in" a second time; if a
 * bundler has merged it into our worker, the threads load our code instead, never start, and
 * every voice load hangs as soon as multi-threading is on.
 *
 * It is loaded on first use rather than with a top-level await: a worker that is still awaiting
 * at the top level has no message handler yet, and the first requests sent to it would be lost.
 */
function loadRuntime(): Promise<typeof Ort> {
  runtime ??= import(/* @vite-ignore */ ortLibraryUrl).then((ort: typeof Ort) => {
    // Serve the runtime's WASM from the app itself rather than a CDN, so rendering works offline.
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
    // Several threads need cross-origin isolation, and the page may also have found that they
    // do not start in this browser, in which case it names this worker accordingly.
    const threadsAllowed = self.crossOriginIsolated && self.name !== 'synthpod-single-thread';
    ort.env.wasm.numThreads = threadsAllowed ? Math.min(navigator.hardwareConcurrency || 1, 8) : 1;
    return ort;
  });
  return runtime;
}

interface CatalogueEntry {
  key: string;
  name: string;
  language: { code: string; name_english: string; country_english: string };
  quality: string;
  num_speakers: number;
  speaker_id_map: Record<string, number>;
  files: Record<string, { size_bytes: number }>;
}

interface ModelConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers: number;
}

interface Loaded {
  ort: typeof Ort;
  config: ModelConfig;
  session: Ort.InferenceSession;
}

async function opfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('piper', { create: true });
}

/** Fetch a model file, keeping a copy in OPFS so later runs work without the network. */
async function cachedFetch(path: string, onProgress?: ProgressFn, expectedBytes = 0): Promise<ArrayBuffer> {
  const name = path.split('/').at(-1)!;
  try {
    const file = await (await (await opfsDir()).getFileHandle(name)).getFile();
    if (file.size > 0) return await file.arrayBuffer();
  } catch {
    // not cached yet
  }
  const res = await fetch(`${HF_BASE}/${path}`);
  if (!res.ok || !res.body) throw new Error(`Could not download ${name} (HTTP ${res.status})`);
  // Without a size from the server, fall back to the one listed in the voice catalogue.
  const total = Number(res.headers.get('Content-Length') ?? 0) || expectedBytes;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (total) onProgress?.(Math.min(1, loaded / total));
  }
  const blob = new Blob(parts as BlobPart[]);
  try {
    const writable = await (await (await opfsDir()).getFileHandle(name, { create: true })).createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    // caching is best-effort (e.g. Safari workers lack createWritable)
  }
  return blob.arrayBuffer();
}

export class PiperEngine implements TTSEngine {
  id = 'piper';
  private catalogue: Promise<Map<string, CatalogueEntry>> | null = null;
  private loaded = new Map<string, Loaded>();
  private phonemizer: ReturnType<typeof createPiperPhonemize> | null = null;
  private phonemizerCalls = 0;
  private lines: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private entries(): Promise<Map<string, CatalogueEntry>> {
    this.catalogue ??= fetch(`${HF_BASE}/voices.json`).then(async (res) => {
      if (!res.ok) throw new Error(`Could not load the Piper voice catalogue (HTTP ${res.status})`);
      const json = (await res.json()) as Record<string, CatalogueEntry>;
      return new Map(Object.values(json).map((e) => [e.key, e]));
    });
    this.catalogue.catch(() => (this.catalogue = null));
    return this.catalogue;
  }

  async languages(): Promise<Lang[]> {
    const langs = new Map<string, Lang>();
    for (const e of (await this.entries()).values()) {
      langs.set(e.language.code, {
        code: e.language.code,
        name: `${e.language.name_english} (${e.language.country_english})`,
      });
    }
    return [...langs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVoices(lang: string): Promise<Voice[]> {
    const voices: Voice[] = [];
    for (const e of (await this.entries()).values()) {
      if (e.language.code !== lang) continue;
      const base = { lang, quality: e.quality };
      if (e.num_speakers <= 1) {
        voices.push({ ...base, id: e.key, name: e.name });
        continue;
      }
      // Multi-speaker models: expose each speaker as its own voice.
      const speakers = Object.entries(e.speaker_id_map).sort((a, b) => a[1] - b[1]);
      for (const [speaker, sid] of speakers.slice(0, MAX_SPEAKERS_PER_MODEL)) {
        voices.push({ ...base, id: `${e.key}#${sid}`, name: `${e.name} ${speaker}` });
      }
    }
    return voices;
  }

  load(voiceId: string, onProgress: ProgressFn): Promise<void> {
    return this.serial(async () => {
      await this.model(voiceId.split('#')[0], onProgress);
    });
  }

  synth(text: string, opts: SynthOptions): Promise<PCM> {
    return this.serial(async () => {
      const [key, sid] = opts.voice.split('#');
      const { ort, config, session } = await this.model(key);
      const ids = toIds(await this.phonemize(text, config.espeak.voice), config);
      const { noise_scale, length_scale, noise_w } = config.inference;
      const pcm = await run(ort, session, config, ids, [noise_scale, length_scale / opts.speed, noise_w], Number(sid ?? 0));
      return { pcm, sampleRate: config.audio.sample_rate };
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  private async model(key: string, onProgress?: ProgressFn): Promise<Loaded> {
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const entry = (await this.entries()).get(key);
    const onnxPath = entry && Object.keys(entry.files).find((f) => f.endsWith('.onnx'));
    if (!onnxPath) throw new Error(`Unknown Piper voice: ${key}`);

    const config = JSON.parse(new TextDecoder().decode(await cachedFetch(`${onnxPath}.json`))) as ModelConfig;
    const bytes = await cachedFetch(onnxPath, onProgress, entry.files[onnxPath].size_bytes);
    const ort = await loadRuntime();
    // Tell the page the engine is being started now, so it can notice if that never finishes.
    onProgress?.(1, 'engine');
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
    });

    if (this.loaded.size >= MAX_SESSIONS) {
      const [oldest, old] = this.loaded.entries().next().value!;
      this.loaded.delete(oldest);
      void old.session.release();
    }
    const loaded = { ort, config, session };
    this.loaded.set(key, loaded);
    return loaded;
  }

  /** Run espeak-ng (WASM) and return the phonemes of the text, one string per phoneme. */
  private async phonemize(text: string, espeakVoice: string): Promise<string[]> {
    const args = ['-l', espeakVoice, '--input', JSON.stringify([{ text: text.trim() }]), '--espeak_data', '/espeak-ng-data'];
    // The module leaks memory on every call and aborts after roughly 70, so replace it well before
    // that, and once more if a call fails anyway.
    for (let attempt = 0; ; attempt++) {
      if (this.phonemizerCalls >= PHONEMIZER_MAX_CALLS) this.phonemizer = null;
      if (!this.phonemizer) {
        this.phonemizerCalls = 0;
        this.phonemizer = createPiperPhonemize({
          print: (line) => this.lines.push(line),
          printErr: (line) => console.warn('piper-phonemize:', line),
          locateFile: (file) => (file.endsWith('.wasm') ? phonemizeWasmUrl : file.endsWith('.data') ? phonemizeDataUrl : file),
        });
      }
      try {
        const module = await this.phonemizer;
        this.phonemizerCalls++;
        this.lines = [];
        module.callMain(args);
        return this.lines.flatMap((line) => (JSON.parse(line).phonemes as string[]) ?? []);
      } catch (err) {
        this.phonemizer = null;
        if (attempt > 0) throw err;
      }
    }
  }
}

async function run(
  ort: typeof Ort,
  session: Ort.InferenceSession,
  config: ModelConfig,
  ids: number[],
  scales: number[],
  speakerId: number,
): Promise<Float32Array> {
  const feeds: Record<string, Ort.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
    scales: new ort.Tensor('float32', Float32Array.from(scales)),
  };
  if (config.num_speakers > 1) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speakerId)]));
  }
  const { output } = await session.run(feeds);
  return Float32Array.from(output.data as Float32Array);
}
