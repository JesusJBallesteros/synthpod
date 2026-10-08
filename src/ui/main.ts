import { clearChunks } from '../audio/cache';
import { toChapters, toCueSheet, toSrt, toVtt, type Cue } from '../audio/captions';
import { encodeMp3, saveBlob, type FileKind } from '../audio/mp3';
import { renderTurns, sentences, synthCached, type Cast } from '../audio/render';
import { onThreadFallback, usesSingleThread, WorkerEngine } from '../engines/client';
import type { Lang, TTSEngine, Voice } from '../engines/types';
import { detectLanguage, estimateSeconds, findWarnings } from '../parse/analyse';
import { ACCEPTED_EXTENSIONS, htmlToText, readTranscriptFile, UnsupportedFileError } from '../parse/input';
import { announcement, normaliseText, type DictionaryEntry } from '../parse/normalise';
import { parseTranscript, type FormatHint, type ParseResult, type Turn } from '../parse/parse';
import { findReviewItems, type ReviewItem } from '../parse/review';
import { applyEdits, guessHost, resolveName, speakerStats, suggestAssignment, suggestMerges, wordCount, type Edits, type SpeakerStat } from '../parse/speakers';
import { renderAnalysis } from './analysis';
import { formatNumber, getLocale, initialLocale, languageName, LOCALES, plural, setLocale, t, translatePage, type Locale, type MessageKey } from './i18n';
import { translate } from '../translate/client';
import { rebuildTurns, route, targetsFor, toTranscript, type TranslationUnit } from '../translate/pairs';
import { renderCompare, type CompareRow } from './compare';
import { registerServiceWorker } from './pwa';
import { renderReview } from './review';
import { bindSettings, DEFAULT_SETTINGS, loadStored, renderDictionary, saveStored, type Preset, type Settings, type SpeakerCast } from './settings';

// Internal names for the two voices that are not a detected speaker; shown translated.
const UNASSIGNED = 'Unassigned';
const NARRATOR = 'Narrator';
const ENGINE_NAMES: Record<string, string> = { piper: 'Piper', kokoro: 'Kokoro' };
// Which regional variant to offer first when only the language is known.
const PREFERRED_REGION: Record<string, string> = { en: 'en_US', pt: 'pt_BR', zh: 'zh_CN', es: 'es_ES', nl: 'nl_NL', sv: 'sv_SE', ar: 'ar_JO' };
type Theme = 'system' | 'light' | 'dark';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLTextAreaElement>('input');
const dropZone = $('dropZone');
const openFile = $<HTMLButtonElement>('openFile');
const fileInput = $<HTMLInputElement>('fileInput');
const fileStatus = $('fileStatus');
const saveTranscript = $<HTMLButtonElement>('saveTranscript');
const translatePanel = $('translatePanel');
const format = $<HTMLSelectElement>('format');
const expected = $<HTMLInputElement>('expected');
const stripTimecodes = $<HTMLInputElement>('stripTimecodes');
const stripDirections = $<HTMLInputElement>('stripDirections');
const analysisEl = $('analysis');
const language = $<HTMLSelectElement>('language');
const engineSelect = $<HTMLSelectElement>('engine');
const voiceStatus = $('voiceStatus');
const deviceEl = $('device');
const speakersEl = $('speakers');
const renderBtn = $<HTMLButtonElement>('render');
const cancelBtn = $<HTMLButtonElement>('cancel');
const saveBtn = $<HTMLButtonElement>('save');
const clearBtn = $<HTMLButtonElement>('clearCache');
const progress = $<HTMLProgressElement>('progress');
const status = $('status');
const player = $<HTMLAudioElement>('player');
const tagTitle = $<HTMLInputElement>('tagTitle');
const dictionaryEl = $('dictionary');
const presetList = $<HTMLSelectElement>('presetList');
const presetName = $<HTMLInputElement>('presetName');
const themeSelect = $<HTMLSelectElement>('theme');
const uiLanguage = $<HTMLSelectElement>('uiLanguage');
const offlineStatus = $('offlineStatus');
const reviewEl = $('review');
const saveSrt = $<HTMLButtonElement>('saveSrt');
const saveVtt = $<HTMLButtonElement>('saveVtt');
const saveCue = $<HTMLButtonElement>('saveCue');
const translateFrom = $('translateFrom');
const translateTo = $<HTMLSelectElement>('translateTo');
const translateStart = $<HTMLButtonElement>('translateStart');
const translateCancel = $<HTMLButtonElement>('translateCancel');
const translateProgress = $<HTMLProgressElement>('translateProgress');
const translateStatus = $('translateStatus');
const translateReview = $<HTMLButtonElement>('translateReview');
const translateDialog = $<HTMLDialogElement>('translateDialog');
const compareEl = $('compare');
const translateUse = $<HTMLButtonElement>('translateUse');
const translateRestore = $<HTMLButtonElement>('translateRestore');

