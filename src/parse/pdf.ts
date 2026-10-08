// Turns the text of a PDF, as positioned glyph runs, into plain running text for one reader.
// It is aimed at simple documents such as papers and reports: page headers and footers, page
// numbers, footnotes, footnote markers and small print before the text starts are left out.
// The rules are heuristics; anything they cannot recognise is kept rather than dropped.

/** One run of text as pdf.js reports it. `y` grows upwards from the bottom of the page. */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
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
  page: number;
}

/** The most common value, weighted (here: font size by number of characters). */
function mode(entries: [value: number, weight: number][]): number {
  const totals = new Map<number, number>();
  for (const [value, weight] of entries) totals.set(value, (totals.get(value) ?? 0) + weight);
  return [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

const round = (n: number) => Math.round(n * 2) / 2;
const isMarker = (text: string) => /^[\d*†‡§]{1,3}$/.test(text.trim());
const endsSentence = (text: string) => /[.!?…:;"”»)\]]$/.test(text.trim());

/** Join the runs of one page into lines. Runs of one line are adjacent in the file. */
function toLines(page: PdfPage, pageIndex: number, bodySize: number): Line[] {
  const lines: Line[] = [];
  let current: { items: PdfItem[]; y: number } | null = null;
  const flush = () => {
    if (!current) return;
    let text = '';
    let end = -Infinity;
    const sizes: [number, number][] = [];
    for (const it of current.items) {
      // Runs that are visibly apart are separate words, even when neither carries a space.
      if (text && it.x - end > it.size * 0.2 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      end = it.x + it.width;
      sizes.push([round(it.size), it.str.trim().length]);
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) {
      const xs = current.items.filter((it) => it.str.trim());
      lines.push({
        text: trimmed,
        x: Math.min(...xs.map((it) => it.x)),
        right: Math.max(...xs.map((it) => it.x + it.width)),
        y: current.y,
        size: mode(sizes),
        page: pageIndex,
      });
    }
    current = null;
  };
  for (const it of page.items) {
    if (!it.str) continue;
    // Footnote and citation markers: small raised digits inside the text.
    if (isMarker(it.str) && it.size <= bodySize * 0.8) continue;
    // A bare space says nothing about where the line is (it may belong to a raised marker).
    if (!it.str.trim()) {
      if (current) current.items.push({ ...it, y: current.y });
      continue;
    }
    const previous = current ? [...current.items].reverse().find((p) => p.str.trim()) : undefined;
    const newColumn = previous !== undefined && it.x - (previous.x + previous.width) > Math.max(it.size, bodySize) * 1.8;
    if (current && (newColumn || Math.abs(it.y - current.y) > Math.max(it.size, bodySize) * 0.3)) flush();
    current ??= { items: [], y: it.y };
    current.items.push(it);
  }
  flush();
  return inReadingOrder(lines, page.width);
}

/**
 * Files do not always store text in reading order (a notice stamped on later comes last), so
 * order the lines by position: top to bottom, and for a two-column page the left column first.
 */
function inReadingOrder(lines: Line[], pageWidth: number): Line[] {
  const middle = pageWidth / 2;
  const startsRight = lines.filter((l) => l.x > middle).length;
  const staysLeft = lines.filter((l) => l.right < middle + pageWidth * 0.05).length;
  const twoColumns = lines.length >= 20 && startsRight >= lines.length * 0.3 && staysLeft >= lines.length * 0.3;
  const column = (l: Line) => (twoColumns && l.x > middle ? 1 : 0);
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

/** Compare titles loosely: without case, punctuation or a leading section number. */
const titleKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*\.?|[ivxlc]+\.)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Convert the pages of a PDF to text, with a blank line between paragraphs. Section headings
 * are written as "## Heading" lines, which the app turns into chapters.
 *
 * Headings come from the document's own outline (its bookmarks) when it has one that matches
 * the text; otherwise they are recognised by their look: one short line, set in capitals, in a
 * larger size, or starting with a section number.
 */
export function pdfToText(pages: PdfPage[], outline: string[] = []): string {
  const bodySize = mode(pages.flatMap((p) => p.items.map((it) => [round(it.size), it.str.trim().length] as [number, number])));
  const small = (line: Line) => line.size < bodySize * 0.92;
  const perPage = pages.map((page, i) => toLines(page, i, bodySize));
  const repeated = findRepeated(perPage, pages.map((p) => p.height));

  const kept: Line[] = [];
  perPage.forEach((lines, pageIndex) => {
    const height = pages[pageIndex].height;
    let body = lines.filter((line) => {
      if (repeated.has(`${line.page}|${line.y}|${line.text}`)) return false;
      // A lone page number in the top or bottom margin.
      const inMargin = line.y < height * 0.1 || line.y > height * 0.9;
      return !(inMargin && /^[-–—\s]*(?:p[áa]g(?:ina|e)?\.?\s*)?\d{1,4}(?:\s*(?:\/|de|of)\s*\d{1,4})?[-–—\s]*$/i.test(line.text));
    });
    // Footnotes: the small-print block at the foot of the page, below the last line of body text.
    const lowestBody = Math.min(...body.filter((l) => !small(l)).map((l) => l.y));
    if (Number.isFinite(lowestBody)) body = body.filter((l) => !(small(l) && l.y < lowestBody));
    // Small print above where the text begins on the first page (a legal notice, a watermark line).
    if (pageIndex === 0) {
      const highestBody = Math.max(...body.filter((l) => !small(l)).map((l) => l.y));
      if (Number.isFinite(highestBody)) body = body.filter((l) => !(small(l) && l.y > highestBody));
    }
    kept.push(...body);
  });
  if (!kept.length) return '';

  // Typical distance between lines and the left margin of the text, to recognise new paragraphs.
  const gaps: [number, number][] = [];
  for (let i = 1; i < kept.length; i++) {
    const gap = kept[i - 1].y - kept[i].y;
    if (kept[i].page === kept[i - 1].page && gap > 0) gaps.push([Math.round(gap), 1]);
  }
  const leading = mode(gaps) || bodySize * 1.2;
  const margin = mode(kept.filter((l) => !small(l)).map((l) => [Math.round(l.x), l.text.length]));
  const fullWidth = Math.max(...kept.map((l) => l.right));

  const paragraphs: { text: string; lines: number; size: number }[] = [];
  let current = '';
  let lineCount = 0;
  let largest = 0;
  const close = () => {
    if (current.trim()) paragraphs.push({ text: current.trim(), lines: lineCount, size: largest });
    current = '';
    lineCount = 0;
    largest = 0;
  };
  kept.forEach((line, i) => {
    const prev = kept[i - 1];
    if (prev) {
      const samePage = prev.page === line.page;
      const gap = prev.y - line.y;
      const indented = line.x > margin + 2 && prev.x <= margin + 2;
      // Two lines away from the margin at different positions: centred lines such as title and author.
      const realigned = line.x > margin + 2 && prev.x > margin + 2 && Math.abs(line.x - prev.x) > 2;
      const sameLine = samePage && Math.abs(gap) < 1;
      const breaks =
        !sameLine &&
        (realigned ||
          Math.abs(line.size - prev.size) > 0.6 || // heading against text, or the other way round
        (samePage && (gap > leading * 1.45 || gap < 0)) || // extra space, or a jump back up (new column)
        indented || // first-line indent
        // A line that stops well short of the right edge ends a paragraph if it ends a sentence,
        // or if the next line is aligned differently (a centred title followed by the author).
        (prev.right < fullWidth * 0.75 && (endsSentence(prev.text) || Math.abs(line.x - prev.x) > 2)) ||
        // A much shorter line with no closing punctuation, followed by a capital: a heading and its text.
        (prev.right < fullWidth * 0.6 && !/[,;:\-–—]$/.test(prev.text) && /^[\p{Lu}\d“"¿¡(]/u.test(line.text)));
      if (breaks) close();
    }
    lineCount++;
    largest = Math.max(largest, line.size);
    if (!current) current = line.text;
    else if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(line.text)) current = current.slice(0, -1) + line.text; // word split across lines
    else current += ` ${line.text}`;
  });
  close();

  // Centred text (a reference, a verse) is broken line by line above; put back together what is
  // plainly one sentence: a piece that does not end a sentence followed by one in lower case.
  const merged: typeof paragraphs = [];
  for (const p of paragraphs) {
    const last = merged[merged.length - 1];
    if (last && !/[.!?…:;"”»)\]]$/.test(last.text) && /^\p{Ll}/u.test(p.text)) {
      last.text = `${last.text} ${p.text}`;
      last.lines += p.lines;
    } else merged.push({ ...p });
  }

  const outlineKeys = new Set(outline.map(titleKey).filter((k) => k.length > 2));
  const useOutline = merged.filter((p) => outlineKeys.has(titleKey(p.text))).length >= 2;
  const isHeading = (p: (typeof merged)[number]): boolean => {
    if (useOutline) return outlineKeys.has(titleKey(p.text));
    const words = p.text.split(/\s+/).length;
    if (p.lines !== 1 || words > 14 || /[.:;,]$/.test(p.text)) return false;
    const capitals = p.text === p.text.toUpperCase() && /\p{L}{2}/u.test(p.text);
    const numbered = /^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+\p{Lu}/u.test(p.text);
    return capitals || numbered || p.size >= bodySize * 1.1;
  };

  let previousWasHeading = false;
  return merged
    .map((p) => {
      let text = p.text;
      // Several heading-like lines in a row (title, then author) make one chapter, not several.
      const heading = isHeading(p) && !previousWasHeading;
      previousWasHeading = isHeading(p);
      // A heading in capitals is read more naturally as an ordinary phrase.
      if (text.length < 120 && text === text.toUpperCase() && /\p{L}{2}/u.test(text)) {
        text = text.toLowerCase().replace(/\p{L}/u, (first) => first.toUpperCase());
      }
      if (heading) return `## ${text}`;
      // A short line on its own needs a full stop so that the voice pauses after it.
      return text.split(/\s+/).length <= 14 && !endsSentence(text) ? `${text}.` : text;
    })
    .join('\n\n');
}
