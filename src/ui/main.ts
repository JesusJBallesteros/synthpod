// Starts the page and keeps it in step with the transcript. The parts live next door:
// transcript.ts (steps 1–2), translation.ts, voices.ts and cards.ts (steps 4–5),
// output.ts (step 7) and shell.ts (appearance, settings, presets, footer).

import { onThreadFallback } from '../engines/client';
import { detectLanguage, estimateSeconds, findWarnings } from '../parse/analyse';
import { parseTranscript, type FormatHint } from '../parse/parse';
import { findReviewItems } from '../parse/review';
import { applyEdits, guessHost, resolveName, speakerStats, suggestAssignment, suggestMerges, wordCount } from '../parse/speakers';
import { renderAnalysis } from './analysis';
import { speakerCard } from './cards';
import {
  $,
  analysisEl,
  engineSelect,
  expected,
  fileStatus,
  format,
  input,
  language,
  renderBtn,
  reviewEl,
  saveTranscript,
  speakersEl,
  status,
  stripDirections,
  stripTimecodes,
  themeSelect,
  uiLanguage,
  voiceStatus,
} from './dom';
import { getLocale, initialLocale, LOCALES, plural, setLocale, t, translatePage, type Locale, type MessageKey } from './i18n';
import { initOutput, showCacheSize } from './output';
import { renderReview } from './review';
import { loadStored, saveStored } from './settings';
import { describeDevice, initShell, loadTheme, showDictionary, showOffline, showPresets, showSettings, showVersion } from './shell';
import { casting, dismissedMerges, edits, engineLangs, engines, refresh, setRefresh, settings, state } from './state';
import { addWord, initTranscript, jumpTo } from './transcript';
import { initTranslation, releaseTranslateStatus, showTranslatePanel } from './translation';
import { pickRegion, resolveCasting, saveCasting, showLanguages, speakerNames, spokenText, toCast, updateEngineOptions } from './voices';

let languageNote: MessageKey | null = null;
let refreshId = 0;

/** Pre-fill the language from the text, unless the user has already chosen one. */
function autoLanguage(text: string): void {
  languageNote = null;
  if (state.languageTouched || !state.languages.length || !text.trim()) return;
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
  for (const original of state.detected.speakers) {
    if (resolveName(original, edits.renames) === current) edits.renames.set(original, target);
  }
  if (casting.has(current) && !casting.has(target)) casting.set(target, casting.get(current)!);
  void refresh();
}

setRefresh(async () => {
  const id = ++refreshId;
  const detected = parseTranscript(input.value, {
    hint: format.value as FormatHint,
    stripTimecodes: stripTimecodes.checked,
    stripDirections: stripDirections.checked,
    expectedSpeakers: Math.max(0, Number(expected.value) || 0),
  });
  const turns = applyEdits(detected.turns, edits);
  const stats = speakerStats(turns);
  Object.assign(state, { detected, turns, stats });
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
  voiceStatus.textContent =
    state.catalogueError !== null ? t('language.failed', { error: state.catalogueError }) : language.value || !state.languages.length ? '' : t('language.needed');
  renderReview(reviewEl, findReviewItems(input.value), input.value, { jump: jumpTo, addWord, readAs: (text) => spokenText(text, language.value) });
  saveTranscript.disabled = !input.value.trim();
  saveCasting();
  showTranslatePanel();
  const ready = names.length > 0 && names.every((name) => casting.get(name)!.voice);
  renderBtn.disabled = !ready || state.rendering !== null;
});

/** Ask the engines what they can speak, then draw the page for the first time. */
async function init(): Promise<void> {
  showLanguages();
  void describeDevice();
  // Kokoro is optional: if it cannot load, the app still works with Piper alone.
  const kokoro = engines.kokoro.languages().then(
    (langs) => engineLangs.set('kokoro', new Set(langs.map((l) => l.code))),
    (err) => console.warn('Kokoro is unavailable:', err),
  );
  try {
    state.languages = await engines.piper.languages();
    engineLangs.set('piper', new Set(state.languages.map((l) => l.code)));
    await kokoro;
    showLanguages();
    language.value = pickRegion(navigator.language.slice(0, 2)) ?? 'en_US';
    language.disabled = false;
    engineSelect.disabled = false;
    updateEngineOptions();
  } catch (err) {
    state.catalogueError = (err as Error).message;
    showLanguages();
  }
  await refresh();
}

/** Re-draw everything that carries text, after the interface language changed. */
function retranslate(): void {
  translatePage();
  showSettings(); // option text changed; keep the selected values
  themeSelect.value = loadTheme();
  showLanguages();
  updateEngineOptions();
  showDictionary();
  showPresets();
  showOffline();
  showVersion();
  $('updateStatus').textContent = '';
  void describeDevice();
  void showCacheSize();
  status.textContent = '';
  fileStatus.textContent = '';
  releaseTranslateStatus();
  void refresh();
}

for (const control of [format, expected, stripTimecodes, stripDirections]) control.addEventListener('change', () => void refresh());
language.addEventListener('change', () => {
  state.languageTouched = true;
  updateEngineOptions();
  void refresh();
});
engineSelect.addEventListener('change', () => {
  settings.engine = engineSelect.value;
  saveStored('settings', settings);
  void refresh();
});
uiLanguage.addEventListener('change', () => {
  setLocale(uiLanguage.value as Locale);
  saveStored('locale', getLocale());
  retranslate();
});

setLocale(initialLocale(loadStored<string | null>('locale', null)));
uiLanguage.replaceChildren(...Object.entries(LOCALES).map(([code, name]) => new Option(name, code)));
uiLanguage.value = getLocale();
translatePage();
initTranscript();
initTranslation();
initOutput();
initShell();
onThreadFallback(() => {
  voiceStatus.textContent = t('engine.singleThread');
  void describeDevice();
});
void init();
