import type { TranslateRequest, TranslateResponse } from './translate.worker';

export interface TranslateCallbacks {
  onDownload(fraction: number): void;
  onProgress(done: number, total: number): void;
}

let worker: Worker | null = null;

/** Translate texts one by one in a worker. Abort the signal to stop; the worker is then discarded. */
export function translate(request: TranslateRequest, callbacks: TranslateCallbacks, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // The worker is kept between runs so a loaded model does not have to be loaded again.
    worker ??= new Worker(new URL('./translate.worker.ts', import.meta.url), { type: 'module' });
    const current = worker;
    const stop = (error: Error) => {
      current.terminate();
      if (worker === current) worker = null;
      reject(error);
    };
    signal.addEventListener('abort', () => stop(new DOMException('Aborted', 'AbortError')), { once: true });
    current.onerror = (e) => stop(new Error(e.message || 'The translation engine failed to start.'));
    current.onmessage = (e: MessageEvent<TranslateResponse>) => {
      const msg = e.data;
      if (msg.type === 'download') callbacks.onDownload(msg.fraction);
      else if (msg.type === 'progress') callbacks.onProgress(msg.done, msg.total);
      else if (msg.type === 'done') resolve(msg.results);
      else stop(new Error(msg.message));
    };
    current.postMessage(request);
  });
}