const engines: Record<string, TTSEngine> = { piper: new WorkerEngine('piper'), kokoro: new WorkerEngine('kokoro') };
const engineLangs = new Map<string, Set<string>>();
const voiceLists = new Map<string, Promise<Voice[]>>();
// Voices are remembered by speaker name, so a returning host keeps their voice.
const casting = new Map<string, SpeakerCast>(Object.entries(loadStored<Record<string, SpeakerCast>>('casting', {})));
const settings: Settings = { ...DEFAULT_SETTINGS, ...loadStored<Partial<Settings>>('settings', {}) };
const dictionary = loadStored<DictionaryEntry[]>('dictionary', []);
const presets = loadStored<Record<string, Preset>>('presets', {});
const edits: Edits = { renames: new Map(), assignments: new Map() };
const dismissedMerges = new Set<string>();
let languages: Lang[] = [];
let catalogueError: string | null = null;
let detected: ParseResult = { turns: [], speakers: [], format: 'none' };
let turns: Turn[] = [];
let stats: SpeakerStat[] = [];
let title = 'transcript';
let languageTouched = false;
let languageNote: MessageKey | null = null;
let offlineReady: boolean | null = null;
let abort: AbortController | null = null;
let mp3: Blob | null = null;
let cues: Cue[] = [];
// The name the MP3 was last saved under; the cue sheet has to point at exactly that file.
let savedMp3Name: string | null = null;
let translating: AbortController | null = null;
// The transcript as it was before a translation replaced it.
let original: string | null = null;
// A finished translation waiting to be reviewed: its turns, and a reader for the edited text.
let pendingTranslation: { rows: CompareRow[]; read: () => string[] } | null = null;
let refreshId = 0;
let previewCtx: AudioContext | null = null;
let previewSource: AudioBufferSourceNode | null = null;

function displayName(name: string): string {
  // With no speakers at all, the single voice simply reads the text.
  if (name === UNASSIGNED && stats.length === 0) return t('speaker.reader');
  return name === UNASSIGNED ? t('speaker.unassigned') : name === NARRATOR ? t('speaker.narrator') : name;
}

function speakerNames(): string[] {
  if (settings.mode === 'narrator') return turns.length ? [NARRATOR] : [];
  const names = stats.map((s) => s.name);
  if (turns.some((t) => t.speaker === null)) names.push(UNASSIGNED);
  return names;
}

function supports(engine: string, lang: string): boolean {
  return engineLangs.get(engine)?.has(lang) ?? false;
}

