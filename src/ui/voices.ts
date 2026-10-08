// Languages, engines and voices: what is on offer, and which voice each speaker gets.

import type { Cast } from '../audio/render';
import type { Voice } from '../engines/types';
import { normaliseText } from '../parse/normalise';
import { engineSelect, language } from './dom';
import { getLocale, languageName, t, type MessageKey } from './i18n';
import { saveStored, type SpeakerCast } from './settings';
import { casting, dictionary, ENGINE_NAMES, engineLangs, engines, NARRATOR, settings, state, UNASSIGNED } from './state';

// Which regional variant to offer first when only the language is known.
const PREFERRED_REGION: Record<string, string> = { en: 'en_US', pt: 'pt_BR', zh: 'zh_CN', es: 'es_ES', nl: 'nl_NL', sv: 'sv_SE', ar: 'ar_JO' };
const voiceLists = new Map<string, Promise<Voice[]>>();

export function displayName(name: string): string {
  // With no speakers at all, the single voice simply reads the text.
  if (name === UNASSIGNED && state.stats.length === 0) return t('speaker.reader');
  return name === UNASSIGNED ? t('speaker.unassigned') : name === NARRATOR ? t('speaker.narrator') : name;
}

export function speakerNames(): string[] {
  if (settings.mode === 'narrator') return state.turns.length ? [NARRATOR] : [];
  const names = state.stats.map((s) => s.name);
  if (state.turns.some((t) => t.speaker === null)) names.push(UNASSIGNED);
  return names;
}

export function supports(engine: string, lang: string): boolean {
  return engineLangs.get(engine)?.has(lang) ?? false;
}

/** Piper everywhere, Kokoro for English, unless the speaker or the global setting says otherwise. */
export function effective(cast: SpeakerCast): { lang: string; engine: string } {
  const lang = cast.lang || language.value;
  const auto = lang.startsWith('en') && supports('kokoro', lang) ? 'kokoro' : 'piper';
  const wanted = cast.engine || settings.engine || auto;
  return { lang, engine: supports(wanted, lang) ? wanted : auto };
}

function listVoices(engine: string, lang: string): Promise<Voice[]> {
  if (!lang) return Promise.resolve([]);
  const key = `${engine}|${lang}`;
  if (!voiceLists.has(key)) {
    const list = engines[engine].listVoices(lang);
    list.catch(() => voiceLists.delete(key));
    voiceLists.set(key, list);
  }
  return voiceLists.get(key)!;
}

export function voiceLabel(v: Voice): string {
  const gender = v.gender?.toLowerCase();
  const quality = v.quality ?? '';
  const details = [
    gender === 'female' || gender === 'male' ? t(`voice.${gender}`) : gender,
    quality.startsWith('grade ') ? t('voice.grade', { grade: quality.slice(6) }) : quality ? t(`quality.${quality}` as MessageKey) : '',
  ].filter(Boolean);
  return details.length ? `${v.name} (${details.join(', ')})` : v.name;
}

/** Best default first: medium Piper voices, or the highest-graded Kokoro voices. */
function byPreference(a: Voice, b: Voice): number {
  const tiers = ['medium', 'high', 'low', 'x_low'];
  const rank = (v: Voice) => (tiers.includes(v.quality ?? '') ? tiers.indexOf(v.quality!) : 0);
  // Speakers of a multi-speaker model ("model#3") come after dedicated single-speaker voices.
  const multi = (v: Voice) => Number(v.id.includes('#'));
  return multi(a) - multi(b) || rank(a) - rank(b) || (a.quality ?? '').localeCompare(b.quality ?? '');
}

/** Make sure every speaker has a valid voice, giving each a different one where possible. */
export async function resolveCasting(): Promise<Map<string, Voice[]>> {
  const lists = new Map<string, Voice[]>();
  const used = new Set<string>();
  const pending: string[] = [];
  let lastGender: string | undefined;
  for (const name of speakerNames()) {
    if (!casting.has(name)) casting.set(name, { lang: '', engine: '', voice: '', speed: 1, volume: 1 });
    const cast = casting.get(name)!;
    const { lang, engine } = effective(cast);
    const voices = await listVoices(engine, lang).catch(() => []);
    lists.set(name, voices);
    // Track voices by name: "thorsten (medium)" and "thorsten (high)" are the same person.
    const current = voices.find((v) => v.id === cast.voice);
    if (current) used.add(`${engine}/${current.name}`);
    else pending.push(name);
  }
  for (const name of pending) {
    const cast = casting.get(name)!;
    const { engine } = effective(cast);
    const ordered = [...lists.get(name)!].sort(byPreference);
    const free = ordered.filter((v) => !used.has(`${engine}/${v.name}`));
    // Where gender is known, alternate it so consecutive speakers are easier to tell apart.
    const pick = free.find((v) => v.gender && v.gender !== lastGender) ?? free[0] ?? ordered[0];
    lastGender = pick?.gender;
    cast.voice = pick?.id ?? '';
    if (pick) used.add(`${engine}/${pick.name}`);
  }
  return lists;
}

export function toCast(speaker: string | null): Cast {
  const cast = casting.get(settings.mode === 'narrator' ? NARRATOR : (speaker ?? UNASSIGNED))!;
  const { lang, engine } = effective(cast);
  return { engine: engines[engine], voice: cast.voice, speed: cast.speed, gain: cast.volume, locale: lang.replace('_', '-') };
}

export function saveCasting(): void {
  saveStored('casting', Object.fromEntries(casting));
}

/** Apply the pronunciation settings for a language given as "en-US" or "en_US". */
export function spokenText(text: string, language: string): string {
  return normaliseText(text, { family: language.slice(0, 2), expand: settings.expand, dictionary });
}

export function prepare(text: string, cast: Cast): string {
  return spokenText(text, cast.locale);
}

/** Language options named in the interface language and sorted by that name. */
export function languageOptions(): HTMLOptionElement[] {
  return state.languages
    .map((l) => ({ code: l.code, name: languageName(l.code, l.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, getLocale()))
    .map((l) => new Option(l.name, l.code));
}

/** Pick the regional variant of a language: the browser's own if it matches, else a common default. */
export function pickRegion(family: string): string | null {
  const options = state.languages.filter((l) => l.code.startsWith(`${family}_`)).map((l) => l.code);
  const browser = navigator.language.replace('-', '_');
  return (
    options.find((c) => c === browser) ??
    options.find((c) => c === PREFERRED_REGION[family]) ??
    options.find((c) => c === `${family}_${family.toUpperCase()}`) ??
    options[0] ??
    null
  );
}

export function updateEngineOptions(): void {
  const previous = settings.engine;
  const auto = effective({ lang: '', engine: '', voice: '', speed: 1, volume: 1 }).engine;
  engineSelect.replaceChildren(new Option(t('engine.automatic', { name: ENGINE_NAMES[auto] }), ''));
  for (const id of Object.keys(engines)) if (supports(id, language.value)) engineSelect.add(new Option(ENGINE_NAMES[id], id));
  engineSelect.value = previous && supports(previous, language.value) ? previous : '';
}

/** (Re)build the transcript-language list in the interface language, keeping the selection. */
export function showLanguages(): void {
  const current = language.value;
  if (!state.languages.length) {
    language.replaceChildren(new Option(t(state.catalogueError !== null ? 'language.unavailable' : 'language.loading'), ''));
    return;
  }
  language.replaceChildren(new Option(t('language.choose'), ''), ...languageOptions());
  language.value = current;
}
