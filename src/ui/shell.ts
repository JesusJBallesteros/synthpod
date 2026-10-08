// The frame around the steps: stages on narrow screens, appearance, settings and presets,
// the pronunciation list, and the footer with the version and the offline state.

import { usesSingleThread } from '../engines/client';
import { $, deviceEl, dictionaryEl, offlineStatus, presetList, presetName, themeSelect, translatePanel } from './dom';
import { getLocale, t } from './i18n';
import { checkForUpdate, registerServiceWorker } from './pwa';
import { bindSettings, DEFAULT_SETTINGS, loadStored, renderDictionary, saveStored, type Settings } from './settings';
import { casting, dictionary, presets, refresh, settings, type Theme } from './state';
import { updateEngineOptions } from './voices';

let offlineReady: boolean | null = null;
let redrawSettings: () => void = () => {};

/** On narrow screens the page shows one of two stages: the text, or the audio. */
export function setStage(stage: 'text' | 'audio'): void {
  document.body.dataset.stage = stage;
  $('stageText').setAttribute('aria-pressed', String(stage === 'text'));
  $('stageAudio').setAttribute('aria-pressed', String(stage === 'audio'));
}

export const loadTheme = (): Theme => loadStored<Theme>('theme', 'system');

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function showDictionary(): void {
  renderDictionary(dictionaryEl, dictionary, (entries) => saveStored('dictionary', entries));
}

export function showPresets(): void {
  const names = Object.keys(presets).sort();
  presetList.replaceChildren(...(names.length ? names.map((n) => new Option(n, n)) : [new Option(t('presets.none'), '')]));
  presetList.disabled = !names.length;
}

/** Show the stored settings in their controls (again, after the option texts changed). */
export function showSettings(): void {
  redrawSettings();
}

/** The narrator's wording only matters when a narrator speaks. */
function showModeDependents(): void {
  document.querySelector<HTMLSelectElement>('[data-setting="announceStyle"]')!.disabled = settings.mode !== 'narrator';
}

function applySettings(next: Settings): void {
  Object.assign(settings, DEFAULT_SETTINGS, next);
  saveStored('settings', settings);
  showSettings();
  showModeDependents();
  updateEngineOptions();
}

export async function describeDevice(): Promise<void> {
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

export function showVersion(): void {
  const date = new Date(`${__BUILD_DATE__}T12:00:00`).toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' });
  $('versionInfo').textContent = t('version.info', { version: __APP_VERSION__, date });
}

export function showOffline(): void {
  offlineStatus.textContent = offlineReady === null ? '' : t(offlineReady ? 'offline.ready' : 'offline.saving');
}

/** The translation card sits beside the text on wide screens and under it on narrow ones. */
function placeTranslatePanel(narrow: MediaQueryList): void {
  const audioColumn = document.querySelector('.column[data-stage="audio"]')!;
  const wanted = narrow.matches ? $('toAudio').parentElement! : audioColumn;
  if (translatePanel.parentElement === wanted) return;
  if (narrow.matches) $('toAudio').before(translatePanel);
  else audioColumn.prepend(translatePanel);
}

export function initShell(): void {
  themeSelect.value = loadTheme();
  redrawSettings = bindSettings(settings, () => {
    saveStored('settings', settings);
    showModeDependents();
    void refresh();
  });
  showModeDependents();

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
  $('checkUpdate').addEventListener('click', async () => {
    const note = $('updateStatus');
    note.textContent = t('update.checking');
    const result = await checkForUpdate();
    note.textContent = t(result === 'reloading' ? 'update.reloading' : result === 'current' ? 'update.current' : 'update.failed');
  });
  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value as Theme;
    saveStored('theme', theme);
    applyTheme(theme);
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

  const narrow = matchMedia('(max-width: 1099px)');
  narrow.addEventListener('change', () => placeTranslatePanel(narrow));
  window.addEventListener('resize', () => placeTranslatePanel(narrow));
  placeTranslatePanel(narrow);
  setStage('text');
  showDictionary();
  showPresets();
  showVersion();
  registerServiceWorker((ready) => {
    offlineReady = ready;
    showOffline();
  });
}
