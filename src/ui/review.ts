import { snippet, type ReviewItem, type ReviewKind } from '../parse/review';
import { formatNumber, t } from './i18n';

export interface ReviewActions {
  /** Select the item in the transcript box and bring it into view. */
  jump(item: ReviewItem): void;
  addWord(text: string): void;
  /** How a piece of text is spoken after the pronunciation settings are applied. */
  readAs(text: string): string;
}

const KINDS: ReviewKind[] = ['numbers', 'abbreviations', 'acronyms', 'urls'];

// Which category is shown and where the user is in it; kept across re-draws.
let filter: ReviewKind | 'all' = 'all';
let position = -1; // -1 = nothing visited yet

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Draw the tool that steps through items worth checking, or a note when there are none. */
export function renderReview(root: HTMLElement, items: ReviewItem[], text: string, actions: ReviewActions): void {
  if (!items.length) {
    root.replaceChildren(el('p', { className: 'muted' }, t(text.trim() ? 'review.none' : 'review.empty')));
    return;
  }
  const draw = () => renderReview(root, items, text, actions);
  if (filter !== 'all' && !items.some((i) => i.kind === filter)) filter = 'all';
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  if (position >= shown.length) position = shown.length - 1;
  const current = position >= 0 ? shown[position] : null;

  const chip = (kind: ReviewKind | 'all', count: number) => {
    const button = el('button', { className: 'chip' }, `${t(`review.${kind}`)} ${formatNumber(count)}`);
    button.setAttribute('aria-pressed', String(filter === kind));
    button.onclick = () => {
      filter = kind;
      position = -1;
      draw();
    };
    return button;
  };
  const chips = [chip('all', items.length), ...KINDS.map((k) => [k, items.filter((i) => i.kind === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => chip(k, n))];

  const go = (step: number) => {
    position = position < 0 ? (step > 0 ? 0 : shown.length - 1) : (position + step + shown.length) % shown.length;
    actions.jump(shown[position]);
    draw();
  };
  const previous = el('button', {}, t('review.previous'));
  previous.onclick = () => go(-1);
  const next = el('button', {}, t('review.next'));
  next.onclick = () => go(1);
  const counter = el('span', { className: 'muted' }, t('review.position', { i: current ? position + 1 : '–', n: formatNumber(shown.length) }));

  const nodes: Node[] = [
    el('p', { className: 'muted' }, t('review.hint')),
    el('div', { className: 'row chips' }, ...chips),
    el('div', { className: 'row' }, previous, next, counter),
  ];
  if (current) {
    const around = snippet(text, current);
    const context = el('p', { className: 'context' }, around.before, el('mark', {}, current.text), around.after);
    context.onclick = () => actions.jump(current);
    nodes.push(context);
    const original = `${around.before}${current.text}${around.after}`.replace(/…/g, '');
    const spoken = actions.readAs(original);
    if (spoken !== original) nodes.push(el('p', { className: 'muted' }, t('review.readAs', { text: spoken })));
    const add = el('button', {}, t('review.addWord'));
    add.onclick = () => actions.addWord(current.text.trim());
    nodes.push(el('div', { className: 'row' }, add));
  }
  root.replaceChildren(...nodes);
}
