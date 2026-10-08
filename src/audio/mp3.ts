import type { Mp3Request, Mp3Response, Mp3Tags } from './mp3.worker';

export type { Mp3Tags };

export interface Mp3Options {
  sampleRate: number;
  kbps: number;
  stereo: boolean;
  tags: Mp3Tags;
}

/** Encode mono PCM to a single tagged MP3 in one pass, off the main thread. */
export function encodeMp3(pcm: Float32Array, options: Mp3Options, onProgress: (fraction: number) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The MP3 encoder failed.'));
    };
    worker.onmessage = (e: MessageEvent<Mp3Response>) => {
      if (e.data.type === 'progress') return onProgress(e.data.fraction);
      worker.terminate();
      resolve(new Blob([e.data.file], { type: 'audio/mpeg' }));
    };
    worker.postMessage({ pcm, ...options } satisfies Mp3Request, [pcm.buffer]);
  });
}

export interface FileKind {
  description: string;
  mime: string;
  extension: string;
}

export const MP3_FILE: FileKind = { description: 'MP3 audio', mime: 'audio/mpeg', extension: '.mp3' };

/** Save a file; resolves to the name it was saved under, or null if the user cancelled. */
export async function saveBlob(blob: Blob, suggestedName: string, kind: FileKind = MP3_FILE): Promise<string | null> {
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: kind.description, accept: { [kind.mime]: [kind.extension] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return handle.name as string;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      // fall through to the download link
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggestedName;
}
