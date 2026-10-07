import { de } from './locales/de';
import { en, type MessageKey } from './locales/en';
import { es } from './locales/es';

export type { MessageKey };

const MESSAGES = { en, es, de } satisfies Record<string, Record<MessageKey, string>>;
export type Locale = keyof typeof MESSAGES;

/** Interface languages, each named in its own language. */
export const LOCALES: Record<Locale, string> = { en: 'English', es: 'Español', de: 'Deutsch' };

type Params = Record<string, string | number>;
type PluralKey = { [K in MessageKey]: K extends `${infer Base}.one` ? Base : never }[MessageKey];

let locale: Locale = 'en';

export function getLocale(): Locale {
  return locale;
}

/** The stored choice, else the browser's language if we have it, else English. */
export function initialLocale(stored: string | null): Locale {
  const candidates = [stored, ...navigator.languages.map((l) => l.slice(0, 2))];
  return (candidates.find((c) => c !== null && c in MESSAGES) as Locale | undefined) ?? 'en';
}

export function setLocale(next: Locale): void {
  locale = next;
  document.documentElement.lang = next;
}

export function t(key: MessageKey, params: Params = {}): string {
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Pick the ".one" or ".other" form for a count; the count is available as {n}. */
export function plural(base: PluralKey, n: number, params: Params = {}): string {
  const form = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other';
  return t(`${base}.${form}` as MessageKey, { n: formatNumber(n), ...params });
}

export function formatNumber(n: number): string {
  return n.toLocaleString(locale);
}

/** "en_US" -> "American English" / "inglés estadounidense", falling back to the given name. */
export function languageName(code: string, fallback: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code.replace('_', '-'));
    return name && name !== code.replace('_', '-') ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fill in the static page: `data-i18n` sets the text, `data-i18n-html` sets trusted markup from
 * our own message files, and `data-i18n-attr="title:key placeholder:key"` sets attributes.
 */
export function translatePage(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n as MessageKey);
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) node.innerHTML = t(node.dataset.i18nHtml as MessageKey);
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr!.split(/\s+/)) {
      const [attr, key] = pair.split(':');
      node.setAttribute(attr, t(key as MessageKey));
    }
  }
}