/** Piper everywhere, Kokoro for English, unless the speaker or the global setting says otherwise. */
function effective(cast: SpeakerCast): { lang: string; engine: string } {
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

function voiceLabel(v: Voice): string {
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
async function resolveCasting(): Promise<Map<string, Voice[]>> {
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

function toCast(speaker: string | null): Cast {
  const cast = casting.get(settings.mode === 'narrator' ? NARRATOR : (speaker ?? UNASSIGNED))!;
  const { lang, engine } = effective(cast);
  return { engine: engines[engine], voice: cast.voice, speed: cast.speed, gain: cast.volume, locale: lang.replace('_', '-') };
}

function saveCasting(): void {
  saveStored('casting', Object.fromEntries(casting));
}

/** Apply the pronunciation settings for a language given as "en-US" or "en_US". */
function spokenText(text: string, language: string): string {
  return normaliseText(text, { family: language.slice(0, 2), expand: settings.expand, dictionary });
}

function prepare(text: string, cast: Cast): string {
  return spokenText(text, cast.locale);
}

/** Language options named in the interface language and sorted by that name. */
function languageOptions(): HTMLOptionElement[] {
  return languages
    .map((l) => ({ code: l.code, name: languageName(l.code, l.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, getLocale()))
    .map((l) => new Option(l.name, l.code));
}

function slider(caption: string, value: number, min: number, max: number, onChange: (v: number) => void): HTMLLabelElement {
  const wrap = document.createElement('label');
  const group = document.createElement('span');
  group.className = 'slider';
  const range = document.createElement('input');
  const out = document.createElement('output');
  const show = () => (out.textContent = `${Math.round(Number(range.value) * 100)}%`);
  Object.assign(range, { type: 'range', min: String(min), max: String(max), step: '0.05', value: String(value) });
  range.oninput = () => {
    show();
    onChange(Number(range.value));
  };
  show();
  group.append(range, out);
  wrap.append(caption, group);
  return wrap;
}

function labelled(caption: string, control: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.append(caption, control);
  return wrap;
}

function speakerCard(name: string, voices: Voice[]): HTMLElement {
  const cast = casting.get(name)!;
  const { lang } = effective(cast);
  const own = name === NARRATOR ? turns : turns.filter((t) => (t.speaker ?? UNASSIGNED) === name);

  const card = document.createElement('div');
  card.className = 'speaker';
  const head = document.createElement('div');
  head.className = 'head';
  const heading = document.createElement('strong');
  heading.textContent = displayName(name);
  head.append(heading);

  const langSelect = document.createElement('select');
  langSelect.add(new Option(t('card.sameLanguage'), ''));
  for (const option of languageOptions()) langSelect.add(option);
  langSelect.value = cast.lang;
  langSelect.onchange = () => {
    cast.lang = langSelect.value;
    void refresh();
  };

  const engSelect = document.createElement('select');
  engSelect.add(new Option(t('engine.automatic', { name: ENGINE_NAMES[effective({ ...cast, engine: '' }).engine] }), ''));
  for (const id of Object.keys(engines)) if (supports(id, lang)) engSelect.add(new Option(ENGINE_NAMES[id], id));
  engSelect.value = cast.engine && supports(cast.engine, lang) ? cast.engine : '';
  engSelect.onchange = () => {
    cast.engine = engSelect.value;
    void refresh();
  };

  const voiceSelect = document.createElement('select');
  for (const v of voices) voiceSelect.add(new Option(voiceLabel(v), v.id));
  voiceSelect.value = cast.voice;
  voiceSelect.disabled = !voices.length;
  voiceSelect.onchange = () => {
    cast.voice = voiceSelect.value;
    saveCasting();
  };

  const preview = document.createElement('button');
  preview.textContent = t('card.preview');
  preview.disabled = !voices.length || !own.length;
  preview.onclick = () => playPreview(name, preview);

  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.append(
    labelled(t('card.voice'), voiceSelect),
    labelled(t('card.engine'), engSelect),
    labelled(t('card.language'), langSelect),
    slider(t('card.speed'), cast.speed, 0.7, 1.3, (v) => {
      cast.speed = v;
      saveCasting();
    }),
    slider(t('card.volume'), cast.volume, 0.5, 1.5, (v) => {
      cast.volume = v;
      saveCasting();
    }),
    preview,
  );
  card.append(head, controls);
  return card;
}

async function playPreview(name: string, button: HTMLButtonElement): Promise<void> {
  const turn = name === NARRATOR ? turns[0] : turns.find((t) => (t.speaker ?? UNASSIGNED) === name);
  if (!turn) return;
  const cast = toCast(name === UNASSIGNED ? null : name);
  const text = sentences(prepare(turn.text, cast), cast.locale)[0];
  if (!text) return;
  // Create the context inside the click so the browser allows playback.
  previewCtx ??= new AudioContext();
  void previewCtx.resume();
  button.disabled = true;
  const shown = displayName(name);
  try {
    status.textContent = t('preview.preparing', { name: shown });
    const audio = await synthCached(cast, text, (f, stage) => {
      status.textContent =
        stage === 'engine'
          ? t('render.startingEngine', { engine: ENGINE_NAMES[cast.engine.id] })
          : t('preview.downloading', { name: shown, percent: Math.round(f * 100) });
    });
    previewSource?.stop();
    const buffer = previewCtx.createBuffer(1, audio.pcm.length, audio.sampleRate);
    buffer.getChannelData(0).set(audio.pcm);
    const gain = previewCtx.createGain();
    gain.gain.value = cast.gain;
    previewSource = previewCtx.createBufferSource();
    previewSource.buffer = buffer;
    previewSource.connect(gain).connect(previewCtx.destination);
    previewSource.start();
    status.textContent = '';
  } catch (err) {
    status.textContent = t('preview.failed', { error: (err as Error).message });
  } finally {
    button.disabled = false;
  }
}

/** Pick the regional variant of a language: the browser's own if it matches, else a common default. */
function pickRegion(family: string): string | null {
  const options = languages.filter((l) => l.code.startsWith(`${family}_`)).map((l) => l.code);
  const browser = navigator.language.replace('-', '_');
  return (
    options.find((c) => c === browser) ??
    options.find((c) => c === PREFERRED_REGION[family]) ??
    options.find((c) => c === `${family}_${family.toUpperCase()}`) ??
    options[0] ??
    null
  );
}

/** Pre-fill the language from the text, unless the user has already chosen one. */
function autoLanguage(text: string): void {
  languageNote = null;
  if (languageTouched || !languages.length || !text.trim()) return;
  const guess = detectLanguage(text);
  if (!guess) {
    languageNote = 'language.tooShort';
    return;
  }
  const code = guess.family ? pickRegion(guess.family) : null;
  if (guess.confident && code) {
    language.value = code;
    languageNote = 'language.detected';
  } else {
    language.value = '';
    languageNote = 'language.unsure';
  }
  updateEngineOptions();
}

/** Rename a speaker; renaming onto an existing speaker merges them. Settings follow the name. */
function rename(current: string, next: string): void {
  const target = next.trim();
  if (!target || target === current) return void refresh();
  for (const original of detected.speakers) {
    if (resolveName(original, edits.renames) === current) edits.renames.set(original, target);
  }
  if (casting.has(current) && !casting.has(target)) casting.set(target, casting.get(current)!);
  void refresh();
}

async function refresh(): Promise<void> {
  const id = ++refreshId;
  detected = parseTranscript(input.value, {
    hint: format.value as FormatHint,
    stripTimecodes: stripTimecodes.checked,
    stripDirections: stripDirections.checked,
    expectedSpeakers: Math.max(0, Number(expected.value) || 0),
  });
  turns = applyEdits(detected.turns, edits);
  stats = speakerStats(turns);
  autoLanguage(turns.map((t) => t.text).join('\n'));
  const lists = await resolveCasting();
  if (id !== refreshId) return;

  const names = speakerNames();
  if (turns.length) {
    const selected = language.selectedOptions[0];
    renderAnalysis(
      analysisEl,
      {
        stats,
        totalWords: turns.reduce((n, turn) => n + wordCount(turn.text), 0),
        turnCount: turns.length,
        formatLabel: t(`found.${detected.format}`),
        estimatedSeconds: estimateSeconds(turns, (speaker) => toCast(speaker).speed),
        languageNote: languageNote ? t(languageNote, { name: selected?.text ?? '' }) : '',
        host: guessHost(turns),
        warnings: findWarnings(turns).map((w) => plural(`warn.${w.kind}`, w.count)),
        merges: suggestMerges(stats.map((s) => s.name)).filter((m) => !dismissedMerges.has(m.from)),
        unlabelled: detected.speakers.length
          ? detected.turns.flatMap((t, i) =>
              t.speaker ? [] : [{ text: t.text, speaker: turns[i].speaker ?? '', suggestion: suggestAssignment(detected.turns, t) }],
            )
          : [],
        hasEdits: edits.renames.size > 0 || edits.assignments.size > 0,
      },
      {
        rename,
        dismissMerge: (from) => {
          dismissedMerges.add(from);
          void refresh();
        },
        assign: (text, speaker) => {
          edits.assignments.set(text, speaker);
          void refresh();
        },
        resetEdits: () => {
          edits.renames.clear();
          edits.assignments.clear();
          dismissedMerges.clear();
          void refresh();
        },
      },
    );
    speakersEl.className = '';
    speakersEl.replaceChildren(...names.map((name) => speakerCard(name, lists.get(name) ?? [])));
  } else {
    for (const [node, key] of [[analysisEl, 'analysis.empty'], [speakersEl, 'speakers.empty']] as const) {
      node.className = 'muted';
      node.textContent = t(key);
    }
  }
  voiceStatus.textContent = catalogueError !== null ? t('language.failed', { error: catalogueError }) : language.value || !languages.length ? '' : t('language.needed');
  renderReview(reviewEl, findReviewItems(input.value), input.value, { jump: jumpTo, addWord, readAs: (text) => spokenText(text, language.value) });
  saveTranscript.disabled = !input.value.trim();
  saveCasting();
  showTranslatePanel();
  const ready = names.length > 0 && names.every((name) => casting.get(name)!.voice);
  renderBtn.disabled = !ready || abort !== null;
}

function updateEngineOptions(): void {
  const previous = settings.engine;
  const auto = effective({ lang: '', engine: '', voice: '', speed: 1, volume: 1 }).engine;
  engineSelect.replaceChildren(new Option(t('engine.automatic', { name: ENGINE_NAMES[auto] }), ''));
  for (const id of Object.keys(engines)) if (supports(id, language.value)) engineSelect.add(new Option(ENGINE_NAMES[id], id));
  engineSelect.value = previous && supports(previous, language.value) ? previous : '';
}

/** (Re)build the transcript-language list in the interface language, keeping the selection. */
function showLanguages(): void {
  const current = language.value;
  if (!languages.length) {
    language.replaceChildren(new Option(t(catalogueError !== null ? 'language.unavailable' : 'language.loading'), ''));
    return;
  }
  language.replaceChildren(new Option(t('language.choose'), ''), ...languageOptions());
  language.value = current;
}

async function describeDevice(): Promise<void> {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: { requestAdapter(): Promise<unknown> } };
  const gpu = await nav.gpu?.requestAdapter().catch(() => null);
  const parts = [
    navigator.hardwareConcurrency ? t('device.threads', { n: navigator.hardwareConcurrency }) : null,
    nav.deviceMemory ? (nav.deviceMemory >= 8 ? t('device.memory.plenty') : t('device.memory.about', { n: nav.deviceMemory })) : null,
    t(gpu ? 'device.gpu.yes' : 'device.gpu.no'),
    t(usesSingleThread() ? 'device.threads.failed' : self.crossOriginIsolated ? 'device.threads.on' : 'device.threads.off'),
  ];
  deviceEl.textContent = t('device.intro', { parts: parts.filter(Boolean).join(', ') });
}

function showOffline(): void {
  offlineStatus.textContent = offlineReady === null ? '' : t(offlineReady ? 'offline.ready' : 'offline.saving');
}

async function init(): Promise<void> {
  showLanguages();
  void describeDevice();
  // Kokoro is optional: if it cannot load, the app still works with Piper alone.
  const kokoro = engines.kokoro.languages().then(
    (langs) => engineLangs.set('kokoro', new Set(langs.map((l) => l.code))),
    (err) => console.warn('Kokoro is unavailable:', err),
  );
  try {
    languages = await engines.piper.languages();
    engineLangs.set('piper', new Set(languages.map((l) => l.code)));
    await kokoro;
    showLanguages();
    language.value = pickRegion(navigator.language.slice(0, 2)) ?? 'en_US';
    language.disabled = false;
    engineSelect.disabled = false;
    updateEngineOptions();
  } catch (err) {
    catalogueError = (err as Error).message;
    showLanguages();
  }
  await refresh();
}

async function render(): Promise<void> {
  abort = new AbortController();
  const { signal } = abort;
  mp3 = null;
  renderBtn.disabled = true;
  cancelBtn.hidden = false;
  saveBtn.hidden = true;
  saveSrt.hidden = true;
  saveVtt.hidden = true;
  saveCue.hidden = true;
  savedMp3Name = null;
  player.hidden = true;
  progress.hidden = false;
  progress.value = 0;
  try {
    let started = performance.now();
    let firstDone = 0;
    // The opening teaser is whatever comes before the first labelled turn.
    const firstLabelled = detected.turns.findIndex((t) => t.speaker !== null);
    const result = await renderTurns(turns, {
      mode: settings.mode,
      turnPauseMs: settings.turnPauseMs,
      paragraphPauseMs: settings.paragraphPauseMs,
      sentencePauseMs: 150,
      coldOpenPauseMs: settings.coldOpenPauseMs,
      coldOpenTurns: Math.max(0, firstLabelled),
      castFor: toCast,
      prepare,
      announce: (speaker, cast) =>
        settings.mode === 'hybrid' ? `${speaker}.` : announcement(speaker, cast.locale.slice(0, 2), settings.announceStyle),
      loudnessTarget: settings.loudness ? settings.loudnessTarget : null,
      sampleRate: settings.sampleRate,
      signal,
      onVoiceLoad: (cast, f, stage) => {
        // The sentence in progress may still report after Cancel; do not let it overwrite the status.
        if (signal.aborted) return;
        status.textContent =
          stage === 'engine'
            ? t('render.startingEngine', { engine: ENGINE_NAMES[cast.engine.id] })
            : t('render.downloading', { engine: ENGINE_NAMES[cast.engine.id], percent: Math.round(f * 100) });
        // Do not count download time towards the time estimate.
        started = performance.now();
        firstDone = progress.value;
      },
      onProgress: (done, total) => {
        if (signal.aborted) return;
        progress.max = total || 1;
        progress.value = done;
        const sinceStart = done - firstDone;
        const eta = sinceStart > 0 && done < total ? Math.round((((performance.now() - started) / sinceStart) * (total - done)) / 1000) : null;
        status.textContent =
          eta === null
            ? t('render.progress', { done, total })
            : eta >= 90
              ? t('render.progress.minutes', { done, total, n: Math.round(eta / 60) })
              : t('render.progress.seconds', { done, total, n: eta });
      },
    });
    const seconds = result.pcm.length / result.sampleRate;
    status.textContent = t('render.encoding');
    progress.max = 1;
    mp3 = await encodeMp3(
      result.pcm,
      {
        sampleRate: result.sampleRate,
        kbps: settings.kbps,
        stereo: settings.stereo,
        tags: {
          title: tagTitle.value.trim() || title,
          artist: settings.artist.trim() || stats.map((s) => s.name).join(', '),
          year: String(new Date().getFullYear()),
          comment: settings.comment.trim(),
          chapters: settings.chapters ? toChapters(result.cues) : [],
        },
      },
      (f) => (progress.value = f),
    );
    signal.throwIfAborted();
    const length = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const done = t('render.done', { length, size: formatNumber(Math.round(mp3.size / 1e5) / 10) });
    status.textContent = result.skipped.length ? `${done} ${plural('render.skipped', result.skipped.length)}` : done;
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(mp3);
    cues = result.cues;
    player.hidden = false;
    saveBtn.hidden = false;
    saveSrt.hidden = false;
    saveVtt.hidden = false;
    saveCue.hidden = false;
  } catch (err) {
    status.textContent = signal.aborted ? t('render.cancelled') : t('render.failed', { error: (err as Error).message });
  } finally {
    abort = null;
    cancelBtn.hidden = true;
    progress.hidden = true;
    void refresh();
  }
}

async function loadFile(file: File): Promise<void> {
  fileStatus.textContent = t('file.reading', { name: file.name });
  try {
    const loaded = await readTranscriptFile(file);
    input.value = loaded.text;
    // A PDF is running text for one voice; anything else goes back to detecting speakers.
    if (loaded.prose) format.value = 'none';
    else if (format.value === 'none') format.value = 'auto';
    title = loaded.title;
    tagTitle.value = loaded.title;
    // A new document: detect its language afresh.
    languageTouched = false;
    fileStatus.textContent = t('file.loaded', { name: file.name, words: formatNumber(wordCount(loaded.text)) });
    await refresh();
  } catch (err) {
    const error = err instanceof UnsupportedFileError ? t('file.unsupported', { type: err.fileType, list: ACCEPTED_EXTENSIONS.join(', ') }) : (err as Error).message;
    fileStatus.textContent = t('file.failed', { name: file.name, error });
  }
}

// ---------- Checking odd items ----------

/** Scroll a textarea so that the given character offset is in the middle of it. */
function scrollTextareaTo(area: HTMLTextAreaElement, offset: number): void {
  // Measure how tall the text before the offset is, in a hidden copy with the same wrapping.
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    boxSizing: 'content-box',
    width: `${area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`,
    font: style.font,
    letterSpacing: style.letterSpacing,
  });
  mirror.textContent = area.value.slice(0, offset);
  document.body.append(mirror);
  const height = mirror.offsetHeight;
  mirror.remove();
  area.scrollTop = Math.max(0, height - area.clientHeight / 2);
}

function jumpTo(item: ReviewItem): void {
  input.focus({ preventScroll: true });
  input.setSelectionRange(item.start, item.end);
  scrollTextareaTo(input, item.start);
  input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Put a word into the pronunciation list and take the user to it, ready to type how it is said. */
function addWord(word: string): void {
  if (!dictionary.some((e) => e.find.toLowerCase() === word.toLowerCase())) dictionary.push({ find: word, say: '' });
  showDictionary();
  const row = [...dictionaryEl.querySelectorAll<HTMLElement>('.dictionary-row')].find(
    (r) => r.querySelector('input')?.value.toLowerCase() === word.toLowerCase(),
  );
  setStage('audio');
  dictionaryEl.closest('details')!.open = true;
  const say = row?.querySelectorAll('input')[1];
  say?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  say?.focus({ preventScroll: true });
}

// ---------- Translation ----------

function showTranslatePanel(): void {
  const from = language.value.slice(0, 2);
  translateFrom.textContent = language.value ? language.selectedOptions[0].text : '—';
  const targets = from ? targetsFor(from) : [];
  const previous = translateTo.value;
  translateTo.replaceChildren(...targets.map((code) => new Option(languageName(code, code), code)));
  translateTo.value = targets.includes(previous) ? previous : targets.includes(getLocale()) ? getLocale() : (targets[0] ?? '');
  translateTo.disabled = !targets.length || translating !== null;
  translateStart.disabled = !targets.length || !turns.length || translating !== null;
  translateReview.hidden = pendingTranslation === null;
  translateRestore.hidden = original === null;
  // Only overwrite the status line while nothing is running or waiting to be reviewed.
  if (translating === null && pendingTranslation === null && translateStatus.dataset.kept !== 'true') {
    const models = from && translateTo.value ? route(from, translateTo.value) : null;
    translateStatus.textContent = !turns.length || !from ? t('translate.needText') : !targets.length ? t('translate.none') : models && models.length > 1 ? t('translate.viaEnglish') : '';
  }
}

/** Open the side-by-side review of the finished translation. */
function openTranslationReview(): void {
  if (!pendingTranslation) return;
  // Keep what the user already corrected if the review is opened a second time.
  const edited = pendingTranslation.read();
  pendingTranslation.rows.forEach((row, i) => (row.translated = edited[i] ?? row.translated));
  pendingTranslation.read = renderCompare(compareEl, pendingTranslation.rows, { original: t('translate.original'), translation: t('translate.translation') });
  if (!translateDialog.open) translateDialog.showModal();
  compareEl.scrollTop = 0;
}

async function runTranslation(): Promise<void> {
  const models = route(language.value.slice(0, 2), translateTo.value);
  if (!models || !turns.length) return;
  const locale = language.value.replace('_', '-');
  const source = turns;
  // Translate sentence by sentence, remembering where each belongs so labels and paragraphs survive.
  const units: TranslationUnit[] = source.flatMap((turn, i) =>
    turn.text.split(/\n{2,}/).flatMap((paragraph, p) => sentences(paragraph, locale).map((text) => ({ turn: i, paragraph: p, text }))),
  );
  $('translateDialogNote').textContent = t('translate.dialogNote', { from: translateFrom.textContent ?? '', to: translateTo.selectedOptions[0].text });
  translating = new AbortController();
  pendingTranslation = null;
  translateCancel.hidden = false;
  translateProgress.hidden = false;
  translateProgress.value = 0;
  translateStatus.dataset.kept = 'true';
  showTranslatePanel();
  try {
    const results = await translate(
      { models, texts: units.map((u) => u.text) },
      {
        onDownload: (f) => {
          translateStatus.textContent = t('translate.downloading', { percent: Math.round(f * 100) });
        },
        onProgress: (done, total) => {
          translateProgress.max = total;
          translateProgress.value = done;
          translateStatus.textContent = t('translate.progress', { done, total });
        },
      },
      translating.signal,
    );
    const texts = rebuildTurns(source.length, units, results);
    const rows = source.map((turn, i) => ({ speaker: turn.speaker, section: turn.title !== undefined, original: turn.text, translated: texts[i] }));
    pendingTranslation = { rows, read: () => rows.map((r) => r.translated) };
    translateStatus.textContent = t('translate.done');
    openTranslationReview();
  } catch (err) {
    translateStatus.textContent = translating.signal.aborted ? t('translate.cancelled') : t('translate.failed', { error: (err as Error).message });
  } finally {
    translating = null;
    translateCancel.hidden = true;
    translateProgress.hidden = true;
    showTranslatePanel();
  }
}

/** Replace the transcript with a text in another language and let everything be detected afresh. */
function replaceTranscript(text: string): void {
  input.value = text;
  // Speaker edits are already part of the translated text, and its language is new.
  edits.renames.clear();
  edits.assignments.clear();
  dismissedMerges.clear();
  languageTouched = false;
  pendingTranslation = null;
  void refresh();
}

// ---------- Two stages on narrow screens ----------

function setStage(stage: 'text' | 'audio'): void {
  document.body.dataset.stage = stage;
  $('stageText').setAttribute('aria-pressed', String(stage === 'text'));
  $('stageAudio').setAttribute('aria-pressed', String(stage === 'audio'));
}

// ---------- Appearance and interface language ----------

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function showDictionary(): void {
  renderDictionary(dictionaryEl, dictionary, (entries) => saveStored('dictionary', entries));
}

function showPresets(): void {
  const names = Object.keys(presets).sort();
  presetList.replaceChildren(...(names.length ? names.map((n) => new Option(n, n)) : [new Option(t('presets.none'), '')]));
  presetList.disabled = !names.length;
}

/** Re-draw everything that carries text, after the interface language changed. */
function retranslate(): void {
  translatePage();
  showSettings(); // option text changed; keep the selected values
  themeSelect.value = loadStored<Theme>('theme', 'system');
  showLanguages();
  updateEngineOptions();
  showDictionary();
  showPresets();
  showOffline();
  void describeDevice();
  status.textContent = '';
  fileStatus.textContent = '';
  delete translateStatus.dataset.kept;
  void refresh();
}

function applySettings(next: Settings): void {
  Object.assign(settings, DEFAULT_SETTINGS, next);
  saveStored('settings', settings);
  showSettings();
  showModeDependents();
  updateEngineOptions();
}

// ---------- Events ----------

input.addEventListener('input', () => void refresh());
// Rich text copied from a web page loses its paragraph breaks as plain text, so convert the HTML instead.
input.addEventListener('paste', (e) => {
  const html = e.clipboardData?.getData('text/html');
  if (!html || !/<(?:p|div|br|li|h[1-6])\b/i.test(html)) return;
  e.preventDefault();
  input.setRangeText(htmlToText(html), input.selectionStart, input.selectionEnd, 'end');
  void refresh();
});
dropZone.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  void loadFile(file);
});
openFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) void loadFile(fileInput.files[0]);
  fileInput.value = '';
});
for (const control of [format, expected, stripTimecodes, stripDirections]) control.addEventListener('change', () => void refresh());
language.addEventListener('change', () => {
  languageTouched = true;
  updateEngineOptions();
  void refresh();
});
engineSelect.addEventListener('change', () => {
  settings.engine = engineSelect.value;
  saveStored('settings', settings);
  void refresh();
});
renderBtn.addEventListener('click', render);
cancelBtn.addEventListener('click', () => abort?.abort());
function fileBaseName(): string {
  return (tagTitle.value.trim() || title).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'transcript';
}
saveBtn.addEventListener('click', async () => {
  if (!mp3) return;
  savedMp3Name = (await saveBlob(mp3, `${fileBaseName()}.mp3`)) ?? savedMp3Name;
});
saveCue.addEventListener('click', () => {
  const file = savedMp3Name ?? `${fileBaseName()}.mp3`;
  const sheet = toCueSheet(toChapters(cues), {
    file,
    title: tagTitle.value.trim() || title,
    performer: settings.artist.trim() || stats.map((s) => s.name).join(', '),
  });
  void saveBlob(new Blob([sheet], { type: 'text/plain' }), file.replace(/\.mp3$/i, '') + '.cue', { description: 'Cue sheet', mime: 'text/plain', extension: '.cue' });
});
clearBtn.addEventListener('click', async () => {
  await clearChunks();
  status.textContent = t('cache.cleared');
});
const captionKinds: Record<'srt' | 'vtt', FileKind> = {
  srt: { description: 'SubRip captions', mime: 'application/x-subrip', extension: '.srt' },
  vtt: { description: 'WebVTT captions', mime: 'text/vtt', extension: '.vtt' },
};
function saveCaptions(kind: 'srt' | 'vtt'): void {
  const text = kind === 'srt' ? toSrt(cues) : toVtt(cues);
  void saveBlob(new Blob([text], { type: captionKinds[kind].mime }), `${fileBaseName()}.${kind}`, captionKinds[kind]);
}
saveSrt.addEventListener('click', () => saveCaptions('srt'));
saveVtt.addEventListener('click', () => saveCaptions('vtt'));
// Save the transcript as it stands in the box: corrected by hand, or translated.
saveTranscript.addEventListener('click', () => {
  const suffix = original !== null && language.value ? ` (${language.value.slice(0, 2)})` : '';
  void saveBlob(new Blob([input.value], { type: 'text/plain' }), `${fileBaseName()}${suffix}.txt`, { description: 'Text', mime: 'text/plain', extension: '.txt' });
});
translateStart.addEventListener('click', () => void runTranslation());
translateCancel.addEventListener('click', () => translating?.abort());
translateTo.addEventListener('change', () => {
  delete translateStatus.dataset.kept;
  showTranslatePanel();
});
translateReview.addEventListener('click', openTranslationReview);
$('translateClose').addEventListener('click', () => translateDialog.close());
translateUse.addEventListener('click', () => {
  if (!pendingTranslation) return;
  const text = toTranscript(
    pendingTranslation.rows.map((r) => r.speaker),
    pendingTranslation.read(),
    pendingTranslation.rows.map((r) => r.section === true),
  );
  original ??= input.value;
  translateDialog.close();
  replaceTranscript(text);
  translateStatus.textContent = t('translate.used');
});
for (const stage of ['text', 'audio'] as const) {
  $(stage === 'text' ? 'stageText' : 'stageAudio').addEventListener('click', () => {
    setStage(stage);
    window.scrollTo({ top: 0 });
  });
}
$('toAudio').addEventListener('click', () => {
  setStage('audio');
  window.scrollTo({ top: 0 });
});
translateRestore.addEventListener('click', () => {
  if (original === null) return;
  const text = original;
  original = null;
  delete translateStatus.dataset.kept;
  replaceTranscript(text);
});
themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value as Theme;
  saveStored('theme', theme);
  applyTheme(theme);
});
uiLanguage.addEventListener('change', () => {
  setLocale(uiLanguage.value as Locale);
  saveStored('locale', getLocale());
  retranslate();
});
$('presetSave').addEventListener('click', () => {
  const name = presetName.value.trim();
  if (!name) return void presetName.focus();
  presets[name] = { settings: { ...settings }, casting: structuredClone(Object.fromEntries(casting)) };
  saveStored('presets', presets);
  presetName.value = '';
  showPresets();
  presetList.value = name;
});
$('presetLoad').addEventListener('click', () => {
  const preset = presets[presetList.value];
  if (!preset) return;
  applySettings(preset.settings);
  for (const [name, cast] of Object.entries(preset.casting)) casting.set(name, { ...cast });
  void refresh();
});
$('presetDelete').addEventListener('click', () => {
  delete presets[presetList.value];
  saveStored('presets', presets);
  showPresets();
});
$('presetReset').addEventListener('click', () => {
  applySettings(DEFAULT_SETTINGS);
  void refresh();
});

