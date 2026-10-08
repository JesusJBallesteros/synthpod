import type { SpeakerStat } from '../parse/speakers';
import { formatNumber, plural, t } from './i18n';

export interface UnlabelledSegment {
  text: string;
  /** Current speaker, or '' for a separate voice. */
  speaker: string;
  suggestion: string | null;
}

export interface AnalysisModel {
  stats: SpeakerStat[];
  /** Words in the whole text, including parts with no speaker. */
  totalWords: number;
  turnCount: number;
  formatLabel: string;
  estimatedSeconds: number;
  languageNote: string;
  host: string | null;
  warnings: string[];
  merges: { from: string; into: string }[];
  unlabelled: UnlabelledSegment[];
  hasEdits: boolean;
}

export interface AnalysisActions {
  rename(current: string, next: string): void;
  dismissMerge(from: string): void;
  assign(text: string, speaker: string): void;
  resetEdits(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Whether the user opened or closed the details; until they do, it opens only when something needs a decision.
let detailsChoice: boolean | null = null;

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t('duration.short');
  if (minutes < 60) return t('duration.minutes', { m: minutes });
  return t('duration.hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export function renderAnalysis(root: HTMLElement, model: AnalysisModel, actions: AnalysisActions): void {
  root.className = '';
  const parts = [
    ...(model.stats.length ? [plural('analysis.speakers', model.stats.length), plural('analysis.turns', model.turnCount)] : []),
    t('analysis.words', { n: formatNumber(model.totalWords) }),
    t('analysis.audio', { duration: formatDuration(model.estimatedSeconds) }),
    model.formatLabel,
  ];
  const nodes: Node[] = [el('p', {}, parts.filter(Boolean).join(' · '))];
  if (model.languageNote) nodes.push(el('p', { className: 'muted' }, model.languageNote));
  if (model.warnings.length) nodes.push(el('ul', { className: 'warnings' }, ...model.warnings.map((w) => el('li', {}, w))));

  const details: Node[] = [];
  if (model.stats.length) {
    const rows = model.stats.map((s) => {
      const name = el('input', { type: 'text', value: s.name, ariaLabel: t('rename.aria', { name: s.name }) });
      name.onchange = () => actions.rename(s.name, name.value);
      const merge = el('select', { ariaLabel: t('merge.aria', { name: s.name }) }, new Option(t('merge.into'), ''));
      for (const other of model.stats) if (other.name !== s.name) merge.add(new Option(other.name, other.name));
      merge.disabled = model.stats.length < 2;
      merge.onchange = () => merge.value && actions.rename(s.name, merge.value);
      const bar = el('span', { className: 'bar' }, el('span', {}));
      (bar.firstElementChild as HTMLElement).style.width = `${Math.round(s.share * 100)}%`;
      return el(
        'tr',
        {},
        el('td', {}, name, s.name === model.host ? el('span', { className: 'badge', title: t('host.title') }, t('host.badge')) : ''),
        el('td', { className: 'num-cell' }, formatNumber(s.turns)),
        el('td', { className: 'num-cell' }, formatNumber(s.words)),
        el('td', {}, bar, ` ${Math.round(s.share * 100)}%`),
        el('td', {}, merge),
      );
    });
    details.push(
      el(
        'div',
        { className: 'scroll-x' },
        el(
          'table',
          { className: 'speakers' },
          el('thead', {}, el('tr', {}, el('th', {}, t('table.speaker')), el('th', {}, t('table.turns')), el('th', {}, t('table.words')), el('th', {}, t('table.share')), el('th', {}, ''))),
          el('tbody', {}, ...rows),
        ),
      ),
    );
  }

  for (const m of model.merges) {
    const merge = el('button', {}, t('merge.do'));
    merge.onclick = () => actions.rename(m.from, m.into);
    const keep = el('button', { className: 'quiet' }, t('merge.keep'));
    keep.onclick = () => actions.dismissMerge(m.from);
    details.push(el('p', { className: 'suggestion' }, `${t('merge.suggest', m)} `, merge, keep));
  }

  for (const seg of model.unlabelled) {
    const select = el('select', { ariaLabel: t('unlabelled.aria') }, new Option(t('unlabelled.separate', { name: t('speaker.unassigned') }), ''));
    for (const s of model.stats) select.add(new Option(s.name === seg.suggestion ? t('unlabelled.suggested', { name: s.name }) : s.name, s.name));
    select.value = seg.speaker;
    select.onchange = () => actions.assign(seg.text, select.value);
    const snippet = seg.text.length > 110 ? `${seg.text.slice(0, 110)}…` : seg.text;
    details.push(el('p', { className: 'suggestion' }, `${t('unlabelled.prefix')} `, el('q', {}, snippet), ` ${t('unlabelled.suffix')} `, select));
  }

  if (model.hasEdits) {
    const reset = el('button', { className: 'quiet' }, t('edits.undo'));
    reset.onclick = () => actions.resetEdits();
    details.push(reset);
  }
  if (details.length) {
    const needsDecision = model.merges.length > 0 || model.unlabelled.length > 0;
    const fold = el('details', { open: detailsChoice ?? needsDecision }, el('summary', {}, t('found.details')), ...details);
    fold.ontoggle = () => {
      // Remember only real clicks; the first toggle event just reports the initial state.
      if (fold.open !== (detailsChoice ?? needsDecision)) detailsChoice = fold.open;
    };
    nodes.push(fold);
  }
  root.replaceChildren(...nodes);
}
