// The card of one speaker in step 5: voice, engine, language, speed, volume and a preview.

import { sentences, synthCached } from '../audio/render';
import type { Voice } from '../engines/types';
import { status } from './dom';
import { t } from './i18n';
import { showCacheSize } from './output';
import { casting, ENGINE_NAMES, engines, NARRATOR, refresh, state, UNASSIGNED } from './state';
import { displayName, effective, languageOptions, prepare, saveCasting, supports, toCast, voiceLabel } from './voices';

let previewCtx: AudioContext | null = null;
let previewSource: AudioBufferSourceNode | null = null;

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

export function speakerCard(name: string, voices: Voice[]): HTMLElement {
  const cast = casting.get(name)!;
  const { lang } = effective(cast);
  const own = name === NARRATOR ? state.turns : state.turns.filter((t) => (t.speaker ?? UNASSIGNED) === name);

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

/** Speak the first sentence of a speaker in their voice. */
async function playPreview(name: string, button: HTMLButtonElement): Promise<void> {
  const turn = name === NARRATOR ? state.turns[0] : state.turns.find((t) => (t.speaker ?? UNASSIGNED) === name);
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
    void showCacheSize();
  }
}
