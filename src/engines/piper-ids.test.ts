import { describe, expect, it } from 'vitest';
import { toIds } from './piper-ids';

const map = { _: [0], '^': [1], $: [2], a: [14], n: [26] };

describe('toIds', () => {
  it('wraps phonemes in BOS/EOS with pads between', () => {
    expect(toIds(['a', 'n'], { phoneme_id_map: map })).toEqual([1, 0, 14, 0, 26, 0, 2]);
  });

  it('drops phonemes the voice does not know instead of sending an out-of-range id', () => {
    // U+0329 (syllabic mark) is missing from voices with the smaller 130-symbol table.
    expect(toIds(['n', '\u0329', 'a'], { phoneme_id_map: map })).toEqual([1, 0, 26, 0, 14, 0, 2]);
  });
});
