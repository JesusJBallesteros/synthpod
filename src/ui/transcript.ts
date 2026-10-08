// Steps 1 and 2: getting a transcript into the box, and moving around in it while checking it.

import { ACCEPTED_EXTENSIONS, htmlToText, readTranscriptFile, UnsupportedFileError } from '../parse/input';
import type { ReviewItem } from '../parse/review';
import { wordCount } from '../parse/speakers';
import { saveBlob } from '../audio/mp3';
import { dictionaryEl, dropZone, fileInput, fileStatus, format, input, language, openFile, saveTranscript, tagTitle } from './dom';
import { formatNumber, t } from './i18n';
import { fileBaseName } from './output';
import { setStage, showDictionary } from './shell';
import { dictionary, refresh, state } from './state';
import { isTranslated } from './translation';

async function loadFile(file: File): Promise<void> {
  fileStatus.textContent = t('file.reading', { name: file.name });
  try {
    const loaded = await readTranscriptFile(file);
    input.value = loaded.text;
    // A PDF is running text for one voice; anything else goes back to detecting speakers.
    if (loaded.prose) format.value = 'none';
    else if (format.value === 'none') format.value = 'auto';
    state.title = loaded.title;
    tagTitle.value = loaded.title;
    // A new document: detect its language afresh.
    state.languageTouched = false;
    fileStatus.textContent = t('file.loaded', { name: file.name, words: formatNumber(wordCount(loaded.text)) });
    await refresh();
  } catch (err) {
    const error = err instanceof UnsupportedFileError ? t('file.unsupported', { type: err.fileType, list: ACCEPTED_EXTENSIONS.join(', ') }) : (err as Error).message;
    fileStatus.textContent = t('file.failed', { name: file.name, error });
  }
}

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

/** Select an item of the check list in the transcript and bring it into view. */
export function jumpTo(item: ReviewItem): void {
  input.focus({ preventScroll: true });
  input.setSelectionRange(item.start, item.end);
  scrollTextareaTo(input, item.start);
  input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Put a word into the pronunciation list and take the user to it, ready to type how it is said. */
export function addWord(word: string): void {
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

export function initTranscript(): void {
  // Re-reading a long transcript on every keystroke makes typing sluggish; wait for a short pause.
  let typingTimer = 0;
  input.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => void refresh(), 200);
  });
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
  // Save the transcript as it stands in the box: corrected by hand, or translated.
  saveTranscript.addEventListener('click', () => {
    const suffix = isTranslated() && language.value ? ` (${language.value.slice(0, 2)})` : '';
    void saveBlob(new Blob([input.value], { type: 'text/plain' }), `${fileBaseName()}${suffix}.txt`, { description: 'Text', mime: 'text/plain', extension: '.txt' });
  });
}
