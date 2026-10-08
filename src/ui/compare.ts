/** One turn of the transcript next to its translation. */
export interface CompareRow {
  speaker: string | null;
  /** True when this turn opens a section, so its first line is a heading. */
  section?: boolean;
  original: string;
  translated: string;
}

/**
 * Draw the original and the translation turn by turn, side by side (stacked on narrow screens).
 * The translation is editable; the returned function reads the current text of every turn.
 */
export function renderCompare(root: HTMLElement, rows: CompareRow[], labels: { original: string; translation: string }): () => string[] {
  const head = document.createElement('div');
  head.className = 'compare-head';
  head.append(Object.assign(document.createElement('span'), { textContent: labels.original }), Object.assign(document.createElement('span'), { textContent: labels.translation }));

  const areas: HTMLTextAreaElement[] = [];
  const body = rows.map((row) => {
    const wrap = document.createElement('div');
    wrap.className = 'compare-row';
    if (row.speaker) wrap.append(Object.assign(document.createElement('strong'), { textContent: row.speaker }));
    const original = Object.assign(document.createElement('p'), { textContent: row.original });
    const area = Object.assign(document.createElement('textarea'), {
      value: row.translated,
      spellcheck: false,
      ariaLabel: row.speaker ? `${labels.translation}: ${row.speaker}` : labels.translation,
      // Fallback height for browsers without "field-sizing: content".
      rows: Math.max(2, Math.ceil(row.translated.length / 55)),
    });
    areas.push(area);
    wrap.append(original, area);
    return wrap;
  });
  root.replaceChildren(head, ...body);
  return () => areas.map((a) => a.value.trim());
}
