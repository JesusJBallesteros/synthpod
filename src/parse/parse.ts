import { convertVoiceTags, isDirection, peelLeadingTimecode, stripDirections, stripMarkup, stripTimecodes, tidy } from './clean';

export interface Turn {
  speaker: string | null; // null = unassigned
  text: string;
}

export type FormatHint = 'auto' | 'inline' | 'ownline';
export type Format = 'inline' | 'ownline' | 'bracket' | 'dash' | 'none';

export interface ParseOptions {
  hint: FormatHint;
  stripTimecodes: boolean;
  stripDirections: boolean;
  /** Keep only the N most frequent labels as speakers; 0 = no limit. */
  expectedSpeakers: number;
}

export interface ParseResult {
  turns: Turn[];
  /** Speaker names in order of first appearance. */
  speakers: string[];
  format: Format;
}

const DEFAULTS: ParseOptions = { hint: 'auto', stripTimecodes: true, stripDirections: true, expectedSpeakers: 0 };

// A label: 1-4 words, at most 40 characters, optionally followed by a parenthetical such as "(COLD OPEN)".
const LABEL = String.raw`([^\s:()\[\]][^:\n()\[\]]{0,39}?)(?:\s*\([^)\n]{1,40}\))?`;
const COLON_RE = new RegExp(String.raw`^${LABEL}\s*:(?!\/\/)\s*(.*)$`);
const BRACKET_RE = new RegExp(String.raw`^\[${LABEL}\]\s*:?\s*(.*)$`);
const DASH_RE = new RegExp(String.raw`^${LABEL}\s+[—–-]\s+(\S.*)$`);

const TITLES = /^(?:(?:prof|dr|mr|mrs|ms|herr|frau|sr|sra|mme|mag|ing|dipl\.-ing)\.?\s+)+/i;

type Detector = 'colon' | 'inline' | 'ownline' | 'bracket' | 'dash';

function validLabel(label: string): boolean {
  const words = label.trim().split(/\s+/);
  return words.length <= 4 && /\p{L}/u.test(label) && !/[,;!?"“”<>]/.test(label) && !isDirection(label);
}

/** "Prof. Dr. Anna Weber" and "anna weber" are the same speaker. */
export function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.replace(TITLES, '') || name;
}

export function nameKey(raw: string): string {
  return cleanName(raw).toUpperCase();
}

function matchLabel(line: string, detector: Detector): { label: string; rest: string } | null {
  const re = detector === 'bracket' ? BRACKET_RE : detector === 'dash' ? DASH_RE : COLON_RE;
  const m = re.exec(line);
  if (!m || !validLabel(m[1])) return null;
  const rest = m[2].trim();
  if (detector === 'inline' && !rest) return null;
  if (detector === 'ownline' && rest) return null;
  return { label: m[1], rest };
}

interface Candidate {
  turns: Turn[];
  labelled: number;
  ownLine: number;
}

function run(lines: string[], detector: Detector, opts: ParseOptions): Candidate {
  const turns: Turn[] = [];
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  let ownLine = 0;
  let current: Turn | null = null;

  for (const raw of lines) {
    const line = peelLeadingTimecode(stripMarkup(raw)).trim();
    const m = matchLabel(line, detector);
    if (m) {
      // Match case-insensitively, but show the name as first written.
      const key = nameKey(m.label);
      if (!display.has(key)) display.set(key, cleanName(m.label));
      const name = display.get(key)!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (!m.rest) ownLine++;
      current = { speaker: name, text: m.rest };
      turns.push(current);
    } else if (line === '') {
      if (current?.text && !current.text.endsWith('\n\n')) current.text += '\n\n';
    } else {
      if (!current) {
        current = { speaker: null, text: '' };
        turns.push(current);
      }
      const joinWithSpace = current.text !== '' && !current.text.endsWith('\n\n');
      current.text += (joinWithSpace ? ' ' : '') + line;
    }
  }

  // Labels seen only once are probably not speakers ("Note:", "Example:"), and neither are the
  // rarer ones when the user said how many speakers to expect.
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  let keep = new Set(ranked.filter(([, n]) => n >= 2).map(([name]) => name));
  // Nobody speaks twice: accept the labels only if there are at least two different ones.
  if (keep.size === 0 && counts.size >= 2) keep = new Set(counts.keys());
  // A one-off label made only of words from a speaker's name ("Weber" next to "Anna Weber") is
  // that speaker written differently, so keep it for the merge suggestion.
  const keptWords = new Set([...keep].flatMap((name) => nameKey(name).split(/\s+/)));
  for (const [name] of ranked) {
    if (!keep.has(name) && nameKey(name).split(/\s+/).every((w) => keptWords.has(w))) keep.add(name);
  }
  if (opts.expectedSpeakers > 0) keep = new Set(ranked.slice(0, opts.expectedSpeakers).map(([name]) => name));

  const kept: Turn[] = [];
  let labelled = 0;
  for (const t of turns) {
    if (t.speaker && !keep.has(t.speaker)) {
      // Not a speaker after all: give the text back to whoever was talking.
      const text = `${t.speaker}: ${t.text}`;
      const prev = kept[kept.length - 1];
      if (prev) prev.text += (prev.text.endsWith('\n\n') ? '' : ' ') + text;
      else kept.push({ speaker: null, text });
    } else {
      kept.push(t);
      if (t.speaker) labelled++;
    }
  }

  const cleaned = kept
    .map((t) => {
      let text = t.text;
      if (opts.stripTimecodes) text = stripTimecodes(text);
      if (opts.stripDirections) text = stripDirections(text);
      return { speaker: t.speaker, text: tidy(text) };
    })
    .filter((t) => /[\p{L}\p{N}]/u.test(t.text));
  return { turns: cleaned, labelled, ownLine };
}

export function parseTranscript(input: string, options: Partial<ParseOptions> = {}): ParseResult {
  const opts = { ...DEFAULTS, ...options };
  const lines = input.replace(/\r\n?/g, '\n').split('\n').flatMap((l) => convertVoiceTags(l).split('\n'));
  // Run every detector and keep the one that labels the most turns.
  const detectors: Detector[] = opts.hint === 'auto' ? ['colon', 'bracket', 'dash'] : [opts.hint];
  let best: { detector: Detector; cand: Candidate } | null = null;
  for (const detector of detectors) {
    const cand = run(lines, detector, opts);
    if (!best || cand.labelled > best.cand.labelled) best = { detector, cand };
  }
  const { detector, cand } = best!;
  if (cand.labelled === 0) return { turns: cand.turns, speakers: [], format: 'none' };
  const format: Format = detector === 'colon' ? (cand.ownLine > cand.labelled / 2 ? 'ownline' : 'inline') : detector;
  const speakers = [...new Set(cand.turns.flatMap((t) => (t.speaker ? [t.speaker] : [])))];
  return { turns: cand.turns, speakers, format };
}
