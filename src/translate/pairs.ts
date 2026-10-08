// Which Opus-MT translation models exist, and how to get from one language to another.
// The list was checked against the Xenova/opus-mt-* repositories on Hugging Face.

const DIRECT = new Set(
  (
    'ar-en cs-en da-en de-en fi-en fr-en hi-en hu-en id-en it-en ja-en ko-en nl-en pl-en ru-en sv-en tr-en uk-en vi-en zh-en es-en ' +
    'en-ar en-cs en-da en-de en-es en-fi en-fr en-hi en-hu en-id en-it en-nl en-ro en-ru en-sv en-uk en-vi en-zh ' +
    'de-es de-fr es-de es-fr es-it es-ru fr-de fr-es fr-ro fr-ru it-es it-fr nl-fr ro-fr ru-es ru-fr'
  ).split(' '),
);

const model = (pair: string) => `Xenova/opus-mt-${pair}`;

/**
 * The models to run, in order, to translate between two ISO 639-1 languages: one for a direct
 * pair, two when it has to go through English, or null when there is no way.
 */
export function route(from: string, to: string): string[] | null {
  if (from === to) return null;
  if (DIRECT.has(`${from}-${to}`)) return [model(`${from}-${to}`)];
  if (DIRECT.has(`${from}-en`) && DIRECT.has(`en-${to}`)) return [model(`${from}-en`), model(`en-${to}`)];
  return null;
}

/** Every language reachable from `from`, direct pairs first. */
export function targetsFor(from: string): string[] {
  const all = new Set([...DIRECT].flatMap((pair) => pair.split('-')));
  const reachable = [...all].filter((to) => route(from, to));
  return reachable.sort((a, b) => route(from, a)!.length - route(from, b)!.length || a.localeCompare(b));
}

export interface TranslationUnit {
  /** Index of the turn and of the paragraph within it. */
  turn: number;
  paragraph: number;
  text: string;
}

/** Join translated sentences back into one text per turn, keeping its paragraphs. */
export function rebuildTurns(turnCount: number, units: TranslationUnit[], translated: string[]): string[] {
  const turns: string[][][] = Array.from({ length: turnCount }, () => []);
  units.forEach((unit, i) => {
    (turns[unit.turn][unit.paragraph] ??= []).push(translated[i].trim());
  });
  return turns.map((paragraphs) => paragraphs.filter(Boolean).map((sentences) => sentences.join(' ')).join('\n\n'));
}

/**
 * Write turns as a transcript with "Name: text" labels. A turn that opens a section (its text
 * starts with the heading) gets the heading mark back, so the chapters survive.
 */
export function toTranscript(speakers: (string | null)[], texts: string[], sections: boolean[] = []): string {
  return texts
    .map((text, i) => (speakers[i] ? `${speakers[i]}: ${text}` : sections[i] ? `## ${text}` : text))
    .filter((turn) => turn.trim())
    .join('\n\n');
}
