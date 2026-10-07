import { nameKey, type Turn } from './parse';

export interface SpeakerStat {
  name: string;
  turns: number;
  words: number;
  /** Share of all words, 0..1. */
  share: number;
}

/** The user's corrections to what the parser detected. */
export interface Edits {
  /** Detected speaker name -> name to use. Renaming onto an existing name merges the two. */
  renames: Map<string, string>;
  /** Text of an unlabelled segment -> speaker, or '' to keep it as a separate voice. */
  assignments: Map<string, string>;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function resolveName(name: string, renames: Map<string, string>): string {
  let current = name;
  for (let i = 0; i < 10 && renames.has(current) && renames.get(current) !== current; i++) {
    current = renames.get(current)!;
  }
  return current;
}

export function applyEdits(turns: Turn[], edits: Edits): Turn[] {
  return turns.map((t) => {
    if (t.speaker) return { ...t, speaker: resolveName(t.speaker, edits.renames) };
    const assigned = edits.assignments.get(t.text) ?? suggestAssignment(turns, t) ?? '';
    return { ...t, speaker: assigned ? resolveName(assigned, edits.renames) : null };
  });
}

export function speakerStats(turns: Turn[]): SpeakerStat[] {
  const stats = new Map<string, SpeakerStat>();
  let total = 0;
  for (const t of turns) {
    if (!t.speaker) continue;
    const s = stats.get(t.speaker) ?? { name: t.speaker, turns: 0, words: 0, share: 0 };
    const words = wordCount(t.text);
    s.turns++;
    s.words += words;
    total += words;
    stats.set(t.speaker, s);
  }
  for (const s of stats.values()) s.share = total ? s.words / total : 0;
  return [...stats.values()];
}

/**
 * Names that probably mean the same person: "Weber" or "AW" next to "Anna Weber".
 * Only suggested when there is exactly one candidate to merge into.
 */
export function suggestMerges(names: string[]): { from: string; into: string }[] {
  const tokens = new Map(names.map((n) => [n, nameKey(n).split(/[\s.]+/).filter(Boolean)]));
  const out: { from: string; into: string }[] = [];
  for (const from of names) {
    const a = tokens.get(from)!;
    const candidates = names.filter((into) => {
      const b = tokens.get(into)!;
      if (into === from || b.length <= a.length) return false;
      const subset = a.every((t) => b.includes(t));
      const initials = a.length === 1 && a[0].length >= 2 && a[0] === b.map((t) => t[0]).join('');
      return subset || initials;
    });
    if (candidates.length === 1) out.push({ from, into: candidates[0] });
  }
  return out;
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A cold-open teaser usually repeats words someone says later; if so, suggest that speaker. */
export function suggestAssignment(turns: Turn[], unlabelled: Turn): string | null {
  const probe = squash(unlabelled.text).slice(0, 80);
  if (probe.length < 25) return null;
  const match = turns.find((t) => t.speaker && squash(t.text).includes(probe));
  return match?.speaker ?? null;
}

/** The host tends to speak first and to ask the questions. Used only as a hint. */
export function guessHost(turns: Turn[]): string | null {
  const asked = new Map<string, { turns: number; questions: number }>();
  for (const t of turns) {
    if (!t.speaker) continue;
    const s = asked.get(t.speaker) ?? { turns: 0, questions: 0 };
    s.turns++;
    if (/\?\s*$/.test(t.text)) s.questions++;
    asked.set(t.speaker, s);
  }
  if (asked.size < 2) return null;
  const ranked = [...asked].filter(([, s]) => s.turns >= 2).sort((a, b) => b[1].questions / b[1].turns - a[1].questions / a[1].turns);
  const [top, second] = ranked;
  if (!top || top[1].questions / top[1].turns < 0.25) return null;
  if (second && second[1].questions / second[1].turns >= top[1].questions / top[1].turns) return null;
  return top[0];
}
