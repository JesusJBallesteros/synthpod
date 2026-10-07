// Text clean-up shared by the label detectors: timecodes, stage directions and markup.

const TC = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const LEADING_TC = new RegExp(String.raw`^\s*(?:\[${TC}\]|\(${TC}\)|${TC}(?=\s))\s*[-–—]?\s*`);
const BRACKET_TC = new RegExp(String.raw`\s*[\[(]${TC}[\])]`, 'g');
// f4/f5 transcription tools put the timecode at the end of the turn: "#00:02:17-8#".
const F4_TC = /\s*#\d{1,2}:\d{2}:\d{2}(?:[-.,]\d+)?#/g;

const DIRECTION_WORDS =
  /laugh|lach|inaudible|unintelligible|unv\.?$|unverst|cross-?talk|applau|beifall|music|musik|musique|música|pause|sigh|seufz|cough|hust|räusper|silence|noise|overlap|risas|rires|ininteligible|aplauso|chuckl|giggl|break|clears throat/i;
const SQUARE = /\s*\[([^\[\]\n]{1,40})\]/g;
const ROUND = /\s*\(([^()\n]{1,40})\)/g;

/** Remove a timecode at the start of a line, so the speaker label behind it can be seen. */
export function peelLeadingTimecode(line: string): string {
  return line.replace(LEADING_TC, '');
}

export function stripTimecodes(text: string): string {
  return text.replace(F4_TC, '').replace(BRACKET_TC, '');
}

export function isDirection(text: string): boolean {
  return DIRECTION_WORDS.test(text.trim());
}

/** Remove "(laughs)", "[inaudible]" and similar. Ordinary parentheses in speech are kept. */
export function stripDirections(text: string): string {
  return text.replace(SQUARE, '').replace(ROUND, (whole, inner: string) => (isDirection(inner) ? '' : whole));
}

/** Remove markdown emphasis, headings and quote markers, and subtitle tags such as <i>. */
export function stripMarkup(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/<\/?(?:[ibuc]|lang|ruby|rt)(?:[.\s][^>]*)?>/gi, '');
}

/** WebVTT voice tags become ordinary "Name: text" lines. */
export function convertVoiceTags(line: string): string {
  return line.replace(/<v(?:\.[\w.-]+)*\s+([^>]+)>/gi, '\n$1: ').replace(/<\/v>/gi, '').replace(/^\n/, '');
}

export function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
