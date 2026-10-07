export interface Lang {
  code: string; // e.g. "en_US", "de_DE"
  name: string;
}

export interface Voice {
  id: string;
  name: string;
  lang: string;
  quality?: string;
  gender?: string;
  license?: string;
}

export interface PCM {
  pcm: Float32Array;
  sampleRate: number;
}

/** Progress of loading a voice: the downloaded fraction, then the engine being started. */
export type ProgressFn = (fraction: number, stage?: 'download' | 'engine') => void;

export interface SynthOptions {
  voice: string;
  speed: number;
}

export interface TTSEngine {
  id: string;
  languages(): Promise<Lang[]>;
  listVoices(lang: string): Promise<Voice[]>;
  load(voiceId: string, onProgress: ProgressFn): Promise<void>;
  synth(text: string, opts: SynthOptions): Promise<PCM>;
}
