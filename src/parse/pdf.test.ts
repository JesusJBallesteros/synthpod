import { describe, expect, it } from 'vitest';
import { parseTranscript } from './parse';
import { pdfToText, type PdfItem, type PdfPage } from './pdf';

/** One line of text as a single run; `chars` wide at half the font size per character. */
const run = (str: string, x: number, y: number, size = 12): PdfItem => ({ str, x, y, size, width: str.length * size * 0.5 });
const page = (items: PdfItem[]): PdfPage => ({ width: 595, height: 842, items });

const FULL = `X${'x'.repeat(69)}`; // a line that reaches the right margin
/** A paragraph of `n` full-width lines starting at height `y`, 20 apart, ending in `last`. */
const block = (y: number, n: number, last: string): PdfItem[] =>
  Array.from({ length: n }, (_, i) => run(i === n - 1 ? `${FULL} ${last}` : `${FULL} and on`, 85, y - i * 20));

describe('pdfToText', () => {
  it('joins lines into paragraphs at first-line indents and rejoins hyphenated words', () => {
    const text = pdfToText([
      page([
        run(`First paragraph starts here and it is quite a long line of ordinary te-`, 92, 700),
        run(`xt that continues on the second line, which is just as long as the one`, 85, 680),
        run(`before it, and then the paragraph ends here.`, 85, 660),
        run(`Second paragraph is indented and so it starts a new block of text, and`, 92, 640),
        run(`it also runs over more than a single line before it comes to its end,`, 85, 620),
        run(`which is here.`, 85, 600),
      ]),
    ]);
    expect(text).toBe(
      'First paragraph starts here and it is quite a long line of ordinary text that continues on the second line, which is just as long as the one before it, and then the paragraph ends here.\n\n' +
        'Second paragraph is indented and so it starts a new block of text, and it also runs over more than a single line before it comes to its end, which is here.',
    );
  });

  it('drops running headers, page numbers, footnotes and footnote markers', () => {
    const body = (n: number) => [
      run('Journal of Examples', 380, 818, 20),
      run(`Body text of page ${n} that fills the whole width of the line right here.`, 85, 700),
      run('It mentions a source.', 85, 680),
      run('1 ', 212, 684, 7.9), // raised marker, with its trailing space as a separate run below
      run(' ', 218, 684, 7.9),
      run('And continues after the marker.', 224, 680),
      run('1 ', 85, 125, 6),
      run('Some Author. A Book. City: Press, 2020, p. 10.', 90, 121, 10),
      run(String(n), 294, 39),
    ];
    const text = pdfToText([page(body(1)), page(body(2)), page(body(3))]);
    expect(text).not.toMatch(/Journal of Examples|Some Author|source\.\s*1/);
    expect(text).not.toMatch(/\d\s*$/); // no page number left at the end
    expect(text).toContain('It mentions a source. And continues after the marker.');
    expect(text.match(/Body text of page/g)).toHaveLength(3);
  });

  it('drops small print above the text on the first page, wherever the file stores it', () => {
    const text = pdfToText([
      page([
        run(`${FULL} and the article begins.`, 85, 400),
        run('The article goes on for a second line here.', 85, 380),
        // Stored after the body, as a stamp added later, but printed above it.
        run('NOTICE: this copy is for teaching use only.', 90, 760, 10),
      ]),
    ]);
    expect(text).not.toContain('NOTICE');
    expect(text).toContain('the article begins. The article goes on');
  });

  it('marks headings in capitals as sections and keeps centred lines apart', () => {
    const text = pdfToText([
      page([
        run('RECOVERING THE WORLD', 165, 500),
        run('JANE DOE', 245, 470),
        run(`${FULL} first sentence of the text.`, 85, 400),
        run('¿A HEADING?', 92, 360),
        run('More text follows the heading and ends here.', 92, 340),
      ]),
    ]);
    // The title opens a section; the author line right after it is not a second one.
    expect(text.split('\n\n').slice(0, 2)).toEqual(['## Recovering the world', 'Jane doe.']);
    expect(text).toContain('## ¿A heading?\n\nMore text follows');
  });

  it('reads a two-column page column by column', () => {
    const left = Array.from({ length: 12 }, (_, i) => run(`Left column line number ${i + 1} is here`, 60, 700 - i * 20, 10));
    const right = Array.from({ length: 12 }, (_, i) => run(`Right column line number ${i + 1} is here`, 320, 700 - i * 20, 10));
    // Interleaved in the file, as some tools write them.
    const text = pdfToText([page(left.flatMap((l, i) => [l, right[i]]))]);
    expect(text.indexOf('Left column line number 12')).toBeLessThan(text.indexOf('Right column line number 1 '));
  });

  it('recognises numbered and larger headings, but not ordinary short lines', () => {
    const text = pdfToText([
      page([
        run('A Study of Things', 150, 780, 18),
        ...block(740, 4, 'opening paragraph of the paper.'),
        run('1. Introduction', 85, 640),
        ...block(620, 4, 'the introduction says this.'),
        run('A short closing remark', 85, 520),
        ...block(480, 4, 'and the text goes on after it.'),
      ]),
    ]);
    expect(text.split('\n\n').filter((p) => p.startsWith('## '))).toEqual(['## A Study of Things', '## 1. Introduction']);
    expect(text).toContain('A short closing remark.'); // same size, no number, not capitals: just a line
  });

  it('prefers the outline of the document when it matches the text', () => {
    const pages = [
      page([
        run('SOME BANNER TEXT', 150, 780),
        ...block(740, 4, 'first paragraph.'),
        run('Background', 85, 640),
        ...block(620, 4, 'second paragraph.'),
        run('Findings and outlook', 85, 520),
        ...block(500, 4, 'third paragraph.'),
      ]),
    ];
    const withOutline = pdfToText(pages, ['1. Background', 'Findings and Outlook']);
    expect(withOutline.split('\n\n').filter((p) => p.startsWith('## '))).toEqual(['## Background', '## Findings and outlook']);
    // An outline that matches nothing is ignored, and the look of the lines decides again.
    expect(pdfToText(pages, ['Unrelated', 'Titles']).split('\n\n').filter((p) => p.startsWith('## '))).toEqual(['## Some banner text']);
  });

  it('leaves out figure captions, tables, boxes and side notes', () => {
    const text = pdfToText([
      page([
        ...block(740, 4, 'before the figure.').map((it) => ({ ...it, x: 150 })),
        run('Label inside the figure', 150, 640, 8),
        run('Fig. 1 | A drawing of the thing, explained', 150, 620, 9),
        run('over a second line of the caption.', 150, 608, 9),
        ...block(560, 4, 'after the figure.').map((it) => ({ ...it, x: 150 })),
        run('Side term', 20, 700, 8),
        run('explained', 20, 690, 8),
      ]),
    ]);
    expect(text).not.toMatch(/Label inside|Fig\.|caption|Side term|explained/);
    expect(text).toContain('before the figure.');
    expect(text).toContain('after the figure.');
  });

  it('recognises headings set in another typeface and stops at the list of references', () => {
    const body = (items: PdfItem[]) => items.map((it) => ({ ...it, font: 'body' }));
    const text = pdfToText([
      page([
        ...body(block(740, 4, 'the opening ends.')),
        { ...run('Methods of the study', 85, 640), font: 'bold' },
        ...body(block(620, 4, 'the methods end.')),
        ...body(block(520, 4, 'the closing words.')),
        ...body(
          ['Smith, J. A. First work. Journal 1, 2–3 (2001).', 'de Jong, P. Second work (Press, 2002).', 'Lee, K. & Park, S. Third work. Review 5, 6 (2003).', 'Mora, L. Fourth work. Annals 7, 8 (2004).'].map((entry, i) =>
            run(`${i + 1}. ${entry}`, 85, 420 - i * 20),
          ),
        ),
      ]),
    ]);
    expect(text.split('\n\n').filter((p) => p.startsWith('## '))).toEqual(['## Methods of the study']);
    expect(text).not.toMatch(/Smith|Fourth work/);
    expect(text.endsWith('the closing words.')).toBe(true);
  });

  it('rejoins words split across lines when the file leaves the hyphen out', () => {
    const fit = (start: string, end: string, length: number) => `${start} ${'x'.repeat(length - start.length - end.length - 2)} ${end}`;
    const lines = [
      fit('The higher order view is', 'here', 60),
      fit('This matters in', 'prac', 59), // one letter short of the edge: the missing hyphen
      fit('tice and also for', 'higher', 59),
      fit('order theories and', 'more', 60),
      fit('One more full line', 'follows', 60),
      fit('And another full line', 'follows', 60),
      'Then it ends.',
    ];
    const text = pdfToText([page(lines.map((line, i) => run(line, 85, 700 - i * 20)))]);
    expect(text).toContain(' practice and also'); // two halves of a word
    expect(text).toContain(' higher order theories'); // two words, seen together elsewhere
  });

  it('puts a title that the file stores after the text back in front', () => {
    const text = pdfToText([page([...block(500, 4, 'the text ends.'), run('The Title', 85, 760, 24), run('A summary of the paper in one line.', 85, 720)])]);
    expect(text.split('\n\n')[0]).toBe('## The Title');
    expect(text.indexOf('A summary')).toBeLessThan(text.indexOf('the text ends.'));
  });

  it('gives sections that the parser turns into titled turns', () => {
    const text = 'Front matter.\n\n## The first part\n\nBody one.\n\nMore of it.\n\n## Is this the end?\n\nBody two.';
    const { turns, speakers } = parseTranscript(text); // "auto": no speakers found, so read as sections
    expect(speakers).toEqual([]);
    expect(turns).toEqual([
      { speaker: null, text: 'Front matter.' },
      { speaker: null, text: 'The first part.\n\nBody one.\n\nMore of it.', title: 'The first part' },
      { speaker: null, text: 'Is this the end?\n\nBody two.', title: 'Is this the end?' },
    ]);
    // With speakers, a heading is only markup.
    const talk = parseTranscript('## Episode\nAnna: Hi.\nBen: Hello.\nAnna: Bye.\nBen: Bye.');
    expect(talk.speakers).toEqual(['Anna', 'Ben']);
    expect(talk.turns.every((turn) => turn.title === undefined)).toBe(true);
  });

  it('gives text that the transcript parser reads as one voice', () => {
    const text = 'Abstract: a short summary.\n\nKeywords: one, two.\n\nIntroduction. The text itself.';
    expect(parseTranscript(text).speakers).toEqual(['Abstract', 'Keywords']); // what "auto" would wrongly find
    const prose = parseTranscript(text, { hint: 'none' });
    expect(prose.speakers).toEqual([]);
    expect(prose.turns).toEqual([{ speaker: null, text }]);
  });
});
