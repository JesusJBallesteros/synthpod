// Text preparation before synthesis: the user's pronunciation dictionary, abbreviations and symbols.
// Plain numbers are left alone on purpose: both engines already read them in the right language.

export interface DictionaryEntry {
  find: string;
  say: string;
}

export interface NormaliseOptions {
  /** ISO 639-1 language, e.g. "en". */
  family: string;
  expand: boolean;
  dictionary: DictionaryEntry[];
}

type Rule = [pattern: string, replacement: string];

const B = String.raw`(?<![\p{L}\p{N}])`; // start of a word
const E = String.raw`(?![\p{L}\p{N}])`; // end of a word
const D = String.raw`(?<=\d)\s?`; // directly after a number

const RULES: Record<string, Rule[]> = {
  en: [
    [`${B}e\\.\\s?g\\.`, 'for example'], [`${B}i\\.\\s?e\\.`, 'that is'], [`${B}etc\\.`, 'et cetera'], [`${B}vs\\.?${E}`, 'versus'],
    [`${B}approx\\.`, 'approximately'], [`${B}Prof\\.`, 'Professor'], [`${B}Dr\\.`, 'Doctor'], [`${B}Mr\\.`, 'Mister'],
    [`${B}Mrs\\.`, 'Missus'], [`${B}Ms\\.`, 'Miss'], [`${B}No\\.\\s?(?=\\d)`, 'number '],
    [`${D}%`, ' percent'], [`\\s&\\s`, ' and '], [`${D}km${E}`, ' kilometres'], [`${D}kg${E}`, ' kilograms'], [`${D}cm${E}`, ' centimetres'],
    [`${D}°C${E}`, ' degrees Celsius'], [`${D}°F${E}`, ' degrees Fahrenheit'],
  ],
  de: [
    [`${B}z\\.\\s?B\\.`, 'zum Beispiel'], [`${B}d\\.\\s?h\\.`, 'das heißt'], [`${B}u\\.\\s?a\\.`, 'unter anderem'], [`${B}usw\\.`, 'und so weiter'],
    [`${B}bzw\\.`, 'beziehungsweise'], [`${B}ca\\.`, 'circa'], [`${B}evtl\\.`, 'eventuell'], [`${B}ggf\\.`, 'gegebenenfalls'],
    [`${B}Prof\\.`, 'Professor'], [`${B}Dr\\.`, 'Doktor'], [`${B}Nr\\.\\s?(?=\\d)`, 'Nummer '],
    [`${D}%`, ' Prozent'], [`\\s&\\s`, ' und '], [`${D}km${E}`, ' Kilometer'], [`${D}kg${E}`, ' Kilogramm'], [`${D}cm${E}`, ' Zentimeter'],
    [`${D}°C${E}`, ' Grad Celsius'],
  ],
  es: [
    [`${B}p\\.\\s?ej\\.`, 'por ejemplo'], [`${B}etc\\.`, 'etcétera'], [`${B}Sra\\.`, 'señora'], [`${B}Sr\\.`, 'señor'],
    [`${B}Dra\\.`, 'doctora'], [`${B}Dr\\.`, 'doctor'], [`${B}Uds\\.`, 'ustedes'], [`${B}Ud\\.`, 'usted'], [`${B}n\\.º\\s?(?=\\d)`, 'número '],
    [`${D}%`, ' por ciento'], [`\\s&\\s`, ' y '], [`${D}km${E}`, ' kilómetros'], [`${D}kg${E}`, ' kilogramos'], [`${D}cm${E}`, ' centímetros'],
    [`${D}°C${E}`, ' grados Celsius'],
  ],
  fr: [
    [`${B}p\\.\\s?ex\\.`, 'par exemple'], [`${B}etc\\.`, 'et cetera'], [`${B}c\\.-à-d\\.`, "c'est-à-dire"], [`${B}Mme${E}\\.?`, 'madame'],
    [`${B}M\\.\\s(?=\\p{Lu})`, 'monsieur '], [`${B}Dr${E}\\.?`, 'docteur'], [`${B}n°\\s?(?=\\d)`, 'numéro '],
    [`${D}%`, ' pour cent'], [`\\s&\\s`, ' et '], [`${D}km${E}`, ' kilomètres'], [`${D}kg${E}`, ' kilogrammes'], [`${D}cm${E}`, ' centimètres'],
    [`${D}°C${E}`, ' degrés Celsius'],
  ],
};

const DOT: Record<string, string> = { en: 'dot', de: 'Punkt', es: 'punto', fr: 'point', it: 'punto', pt: 'ponto', nl: 'punt' };
const SAYS: Record<string, string> = { en: 'says', de: 'sagt', es: 'dice', fr: 'dit', it: 'dice', pt: 'diz', nl: 'zegt' };

const compiled = new Map<string, [RegExp, string][]>();

function rulesFor(family: string): [RegExp, string][] {
  if (!compiled.has(family)) {
    compiled.set(family, (RULES[family] ?? []).map(([pattern, to]) => [new RegExp(pattern, 'gu'), to]));
  }
  return compiled.get(family)!;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace whole words or phrases, ignoring case: "SQL" -> "sequel". */
export function applyDictionary(text: string, dictionary: DictionaryEntry[]): string {
  let out = text;
  for (const { find, say } of dictionary) {
    if (!find.trim()) continue;
    out = out.replace(new RegExp(`${B}${escapeRegExp(find.trim())}${E}`, 'giu'), () => say);
  }
  return out;
}

/** "https://www.example.org/some/page" is read as "example dot org". */
function simplifyUrls(text: string, family: string): string {
  const dot = DOT[family];
  return text.replace(/\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/(?:[^\s,;)]*[^\s,;).!?:])?)?/gi, (whole, host: string) => {
    if (!/^(?:https?:\/\/|www\.)/i.test(whole) && !whole.includes('/')) return whole; // an ordinary "word.word"
    return dot ? host.split('.').join(` ${dot} `) : host;
  });
}

export function normaliseText(text: string, opts: NormaliseOptions): string {
  let out = applyDictionary(text, opts.dictionary);
  if (opts.expand) {
    out = simplifyUrls(out, opts.family);
    for (const [pattern, to] of rulesFor(opts.family)) out = out.replace(pattern, to);
  }
  return out;
}

export type AnnounceStyle = 'says' | 'name';

/** What a narrator says before a turn: "Anna says:" where we know the verb, otherwise just "Anna:". */
export function announcement(name: string, family: string, style: AnnounceStyle): string {
  const verb = style === 'says' ? SAYS[family] : undefined;
  return verb ? `${name} ${verb}:` : `${name}:`;
}
