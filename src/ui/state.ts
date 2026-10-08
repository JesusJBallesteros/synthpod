// What the page knows at any moment, shared by the parts of the interface.

import { WorkerEngine } from '../engines/client';
import type { Lang, TTSEngine } from '../engines/types';
import type { DictionaryEntry } from '../parse/normalise';
import type { ParseResult, Turn } from '../parse/parse';
import type { Edits, SpeakerStat } from '../parse/speakers';
import { DEFAULT_SETTINGS, loadStored, type Preset, type Settings, type SpeakerCast } from './settings';

// Internal names for the two voices that are not a detected speaker; shown translated.
export const UNASSIGNED = 'Unassigned';
export const NARRATOR = 'Narrator';
export const ENGINE_NAMES: Record<string, string> = { piper: 'Piper', kokoro: 'Kokoro' };
export type Theme = 'system' | 'light' | 'dark';

export const engines: Record<string, TTSEngine> = { piper: new WorkerEngine('piper'), kokoro: new WorkerEngine('kokoro') };
/** The languages each engine can speak, filled in once the engines have answered. */
export const engineLangs = new Map<string, Set<string>>();
// Voices are remembered by speaker name, so a returning host keeps their voice.
export const casting = new Map<string, SpeakerCast>(Object.entries(loadStored<Record<string, SpeakerCast>>('casting', {})));
export const settings: Settings = { ...DEFAULT_SETTINGS, ...loadStored<Partial<Settings>>('settings', {}) };
export const dictionary = loadStored<DictionaryEntry[]>('dictionary', []);
export const presets = loadStored<Record<string, Preset>>('presets', {});
export const edits: Edits = { renames: new Map(), assignments: new Map() };
export const dismissedMerges = new Set<string>();

export const state = {
  languages: [] as Lang[],
  catalogueError: null as string | null,
  /** The transcript as parsed, before the user's renames and assignments. */
  detected: { turns: [], speakers: [], format: 'none' } as ParseResult,
  turns: [] as Turn[],
  stats: [] as SpeakerStat[],
  title: 'transcript',
  /** Whether the user chose the transcript language by hand. */
  languageTouched: false,
  /** Set while a render is running. */
  rendering: null as AbortController | null,
};

let refreshPage: () => Promise<void> = async () => {};
/** Read the transcript again and redraw everything that depends on it. */
export const refresh = (): Promise<void> => refreshPage();
export function setRefresh(fn: () => Promise<void>): void {
  refreshPage = fn;
}
