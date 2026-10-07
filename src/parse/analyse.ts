import { francAll } from 'franc-min';
import type { Turn } from './parse';
import { wordCount } from './speakers';

// franc reports ISO 639-3; voices are organised by ISO 639-1 language family.
const ISO3_TO_1: Record<string, string> = {
  eng: 'en', deu: 'de', spa: 'es', fra: 'fr', ita: 'it', nld: 'nl', por: 'pt', pol: 'pl', rus: 'ru', ukr: 'uk',
  tur: 'tr', swe: 'sv', dan: 'da', nob: 'no', nno: 'no', fin: 'fi', ces: 'cs', ell: 'el', hun: 'hu', ron: 'ro',
  cat: 'ca', cmn: 'zh', arb: 'ar', vie: 'vi', slk: 'sk', slv: 'sl', srp: 'sr', bul: 'bg', kat: 'ka', kaz: 'kk',
  nep: 'ne', pes: 'fa', hin: 'hi', ind: 'id', heb: 'he', kor: 'ko', tha: 'th', urd: 'ur', lit: 'lt', lav: 'lv',
  swh: 'sw', isl: 'is', mal: 'ml', tel: 'te', hye: 'hy', cym: 'cy', ltz: 'lb',
};

export interface LanguageGuess {
  /** ISO 639-1 code, or null when the language is unknown or has no mapping. */
  family: string | null;
  confident: boolean;
}

const MIN_CHARS = 200;

export function detectLanguage(text: string): LanguageGuess | null {
  const sample = text.slice(0, 6000);
  if (sample.replace(/\s+/g, '').length < MIN_CHARS) return null; // too short to say anything
  const [first] = francAll(sample);
  // The runner-up score is no use as a confidence measure: related languages (Spanish and
  // Portuguese, say) score within 1-2% of each other even on clear text. So trust the best match
  // whenever it is a language we have voices for; the user sees the result and can change it.
  const family = first && first[0] !== 'und' ? (ISO3_TO_1[first[0]] ?? null) : null;
  return { family, confident: family !== null };
}

const WORDS_PER_MINUTE = 150;

/** Rough audio length in seconds, from the word count and each speaker's speed. */
export function estimateSeconds(turns: Turn[], speedFor: (speaker: string | null) => number): number {
  return turns.reduce((sum, t) => sum + (wordCount(t.text) / WORDS_PER_MINUTE / speedFor(t.speaker)) * 60, 0);
}

export interface Warning {
  kind: 'unlabelled' | 'long';
  count: number;
}

/**
 * Structural things worth a second look before rendering. Individual words that may be read
 * oddly (numbers, abbreviations...) are found by review.ts instead.
 */
export function findWarnings(turns: Turn[]): Warning[] {
  const found: Warning[] = [
    { kind: 'unlabelled', count: turns.some((t) => t.speaker) ? turns.filter((t) => !t.speaker).length : 0 },
    { kind: 'long', count: turns.filter((t) => wordCount(t.text) > 400).length },
  ];
  return found.filter((w) => w.count > 0);
}
