/// <reference lib="webworker" />
import { PiperEngine } from './piper';
import type { TTSEngine } from './types';

export type TtsRequest =
  | { id: number; engine: string; type: 'languages' }
  | { id: number; engine: string; type: 'listVoices'; lang: string }
  | { id: number; engine: string; type: 'load'; voice: string }
  | { id: number; engine: string; type: 'synth'; text: string; voice: string; speed: number };

export type TtsResponse =
  | { id: number; type: 'progress'; fraction: number; stage?: 'download' | 'engine' }
  | { id: number; type: 'done'; result: unknown }
  | { id: number; type: 'error'; message: string };

// Kokoro pulls in transformers.js, so it is only imported when first used.
const factories: Record<string, () => Promise<TTSEngine>> = {
  piper: async () => new PiperEngine(),
  kokoro: async () => new (await import('./kokoro')).KokoroEngine(),
};
const engines = new Map<string, Promise<TTSEngine>>();

function getEngine(id: string): Promise<TTSEngine> {
  if (!factories[id]) throw new Error(`Unknown engine: ${id}`);
  if (!engines.has(id)) engines.set(id, factories[id]());
  return engines.get(id)!;
}
const post = (msg: TtsResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

// onnxruntime starts its helper threads as workers too. If one of them ever loads this file
// (it happens when a bundler merges the runtime into it), it must not take over their messages.
const isRuntimeThread = self.name === 'em-pthread';

if (!isRuntimeThread) self.onmessage = async (e: MessageEvent<TtsRequest>) => {
  const req = e.data;
  try {
    const engine = await getEngine(req.engine);
    switch (req.type) {
      case 'languages':
        return post({ id: req.id, type: 'done', result: await engine.languages() });
      case 'listVoices':
        return post({ id: req.id, type: 'done', result: await engine.listVoices(req.lang) });
      case 'load':
        await engine.load(req.voice, (fraction, stage) => post({ id: req.id, type: 'progress', fraction, stage }));
        return post({ id: req.id, type: 'done', result: null });
      case 'synth': {
        const out = await engine.synth(req.text, { voice: req.voice, speed: req.speed });
        return post({ id: req.id, type: 'done', result: out }, [out.pcm.buffer]);
      }
    }
  } catch (err) {
    post({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
