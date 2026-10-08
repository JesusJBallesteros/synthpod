// Step 7: rendering the audio, and saving the MP3, the captions and the chapter list.

import { chunkBytes, clearChunks } from '../audio/cache';
import { toChapters, toCueSheet, toSrt, toVtt, type Cue } from '../audio/captions';
import { encodeMp3, saveBlob, type FileKind } from '../audio/mp3';
import { renderTurns } from '../audio/render';
import { announcement } from '../parse/normalise';
import { cacheSize, cancelBtn, clearBtn, player, progress, renderBtn, saveBtn, saveCue, saveSrt, saveVtt, status, tagTitle } from './dom';
import { formatNumber, plural, t } from './i18n';
import { ENGINE_NAMES, refresh, settings, state } from './state';
import { prepare, toCast } from './voices';

let mp3: Blob | null = null;
let cues: Cue[] = [];
// The name the MP3 was last saved under; the cue sheet has to point at exactly that file.
let savedMp3Name: string | null = null;

/** A file name made from the title, without the characters file systems refuse. */
export function fileBaseName(): string {
  return (tagTitle.value.trim() || state.title).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'transcript';
}

/** Say next to the "clear" button how much room the saved sentences take up. */
export async function showCacheSize(): Promise<void> {
  const bytes = await chunkBytes();
  if (bytes === null) return void (cacheSize.textContent = ''); // no storage here (private mode)
  const megabytes = Math.max(0.1, Math.round(bytes / 1024 / 1024 * 10) / 10);
  cacheSize.textContent = bytes === 0 ? t('cache.empty') : t('cache.size', { size: formatNumber(megabytes) });
}

async function render(): Promise<void> {
  const abort = new AbortController();
  state.rendering = abort;
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
    const firstLabelled = state.detected.turns.findIndex((t) => t.speaker !== null);
    const result = await renderTurns(state.turns, {
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
          title: tagTitle.value.trim() || state.title,
          artist: performer(),
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
    state.rendering = null;
    cancelBtn.hidden = true;
    progress.hidden = true;
    void showCacheSize();
    void refresh();
  }
}

function performer(): string {
  return settings.artist.trim() || state.stats.map((s) => s.name).join(', ');
}

const captionKinds: Record<'srt' | 'vtt', FileKind> = {
  srt: { description: 'SubRip captions', mime: 'application/x-subrip', extension: '.srt' },
  vtt: { description: 'WebVTT captions', mime: 'text/vtt', extension: '.vtt' },
};

function saveCaptions(kind: 'srt' | 'vtt'): void {
  const text = kind === 'srt' ? toSrt(cues) : toVtt(cues);
  void saveBlob(new Blob([text], { type: captionKinds[kind].mime }), `${fileBaseName()}.${kind}`, captionKinds[kind]);
}

export function initOutput(): void {
  renderBtn.addEventListener('click', render);
  cancelBtn.addEventListener('click', () => state.rendering?.abort());
  saveBtn.addEventListener('click', async () => {
    if (!mp3) return;
    savedMp3Name = (await saveBlob(mp3, `${fileBaseName()}.mp3`)) ?? savedMp3Name;
  });
  saveCue.addEventListener('click', () => {
    const file = savedMp3Name ?? `${fileBaseName()}.mp3`;
    const sheet = toCueSheet(toChapters(cues), { file, title: tagTitle.value.trim() || state.title, performer: performer() });
    void saveBlob(new Blob([sheet], { type: 'text/plain' }), file.replace(/\.mp3$/i, '') + '.cue', { description: 'Cue sheet', mime: 'text/plain', extension: '.cue' });
  });
  saveSrt.addEventListener('click', () => saveCaptions('srt'));
  saveVtt.addEventListener('click', () => saveCaptions('vtt'));
  clearBtn.addEventListener('click', async () => {
    await clearChunks();
    status.textContent = t('cache.cleared');
    void showCacheSize();
  });
  void showCacheSize();
}
