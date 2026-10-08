// Turns the text of a PDF, as positioned glyph runs, into plain running text for one reader.
// It is aimed at documents such as papers and reports: page headers and footers, page numbers,
// footnotes and their markers, side notes, small print before the text starts, figure captions,
// tables, boxes and the list of references are left out, and section headings are marked so that
// they become chapters.
// The rules are heuristics; anything they cannot recognise is kept rather than dropped.

/** One run of text as pdf.js reports it. `y` grows upwards from the bottom of the page. */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  /** True when the file ends a line after this run. */
  eol?: boolean;
  /** An identifier of the typeface, used to tell headings from text. */
  font?: string;
}

export interface PdfPage {
  width: number;
  height: number;
  items: PdfItem[];
}

interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
  font: string;
  page: number;
  /** Left edge and right edge of the column this line belongs to. */
  col: number;
  colRight: number;
  /** Whether most lines of that column end flush with its right edge. */
  justified: boolean;
}

interface Paragraph {
  text: string;
  lines: number;
  size: number;
  font: string;
}

/** The most common value, weighted (for example the font size by number of characters). */
function mode<T>(entries: [value: T, weight: number][]): T | undefined {
  const totals = new Map<T, number>();
  for (const [value, weight] of entries) totals.set(value, (totals.get(value) ?? 0) + weight);
  return [...totals].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const round = (n: number) => Math.round(n * 2) / 2;
/** A raised reference mark: "3", "12,13", "1–3", "*". */
const isMarker = (text: string) => /^[\d,\-–\s*†‡§✉]{1,12}$/.test(text) && /\S/.test(text);
const endsSentence = (text: string) => /[.!?…:;"”»)\]]$/.test(text.trim());
/** The label that opens a figure caption, a table or a box: "Fig. 2 |", "Table 1.", "Box 3:". */
const CAPTION = /^(?:Box|Fig(?:ure|\.)?|Table|Chart|Scheme|Tabla|Figura|Cuadro|Gráfico|Abb(?:ildung|\.)?|Tabelle|Tableau)\s*\d+\s*[|.:]/i;
const REFERENCE_HEADINGS = new Set(
  ['references', 'bibliography', 'workscited', 'literaturecited', 'bibliografía', 'bibliografia', 'referencias', 'referenciasbibliográficas', 'literatur', 'literaturverzeichnis', 'références', 'bibliographie'],
);

/** Compare titles loosely: without case, punctuation or a leading section number. */
const titleKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*\.?|[ivxlc]+\.)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Join the runs of one page into lines, in the order the file stores them. */
function toLines(page: PdfPage, pageIndex: number, bodySize: number): Line[] {
  const lines: Line[] = [];
  let current: { items: PdfItem[]; y: number } | null = null;
  const flush = () => {
    if (!current) return;
    let text = '';
    let end = -Infinity;
    // The size of a line is that of its largest words: a few smaller ones (a term set apart, a
    // cross-reference) do not make it small print, and a single large initial does not make it a title.
    const words = current.items.filter((it) => it.str.trim().length >= 3);
    const size = words.length ? Math.max(...words.map((it) => round(it.size))) : undefined;
    const sizes: [number, number][] = [];
    const fonts: [string, number][] = [];
    for (const it of current.items) {
      // Runs that are visibly apart are separate words, even when neither carries a space.
      if (text && it.x - end > it.size * 0.2 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      end = it.x + it.width;
      sizes.push([round(it.size), it.str.trim().length]);
      if (size === undefined || round(it.size) === size) fonts.push([it.font ?? '', it.str.trim().length]);
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    const inked = current.items.filter((it) => it.str.trim());
    if (trimmed && inked.length) {
      lines.push({
        text: trimmed,
        x: Math.min(...inked.map((it) => it.x)),
        right: Math.max(...inked.map((it) => it.x + it.width)),
        y: current.y,
        size: size ?? mode(sizes) ?? bodySize,
        font: mode(fonts) ?? '',
        page: pageIndex,
        col: 0,
        colRight: 0,
        justified: false,
      });
    }
    current = null;
  };
  let neighbour: PdfItem | undefined = page.items.find((it) => it.str.trim() && !isMarker(it.str));
  for (const it of page.items) {
    if (!it.str) {
      if (it.eol) flush();
      continue;
    }
    // Footnote and citation markers: raised digits, smaller than the words they follow.
    const marker = isMarker(it.str) && it.size <= bodySize * 0.8 && it.size <= (neighbour?.size ?? bodySize) * 0.8;
    if (!marker && it.str.trim()) neighbour = it;
    // A bare space says nothing about where the line is (it may belong to a raised marker).
    if (marker || !it.str.trim()) {
      if (!marker && current) current.items.push({ ...it, y: current.y });
      if (it.eol) flush();
      continue;
    }
    const previous = current ? [...current.items].reverse().find((p) => p.str.trim()) : undefined;
    // Two columns print lines at the same height; a wide gap on one height separates them.
    const newColumn = previous !== undefined && it.x - (previous.x + previous.width) > Math.max(it.size, bodySize) * 1.8;
    if (current && (newColumn || Math.abs(it.y - current.y) > Math.max(it.size, bodySize) * 0.3)) flush();
    current ??= { items: [], y: it.y };
    current.items.push(it);
    if (it.eol) flush();
  }
  flush();
  return orderLines(lines, page.width);
}

/**
 * Most files store text in reading order, column by column, and that order is kept. Some store
 * it row by row across the columns; those are re-ordered by position, left column first.
 */
function orderLines(lines: Line[], pageWidth: number): Line[] {
  let sideBySide = 0;
  for (let i = 1; i < lines.length; i++) {
    if (Math.abs(lines[i].y - lines[i - 1].y) < 1 && lines[i].x > lines[i - 1].right) sideBySide++;
  }
  if (lines.length < 8 || sideBySide < lines.length * 0.25) return lines;
  const middle = pageWidth / 2;
  const column = (l: Line) => (l.x > middle ? 1 : 0);
  return [...lines].sort((a, b) => column(a) - column(b) || b.y - a.y || a.x - b.x);
}

/** Lines in the top or bottom margin with the same words on most pages are running headers or footers. */
function findRepeated(pages: Line[][], heights: number[]): Set<string> {
  const seen = new Map<string, number>();
  const key = (line: Line) => `${Math.round(line.y / 4)}|${line.text.replace(/\d+/g, '#')}`;
  const inMargin = (line: Line) => line.y > heights[line.page] * 0.88 || line.y < heights[line.page] * 0.12;
  for (const lines of pages) for (const k of new Set(lines.filter(inMargin).map(key))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const needed = Math.max(3, Math.ceil(pages.length / 2));
  const repeated = new Set([...seen].filter(([, n]) => n >= needed).map(([k]) => k));
  return new Set(pages.flatMap((lines) => lines.filter((l) => inMargin(l) && repeated.has(key(l))).map((l) => `${l.page}|${l.y}|${l.text}`)));
}

/** Work out which column each line of a page sits in, from the left edges that many lines share. */
function assignColumns(lines: Line[]): void {
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(Math.round(l.x), (counts.get(Math.round(l.x)) ?? 0) + 1);
  const needed = Math.max(3, lines.length * 0.12);
  const starts = [...counts].filter(([, n]) => n >= needed).map(([x]) => x).sort((a, b) => a - b);
  // Edges a few points apart are one column whose paragraphs start with an indent.
  const columns = starts.filter((x, i) => i === 0 || x - starts[i - 1] > 40);
  const leftmost = Math.min(...lines.map((l) => l.x));
  for (const l of lines) l.col = [...columns].reverse().find((x) => x <= l.x + 2) ?? leftmost;
  for (const col of new Set(lines.map((l) => l.col))) {
    const members = lines.filter((l) => l.col === col);
    // The right edge is where most lines end; a title across the page may run past it.
    const edges = new Map<number, number>();
    for (const l of members) edges.set(Math.round(l.right), (edges.get(Math.round(l.right)) ?? 0) + 1);
    const [commonEdge, count] = [...edges].sort((a, b) => b[1] - a[1])[0];
    const right = count >= Math.max(3, members.length * 0.3) ? Math.max(...members.filter((l) => Math.round(l.right) === commonEdge).map((l) => l.right)) : Math.max(...members.map((l) => l.right));
    const flush = members.filter((l) => Math.abs(right - l.right) < 1.5).length;
    for (const l of members) {
      l.colRight = right;
      l.justified = members.length >= 6 && flush >= members.length * 0.3;
    }
  }
}

/**
 * Convert the pages of a PDF to text, with a blank line between paragraphs. Section headings
 * are written as "## Heading" lines, which the app turns into chapters.
 *
 * Headings come from the document's own outline (its bookmarks) when it has one that matches
 * the text; otherwise they are recognised by their look: one short line set in capitals, in a
 * larger size or a different typeface from the text, or starting with a section number.
 */
export function pdfToText(pages: PdfPage[], outline: string[] = []): string {
  const allItems = pages.flatMap((p) => p.items);
  const bodySize = mode(allItems.map((it) => [round(it.size), it.str.trim().length] as [number, number])) ?? 10;
  const bodyFont = mode(allItems.filter((it) => round(it.size) === bodySize).map((it) => [it.font ?? '', it.str.trim().length] as [string, number])) ?? '';
  const small = (line: Line) => line.size < bodySize * 0.92;
  const isText = (line: Line) => line.size >= bodySize * 0.97 && (line.font === bodyFont || bodyFont === '');
  const perPage = pages.map((page, i) => toLines(page, i, bodySize));
  const repeated = findRepeated(perPage, pages.map((p) => p.height));

  const kept: Line[] = [];
  perPage.forEach((lines, pageIndex) => {
    const height = pages[pageIndex].height;
    let body = lines.filter((line) => {
      if (repeated.has(`${line.page}|${line.y}|${line.text}`)) return false;
      const inMargin = line.y < height * 0.08 || line.y > height * 0.92;
      // Small print in the top or bottom margin: a running header or footer, even if it varies.
      if (inMargin && small(line)) return false;
      // A lone page number in the top or bottom margin.
      return !(inMargin && /^[-–—\s[\]()]*(?:p[áa]g(?:ina|e)?\.?\s*)?\d{1,4}(?:\s*(?:\/|de|of)\s*\d{1,4})?[-–—\s[\]()]*$/i.test(line.text));
    });
    // Figure captions, tables and boxes: a stretch of print smaller than the text that carries
    // such a label, with the labels inside the figure before it and the rows or paragraphs after it.
    const inset = new Set<Line>();
    for (let i = 0; i < body.length; i++) {
      if (isText(body[i]) || !CAPTION.test(body[i].text)) continue;
      let from = i;
      let to = i;
      while (from > 0 && !isText(body[from - 1])) from--;
      while (to < body.length - 1 && !isText(body[to + 1])) to++;
      for (let k = from; k <= to; k++) inset.add(body[k]);
    }
    body = body.filter((l) => !inset.has(l));
    const ownFace = body.filter(isText);
    const text = ownFace.length ? ownFace : body.filter((l) => !small(l));
    if (text.length) {
      // Side notes: small print wholly to the left or right of the text itself.
      const left = Math.min(...text.map((l) => l.x));
      const right = Math.max(...text.map((l) => l.right));
      body = body.filter((l) => !(small(l) && (l.right <= left || l.x >= right)));
      // Footnotes: the small-print block at the foot of the page, below the last line of text.
      const lowest = Math.min(...text.map((l) => l.y));
      body = body.filter((l) => !(small(l) && l.y < lowest));
      // Small print above where the text begins on the first page (a legal notice, a DOI line).
      if (pageIndex === 0) {
        const highest = Math.max(...text.map((l) => l.y));
        body = body.filter((l) => !(small(l) && l.y > highest));
      }
    }
    // Some files store the title and summary of the first page after the column beside them.
    if (pageIndex === 0) {
      const title = body.reduce((best, l, i) => (l.size > body[best].size ? i : best), 0);
      const before = body.slice(0, title);
      if (before.length && body[title].size >= bodySize * 1.3 && before.every((l) => l.y < body[title].y)) {
        const top = Math.max(...before.map((l) => l.y));
        let stop = title;
        while (stop < body.length && body[stop].y > top) stop++;
        body = [...body.slice(title, stop), ...before, ...body.slice(stop)];
      }
    }
    assignColumns(body);
    kept.push(...body);
  });
  if (!kept.length) return '';

  // Typical distance between the lines of a paragraph.
  const gaps: [number, number][] = [];
  for (let i = 1; i < kept.length; i++) {
    const gap = kept[i - 1].y - kept[i].y;
    if (kept[i].page === kept[i - 1].page && kept[i].col === kept[i - 1].col && gap > 0) gaps.push([Math.round(gap), 1]);
  }
  const leading = mode(gaps) ?? bodySize * 1.2;
  // Words and pairs of words seen inside lines, to judge what a word split across lines was.
  const known = new Set<string>();
  for (const l of kept) {
    const words = l.text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
    words.slice(1, -1).forEach((w) => known.add(w));
    for (let i = 1; i < words.length; i++) known.add(`${words[i - 1]} ${words[i]}`);
  }
  const indent = (l: Line) => l.x - l.col;
  const widthShare = (l: Line) => (l.right - l.col) / Math.max(1, l.colRight - l.col);

  const paragraphs: Paragraph[] = [];
  let current = '';
  let lineCount = 0;
  let first: Line | null = null;
  const close = () => {
    if (current.trim() && first) paragraphs.push({ text: current.trim(), lines: lineCount, size: first.size, font: first.font });
    current = '';
    lineCount = 0;
    first = null;
  };
  kept.forEach((line, i) => {
    const prev = kept[i - 1];
    let glue = ' ';
    if (prev) {
      const sameColumn = prev.page === line.page && prev.col === line.col;
      const gap = prev.y - line.y;
      const sameLine = sameColumn && Math.abs(gap) < 1;
      const short = widthShare(prev) < 0.75;
      const breaks =
        !sameLine &&
        (Math.abs(line.size - prev.size) > 0.6 || // heading against text, or the other way round
          (sameColumn && (gap > leading * 1.45 || gap < 0)) || // extra space between the two
          (indent(line) > 2 && indent(prev) <= 2) || // first-line indent
          // Two lines away from the margin at different positions: centred lines such as title and author.
          (indent(line) > 2 && indent(prev) > 2 && Math.abs(line.x - prev.x) > 2) ||
          // A line that stops well short of the right edge ends a paragraph if it ends a sentence,
          // or if the next line is aligned differently.
          (short && (endsSentence(prev.text) || Math.abs(indent(line) - indent(prev)) > 2)) ||
          // A much shorter line with no closing punctuation, followed by a capital: a heading and its text.
          (widthShare(prev) < 0.6 && !/[,;:\-–—]$/.test(prev.text) && /^[\p{Lu}\d“"¿¡(]/u.test(line.text)) ||
          // A short line in another typeface after some space: a heading following the text before it.
          (line.font !== prev.font && line.font !== bodyFont && widthShare(line) < 0.75 && (!sameColumn || gap > leading * 1.15) && /^[\p{Lu}\d¿¡]/u.test(line.text)) ||
          // And the text that follows such a heading.
          (lineCount === 1 && prev.font !== bodyFont && line.font === bodyFont && bodyFont !== '' && widthShare(prev) < 0.9 && !endsSentence(prev.text) && /^[\p{Lu}\d“"¿¡(]/u.test(line.text)));
      if (breaks) close();
      else if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(line.text)) {
        current = current.slice(0, -1); // a word split across lines
        glue = '';
      } else {
        // Some files leave the hyphen out: the line then stops a hyphen's width short of the edge.
        const shortBy = prev.colRight - prev.right;
        if (prev.justified && shortBy > prev.size * 0.2 && shortBy < prev.size * 0.75 && /\p{L}$/u.test(current) && /^\p{Ll}/u.test(line.text)) {
          // Two words of their own ("higher-order") stay apart; two halves of one word are joined.
          const head = current.match(/\p{L}+$/u)![0].toLowerCase();
          const tail = line.text.match(/^\p{L}+/u)![0].toLowerCase();
          if (!known.has(`${head} ${tail}`) && !(known.has(head) && known.has(tail))) glue = '';
        }
      }
    }
    lineCount++;
    if (!current) {
      current = line.text;
      first = line;
    } else current += glue + line.text;
  });
  close();

  // Centred text (a reference, a verse) is broken line by line above; put back together what is
  // plainly one sentence: a piece that does not end a sentence followed by one in lower case.
  let merged: Paragraph[] = [];
  for (const p of paragraphs) {
    p.text = p.text.replace(/^[•·▪■◦●]\s*/, '').replace(/\s*✉\s*/g, ' ').trim(); // an ornament, a list bullet, a contact mark
    if (!/[\p{L}\p{N}]/u.test(p.text)) continue;
    const last = merged[merged.length - 1];
    if (last && !/[.!?…:;"”»)\]]$/.test(last.text) && /^\p{Ll}/u.test(p.text) && Math.abs(last.size - p.size) <= 0.6) {
      last.text = `${last.text} ${p.text}`;
      last.lines += p.lines;
    } else merged.push({ ...p });
  }

  // The list of references is of no use to a listener: stop at its heading, or where a run of
  // numbered author-and-year entries begins in the last part of the document.
  const isEntry = (text: string) => /^\d{1,3}\.?\s+(?:(?:de|del|van|von|der|la|le)\s+)*\p{Lu}[\p{L}'’-]+,?\s+(?:\p{Lu}\.\s?)+/u.test(text);
  // An entry may come out in pieces (the journal in italics on its own), so look a little ahead.
  const entriesFrom = (i: number) => merged.slice(i, i + 10).filter((p) => isEntry(p.text)).length;
  let end = merged.findIndex((p, i) => i > merged.length * 0.4 && p.lines <= 2 && REFERENCE_HEADINGS.has(titleKey(p.text)));
  // The list can be longer than the text before it, so it may start early in the paragraph count.
  if (end < 0) end = merged.findIndex((p, i) => i >= 3 && isEntry(p.text) && entriesFrom(i) >= 4);
  if (end > 0) merged = merged.slice(0, end);

  const outlineKeys = new Set(outline.map(titleKey).filter((k) => k.length > 2));
  const useOutline = merged.filter((p) => outlineKeys.has(titleKey(p.text))).length >= 2;
  const isHeading = (p: Paragraph): boolean => {
    if (useOutline) return outlineKeys.has(titleKey(p.text));
    const words = p.text.split(/\s+/).length;
    if (p.lines !== 1 || words > 14 || /[.:;,]$/.test(p.text) || p.size < bodySize * 0.92) return false;
    if (!/^[\p{Lu}\d¿¡“"]/u.test(p.text)) return false;
    const capitals = p.text === p.text.toUpperCase() && /\p{L}{2}/u.test(p.text);
    const numbered = /^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+\p{Lu}/u.test(p.text);
    return capitals || numbered || p.size >= bodySize * 1.1 || (p.font !== bodyFont && bodyFont !== '');
  };

  // A heading with nothing after it (a date line before the references) is not a chapter.
  while (merged.length > 1 && isHeading(merged[merged.length - 1])) merged.pop();

  let previousWasHeading = false;
  return merged
    .map((p) => {
      let text = p.text;
      // Several heading-like lines in a row (title, then author) make one chapter, not several.
      const heading = isHeading(p) && !previousWasHeading;
      previousWasHeading = isHeading(p);
      // A heading in capitals is read more naturally as an ordinary phrase.
      if (text.length < 120 && text === text.toUpperCase() && /\p{L}{2}/u.test(text)) {
        text = text.toLowerCase().replace(/\p{L}/u, (letter) => letter.toUpperCase());
      }
      if (heading) return `## ${text}`;
      // A short line on its own needs a full stop so that the voice pauses after it.
      return text.split(/\s+/).length <= 14 && !endsSentence(text) ? `${text}.` : text;
    })
    .join('\n\n');
}
