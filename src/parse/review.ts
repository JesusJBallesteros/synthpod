// Finds the places in a transcript that voices tend to read oddly, with their positions, so the
// interface can step through them.

export type ReviewKind = 'numbers' | 'urls' | 'abbreviations' | 'acronyms';

export interface ReviewItem {
  kind: ReviewKind;
  start: number;
  end: number;
  text: string;
}

const TIMECODE = /#\d{1,2}:\d{2}:\d{2}(?:[-.,]\d+)?#|[\[(]?\b(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b[\])]?(?:\s*-->\s*[\d:.,]+)?/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s,;)]*[^\s,;).!?:]/gi;
// Digits with their separators and an attached unit or symbol: "3.50", "1,200", "20%", "5km", "$40", "1990s".
const NUMBER = /[$€£]?\d(?:[\d.,/:-]*\d)?(?:(?:st|nd|rd|th|s)(?![\p{L}])|\s?(?:%|°[CF]?|[€$£]|(?:km|kg|cm|mm|ml|kHz|Hz|GB|MB|TB)(?![\p{L}])))?/gu;
const ABBREVIATION = /(?<![\p{L}\p{N}])(?:(?:\p{L}{1,3}\.\s?){2,}|(?:etc|vs|approx|ca|bzw|usw|evtl|ggf|Nr|No|Prof|Dr|Mr|Mrs|Ms|Sr|Sra|Dra|Uds?|Mme)\.)/gu;
// Words in capitals may be spelled out or pronounced as a word: "NASA", "SQL", "UNESCO".
const ACRONYM = /(?<![\p{L}\p{N}])\p{Lu}{2,6}(?![\p{L}\p{N}])/gu;
const LABEL_AT_LINE_START = /^[ \t]*(?:[\[(]?[\d:.,]+[\])]?[ \t]*[-–—]?[ \t]*)?(?:\*\*|\[)?[^\s:()\[\]][^:\n()\[\]]{0,39}?(?:\s*\([^)\n]{1,40}\))?\s*(?:\]|:|\s[—–-]\s)/gm;

interface Range {
  start: number;
  end: number;
}

function ranges(text: string, pattern: RegExp): Range[] {
  return [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

const overlaps = (a: Range, list: Range[]) => list.some((b) => a.start < b.end && b.start < a.end);

/**
 * Locate the items worth checking. Timecodes are skipped (they are removed before speaking) and
 * so is whatever sits in a speaker label at the start of a line.
 */
export function findReviewItems(text: string): ReviewItem[] {
  const ignored = [...ranges(text, TIMECODE), ...ranges(text, LABEL_AT_LINE_START)];
  const items: ReviewItem[] = [];
  const taken: Range[] = [];
  const collect = (kind: ReviewKind, pattern: RegExp) => {
    for (const r of ranges(text, pattern)) {
      while (r.end > r.start && /\s/.test(text[r.end - 1])) r.end--;
      // Earlier kinds win, so the digits inside a web address are not listed again as a number.
      if (overlaps(r, ignored) || overlaps(r, taken)) continue;
      taken.push(r);
      items.push({ kind, ...r, text: text.slice(r.start, r.end) });
    }
  };
  collect('urls', URL);
  collect('abbreviations', ABBREVIATION);
  collect('numbers', NUMBER);
  collect('acronyms', ACRONYM);
  return items.sort((a, b) => a.start - b.start);
}

/** The item with some words around it, for showing in context. */
export function snippet(text: string, item: Range, radius = 45): { before: string; after: string } {
  const lineStart = text.lastIndexOf('\n', item.start - 1) + 1;
  const lineEnd = text.indexOf('\n', item.end);
  const from = Math.max(lineStart, item.start - radius);
  const to = Math.min(lineEnd < 0 ? text.length : lineEnd, item.end + radius);
  return {
    before: (from > lineStart ? '…' : '') + text.slice(from, item.start),
    after: text.slice(item.end, to) + (to < (lineEnd < 0 ? text.length : lineEnd) ? '…' : ''),
  };
}
