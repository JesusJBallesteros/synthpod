// Turning dropped files and pasted rich text into plain transcript text.

const BLOCKS = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'PRE']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'NOSCRIPT']);

/** Convert copied web-page HTML to text, keeping paragraph breaks. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (SKIP.has(tag)) return;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) out += '\n\n';
    node.childNodes.forEach(walk);
    if (block) out += '\n\n';
  };
  walk(doc.body);
  return out
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CUE_TIMING = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->/;

/**
 * Reduce .srt / .vtt subtitles to their text. Cues are put on consecutive lines, so a speaker's
 * cues join into one turn; WebVTT <v Name> tags are kept for the parser to read as labels.
 */
export function subtitlesToText(raw: string): string {
  const lines: string[] = [];
  let skipBlock = false;
  let inCue = false;
  for (const line of raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      skipBlock = false;
      inCue = false;
    } else if (skipBlock) {
      // inside a NOTE / STYLE / REGION block
    } else if (CUE_TIMING.test(trimmed)) {
      inCue = true;
      // The line before a timing line is a cue number or identifier, not speech.
      if (lines.length && lines[lines.length - 1].startsWith('\u0000')) lines.pop();
    } else if (inCue) {
      lines.push(trimmed.replace(/\{\\[^}]*\}/g, ''));
    } else if (/^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(trimmed)) {
      skipBlock = !trimmed.startsWith('WEBVTT');
    } else {
      lines.push('\u0000' + trimmed); // possible cue identifier; dropped if a timing line follows
    }
  }
  return lines.filter((l) => !l.startsWith('\u0000')).join('\n');
}

export class UnsupportedFileError extends Error {
  constructor(public fileType: string) {
    super(`Unsupported file type: ${fileType}`);
  }
}

export interface LoadedTranscript {
  text: string;
  /** True for running text with no speakers (a paper, a report), to be read by one voice. */
  prose?: boolean;
  /** File name without its extension, used as the default MP3 name. */
  title: string;
}

export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.docx', '.srt', '.vtt', '.pdf'];

export async function readTranscriptFile(file: File): Promise<LoadedTranscript> {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  const title = (dot > 0 ? file.name.slice(0, dot) : file.name).trim() || 'transcript';
  if (ext === '.docx') {
    // @ts-expect-error mammoth ships its browser build without type declarations
    const mammoth = await import('mammoth/mammoth.browser.min.js');
    const result = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: result.value.trim(), title };
  }
  if (ext === '.pdf' || file.type === 'application/pdf') {
    // pdf.js is large, so it is only loaded when a PDF is opened.
    const [{ readPdf }, { pdfToText }] = await Promise.all([import('./pdf-read'), import('./pdf')]);
    const { pages, outline } = await readPdf(await file.arrayBuffer());
    return { text: pdfToText(pages, outline), title, prose: true };
  }
  if (ext === '.srt' || ext === '.vtt') return { text: subtitlesToText(await file.text()), title };
  if (ext === '.txt' || ext === '.md' || file.type.startsWith('text/')) return { text: await file.text(), title };
  throw new UnsupportedFileError(ext || file.type);
}