// ---------- Start ----------

setLocale(initialLocale(loadStored<string | null>('locale', null)));
uiLanguage.replaceChildren(...Object.entries(LOCALES).map(([code, name]) => new Option(name, code)));
uiLanguage.value = getLocale();
translatePage();
themeSelect.value = loadStored<Theme>('theme', 'system');
/** The narrator's wording only matters when a narrator speaks. */
function showModeDependents(): void {
  document.querySelector<HTMLSelectElement>('[data-setting="announceStyle"]')!.disabled = settings.mode !== 'narrator';
}
const showSettings = bindSettings(settings, () => {
  saveStored('settings', settings);
  showModeDependents();
  void refresh();
});
showModeDependents();
onThreadFallback(() => {
  voiceStatus.textContent = t('engine.singleThread');
  void describeDevice();
});
const narrow = matchMedia('(max-width: 1099px)');
function placeTranslatePanel(): void {
  const audioColumn = document.querySelector('.column[data-stage="audio"]')!;
  const wanted = narrow.matches ? $('toAudio').parentElement! : audioColumn;
  if (translatePanel.parentElement === wanted) return;
  if (narrow.matches) $('toAudio').before(translatePanel);
  else audioColumn.prepend(translatePanel);
}
narrow.addEventListener('change', placeTranslatePanel);
window.addEventListener('resize', placeTranslatePanel);
placeTranslatePanel();
setStage('text');
showDictionary();
showPresets();
registerServiceWorker((ready) => {
  offlineReady = ready;
  showOffline();
});
void init();
