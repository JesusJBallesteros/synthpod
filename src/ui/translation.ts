// The optional translation step: translate on this device, review side by side, then use the result.

import { sentences } from '../audio/render';
import { translate } from '../translate/client';
import { rebuildTurns, route, targetsFor, toTranscript, type TranslationUnit } from '../translate/pairs';
import { renderCompare, type CompareRow } from './compare';
import {
  $,
  compareEl,
  input,
  language,
  translateCancel,
  translateDialog,
  translateFrom,
  translateProgress,
  translateRestore,
  translateReview,
  translateStart,
  translateStatus,
  translateTo,
  translateUse,
} from './dom';
import { getLocale, languageName, t } from './i18n';
import { dismissedMerges, edits, refresh, state } from './state';

let translating: AbortController | null = null;
// The transcript as it was before a translation replaced it.
let original: string | null = null;
// A finished translation waiting to be reviewed: its turns, and a reader for the edited text.
let pendingTranslation: { rows: CompareRow[]; read: () => string[] } | null = null;

/** Whether the text in the box is a translation that replaced the original. */
export const isTranslated = (): boolean => original !== null;

/** Let the status line of the panel be rewritten (after a change of language, for example). */
export function releaseTranslateStatus(): void {
  delete translateStatus.dataset.kept;
}

export function showTranslatePanel(): void {
  const from = language.value.slice(0, 2);
  translateFrom.textContent = language.value ? language.selectedOptions[0].text : '—';
  const targets = from ? targetsFor(from) : [];
  const previous = translateTo.value;
  translateTo.replaceChildren(...targets.map((code) => new Option(languageName(code, code), code)));
  translateTo.value = targets.includes(previous) ? previous : targets.includes(getLocale()) ? getLocale() : (targets[0] ?? '');
  translateTo.disabled = !targets.length || translating !== null;
  translateStart.disabled = !targets.length || !state.turns.length || translating !== null;
  translateReview.hidden = pendingTranslation === null;
  translateRestore.hidden = original === null;
  // Only overwrite the status line while nothing is running or waiting to be reviewed.
  if (translating === null && pendingTranslation === null && translateStatus.dataset.kept !== 'true') {
    const models = from && translateTo.value ? route(from, translateTo.value) : null;
    translateStatus.textContent = !state.turns.length || !from ? t('translate.needText') : !targets.length ? t('translate.none') : models && models.length > 1 ? t('translate.viaEnglish') : '';
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
  if (!models || !state.turns.length) return;
  const locale = language.value.replace('_', '-');
  const source = state.turns;
  // Translate sentence by sentence, remembering where each belongs so labels and paragraphs survive.
  const units: TranslationUnit[] = source.flatMap((turn, i) =>
    turn.text.split(/\n{2,}/).flatMap((paragraph, p) => sentences(paragraph, locale).map((text) => ({ turn: i, paragraph: p, text }))),
  );
  $('translateDialogNote').textContent = t('translate.dialogNote', { from: translateFrom.textContent ?? '', to: translateTo.selectedOptions[0].text });
  const run = new AbortController();
  translating = run;
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
      run.signal,
    );
    const texts = rebuildTurns(source.length, units, results);
    const rows = source.map((turn, i) => ({ speaker: turn.speaker, section: turn.title !== undefined, original: turn.text, translated: texts[i] }));
    pendingTranslation = { rows, read: () => rows.map((r) => r.translated) };
    translateStatus.textContent = t('translate.done');
    openTranslationReview();
  } catch (err) {
    translateStatus.textContent = run.signal.aborted ? t('translate.cancelled') : t('translate.failed', { error: (err as Error).message });
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
  state.languageTouched = false;
  pendingTranslation = null;
  void refresh();
}

export function initTranslation(): void {
  translateStart.addEventListener('click', () => void runTranslation());
  translateCancel.addEventListener('click', () => translating?.abort());
  translateTo.addEventListener('change', () => {
    releaseTranslateStatus();
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
  translateRestore.addEventListener('click', () => {
    if (original === null) return;
    const text = original;
    original = null;
    releaseTranslateStatus();
    replaceTranscript(text);
  });
}
