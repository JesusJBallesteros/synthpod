import type { Mode } from '../audio/render';
import type { AnnounceStyle, DictionaryEntry } from '../parse/normalise';
import { t } from './i18n';

export interface Settings {
  engine: string; // '' = automatic
  mode: Mode;
  announceStyle: AnnounceStyle;
  turnPauseMs: number;
  paragraphPauseMs: number;
  coldOpenPauseMs: number;
  expand: boolean;
  loudness: boolean;
  loudnessTarget: number;
  kbps: number;
  stereo: boolean;
  sampleRate: number; // 0 = keep the engine's rate
  chapters: boolean;
  artist: string;
  comment: string;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: '',
  mode: 'distinct',
  announceStyle: 'says',
  turnPauseMs: 450,
  paragraphPauseMs: 250,
  coldOpenPauseMs: 0,
  expand: true,
  loudness: true,
  loudnessTarget: -16,
  kbps: 128,
  stereo: false,
  sampleRate: 0,
  chapters: true,
  artist: '',
  comment: '',
};

/** A speaker's settings. Empty `lang` / `engine` mean "follow the global setting". */
export interface SpeakerCast {
  lang: string;
  engine: string;
  voice: string;
  speed: number;
  volume: number;
}

export interface Preset {
  settings: Settings;
  casting: Record<string, SpeakerCast>;
}

const PREFIX = 'synthpod.';

// Storage can be unavailable (private mode, blocked site data); the app must work without it.
export function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // not persisted this time
  }
}

type Control = HTMLInputElement | HTMLSelectElement;

function read(control: Control, current: unknown): unknown {
  if (control instanceof HTMLInputElement && control.type === 'checkbox') return control.checked;
  if (typeof current === 'boolean') return control.value === 'true';
  if (typeof current === 'number') {
    const n = Number(control.value);
    return Number.isFinite(n) ? n : current;
  }
  return control.value;
}

function write(control: Control, value: unknown): void {
  if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value);
  else control.value = String(value);
}

/** Two-way binding between every `[data-setting]` control on the page and the settings object. */
export function bindSettings(settings: Settings, onChange: (key: keyof Settings) => void): () => void {
  const controls = [...document.querySelectorAll<Control>('[data-setting]')];
  const show = () => {
    for (const c of controls) write(c, settings[c.dataset.setting as keyof Settings]);
  };
  for (const c of controls) {
    const key = c.dataset.setting as keyof Settings;
    c.addEventListener('change', () => {
      (settings as unknown as Record<string, unknown>)[key] = read(c, DEFAULT_SETTINGS[key]);
      onChange(key);
    });
  }
  show();
  return show;
}

/** The editable find → say list. Calls `onChange` with the cleaned list after every edit. */
export function renderDictionary(root: HTMLElement, entries: DictionaryEntry[], onChange: (entries: DictionaryEntry[]) => void): void {
  const commit = () => onChange(entries.filter((e) => e.find.trim()));
  const rows = entries.map((entry, index) => {
    const row = document.createElement('div');
    row.className = 'row dictionary-row';
    const find = Object.assign(document.createElement('input'), { type: 'text', value: entry.find, placeholder: t('dict.find'), ariaLabel: t('dict.find') });
    const say = Object.assign(document.createElement('input'), { type: 'text', value: entry.say, placeholder: t('dict.say'), ariaLabel: t('dict.say') });
    const remove = Object.assign(document.createElement('button'), { textContent: t('dict.remove'), className: 'quiet' });
    find.onchange = () => {
      entry.find = find.value;
      commit();
    };
    say.onchange = () => {
      entry.say = say.value;
      commit();
    };
    remove.onclick = () => {
      entries.splice(index, 1);
      commit();
      renderDictionary(root, entries, onChange);
    };
    row.append(find, '→', say, remove);
    return row;
  });
  const add = Object.assign(document.createElement('button'), { textContent: t('dict.add') });
  add.onclick = () => {
    entries.push({ find: '', say: '' });
    renderDictionary(root, entries, onChange);
    (root.querySelector('.dictionary-row:last-of-type input') as HTMLInputElement | null)?.focus();
  };
  root.replaceChildren(...rows, add);
}
