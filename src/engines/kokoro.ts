import { KokoroTTS } from 'kokoro-js';
import type { Lang, PCM, ProgressFn, SynthOptions, TTSEngine, Voice } from './types';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const LANGS: Record<string, Lang> = {
  'en-us': { code: 'en_US', name: 'English (United States)' },
  'en-gb': { code: 'en_GB', name: 'English (Great Britain)' },
};

type VoiceInfo = { name: string; language: string; gender: string; overallGrade: string };

// The voice table is static, so it can be read without downloading the model.
const VOICES = (KokoroTTS.prototype as unknown as { voices: Record<string, VoiceInfo> }).voices;

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export class KokoroEngine implements TTSEngine {
  id = 'kokoro';
  private tts: Promise<KokoroTTS> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async languages(): Promise<Lang[]> {
    return Object.values(LANGS);
  }

  async listVoices(lang: string): Promise<Voice[]> {
    return Object.entries(VOICES)
      .filter(([, v]) => LANGS[v.language]?.code === lang)
      .map(([id, v]) => ({ id, name: v.name, lang, gender: v.gender, quality: `grade ${v.overallGrade}` }));
  }

  async load(_voiceId: string, onProgress: ProgressFn): Promise<void> {
    await this.model(onProgress);
  }

  synth(text: string, opts: SynthOptions): Promise<PCM> {
    const result = this.queue.then(async () => {
      const tts = await this.model();
      const audio = await tts.generate(text, { voice: opts.voice as never, speed: opts.speed });
      return { pcm: Float32Array.from(audio.audio), sampleRate: audio.sampling_rate };
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private model(onProgress?: ProgressFn): Promise<KokoroTTS> {
    this.tts ??= (async () => {
      const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx') && p.total) onProgress?.((p.loaded ?? 0) / p.total);
      };
      if (await hasWebGpu()) {
        try {
          return await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'webgpu', progress_callback });
        } catch (err) {
          console.warn('Kokoro: WebGPU failed, falling back to WASM.', err);
        }
      }
      return KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback });
    })();
    this.tts.catch(() => (this.tts = null));
    return this.tts;
  }
}
