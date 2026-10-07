/// <reference lib="webworker" />
import { pipeline, type TranslationPipeline } from '@huggingface/transformers';

export interface TranslateRequest {
  /** One model for a direct pair, two when translating through English. */
  models: string[];
  texts: string[];
}

export type TranslateResponse =
  | { type: 'download'; fraction: number }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; results: string[] }
  | { type: 'error'; message: string };

const post = (msg: TranslateResponse) => self.postMessage(msg);
// The library's own overloads for pipeline() are too large for the type checker to resolve.
const createPipeline = pipeline as unknown as (task: 'translation', model: string, options: object) => Promise<TranslationPipeline>;
const loaded = new Map<string, Promise<TranslationPipeline>>();

function load(model: string): Promise<TranslationPipeline> {
  if (!loaded.has(model)) {
    // Several files download at once; report the overall fraction across them.
    const files = new Map<string, { loaded: number; total: number }>();
    const pending = createPipeline('translation', model, {
      dtype: 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return;
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let done = 0;
        let total = 0;
        for (const f of files.values()) {
          done += f.loaded;
          total += f.total;
        }
        post({ type: 'download', fraction: done / total });
      },
    });
    pending.catch(() => loaded.delete(model));
    loaded.set(model, pending);
  }
  return loaded.get(model)!;
}

self.onmessage = async (e: MessageEvent<TranslateRequest>) => {
  const { models, texts } = e.data;
  try {
    const pipes = [];
    for (const model of models) pipes.push(await load(model));
    const results: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      let text = texts[i];
      for (const translate of pipes) {
        const out = (await translate(text, { max_new_tokens: 512 } as never)) as { translation_text: string }[];
        text = out[0].translation_text;
      }
      results.push(text);
      post({ type: 'progress', done: i + 1, total: texts.length });
    }
    post({ type: 'done', results });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
