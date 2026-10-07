import { describe, expect, it } from 'vitest';
import { findReviewItems, snippet } from './review';

const found = (text: string) => findReviewItems(text).map((i) => `${i.kind}:${i.text}`);

describe('findReviewItems', () => {
  it('finds numbers with their units and symbols', () => {
    expect(found('Anna: It cost $3.50 in 1999, up 20% over 5 km.')).toEqual(['numbers:$3.50', 'numbers:1999', 'numbers:20%', 'numbers:5 km']);
  });

  it('finds web addresses, abbreviations and acronyms once each', () => {
    expect(found('Ben: See https://example.org/2024/a, e.g. the NASA page by Dr. Lee etc.')).toEqual([
      'urls:https://example.org/2024/a',
      'abbreviations:e.g.',
      'acronyms:NASA',
      'abbreviations:Dr.',
      'abbreviations:etc.',
    ]);
  });

  it('skips timecodes and speaker labels', () => {
    expect(found('[00:12:03] ANNA: Hello at 5.\nBEN (COLD OPEN): Yes. #00:00:09-8#\nQ1: fine')).toEqual(['numbers:5']);
    expect(found('00:00:01,000 --> 00:00:03,000\nPlain text')).toEqual([]);
  });

  it('reports positions that point back into the text', () => {
    const text = 'Anna: First.\nBen: We grew 20% then.';
    const [item] = findReviewItems(text);
    expect(text.slice(item.start, item.end)).toBe('20%');
    expect(snippet(text, item)).toEqual({ before: 'Ben: We grew ', after: ' then.' });
  });
});
