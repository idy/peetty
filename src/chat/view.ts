import type { ChatCopy } from './copy.ts';

type TextKey = Exclude<keyof ChatCopy, 'actions'>;
const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  close: [{ tag: 'path', attrs: { d: 'm6 6 12 12M18 6 6 18' } }],
  settings: [
    { tag: 'path', attrs: { d: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z' } },
    { tag: 'path', attrs: { d: 'm9.5 3-.7 2.1-2 .9-2-.5-2.5 4.3L4 11.4v2.2L2.3 15l2.5 4.3 2-.5 2 .9.7 2.1h5l.7-2.1 2-.9 2 .5 2.5-4.3-1.7-1.4v-2.2l1.7-1.6-2.5-4.3-2 .5-2-.9-.7-2.1Z' } },
  ],
  send: [{ tag: 'path', attrs: { d: 'm5 12 7-7 7 7M12 5v15' } }],
  stop: [{ tag: 'rect', attrs: { x: '6', y: '6', width: '12', height: '12', rx: '2' } }],
  back: [{ tag: 'path', attrs: { d: 'm10 5-7 7 7 7M3 12h17' } }],
  clear: [{ tag: 'path', attrs: { d: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6' } }],
  spark: [{ tag: 'path', attrs: { d: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' } }],
} as const;
export type IconName = keyof typeof ICONS;

/** Build SVG nodes directly: no HTML parser, Trusted Types policy, or string sinks. */
export function icon(name: IconName, document: Document = globalThis.document): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const attrs = {
    viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const shape of ICONS[name]) {
    const part = document.createElementNS(SVG, shape.tag);
    for (const [key, value] of Object.entries(shape.attrs)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}

export function setIcon(button: HTMLElement, name: IconName): void {
  if (button.dataset.pcIcon === name) return;
  button.replaceChildren(icon(name, button.ownerDocument));
  button.dataset.pcIcon = name;
}

/** Static shell with text/attribute bindings; retranslation never touches form values. */
export function buildChatView(panel: HTMLElement, copy: () => ChatCopy): { translate: () => void } {
  const document = panel.ownerDocument;
  const bindings: (() => void)[] = [];
  const text = (key: TextKey) => {
    const node = document.createTextNode('');
    bindings.push(() => { node.data = copy()[key]; });
    return node;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', attrs: Record<string, string | number | boolean> = {}, ...children: Node[]): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== false) node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children);
    return node;
  };
  const attr = <T extends HTMLElement>(node: T, name: string, key: TextKey): T => {
    bindings.push(() => node.setAttribute(name, copy()[key]));
    return node;
  };
  const labelled = <T extends HTMLElement>(node: T, key: TextKey, title = false): T => {
    attr(node, 'aria-label', key);
    if (title) attr(node, 'title', key);
    return node;
  };
  const button = (className: string, key: TextKey) => el('button', className, { type: 'button' }, text(key));
  const iconButton = (className: string, key: TextKey, name: IconName, type = 'button') => {
    const node = labelled(el('button', className, { type }), key, true);
    setIcon(node, name);
    return node;
  };
  const field = (key: TextKey, input: HTMLElement) => el('label', 'pc-field', {}, el('span', '', {}, text(key)), input);

  const header = el('header', 'pc-header', {},
    el('div', 'pc-avatar', { 'aria-hidden': 'true' }),
    el('div', 'pc-heading', {}, el('h2', 'pc-name'), el('div', 'pc-status')),
    iconButton('pc-icon pc-settings', 'settings', 'settings'),
    iconButton('pc-icon pc-close', 'close', 'close'),
  );
  const keyInput = el('input', 'pc-input', { name: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
  const modelSelect = labelled(el('select', 'pc-input pc-models', { hidden: true }), 'model');
  const effort = el('select', 'pc-input', { name: 'effort' });
  for (const [value, label] of [
    ['', 'effortDefault'], ['minimal', 'effortMinimal'], ['low', 'effortLow'], ['medium', 'effortMedium'],
    ['high', 'effortHigh'], ['xhigh', 'effortXhigh'], ['max', 'effortMax'],
  ] as const) effort.append(el('option', '', { value }, text(label)));
  const privacy = el('p', 'pc-note', {}, text('privacy'));
  privacy.style.marginTop = '12px';
  privacy.style.marginBottom = '0';
  const setup = el('form', 'pc-setup', { hidden: true },
    el('h3', '', {}, text('title')),
    el('p', 'pc-intro', {}, text('intro')),
    el('div', 'pc-local', {},
      button('pc-small pc-magpie', 'magpie'),
      el('p', 'pc-note pc-magpie-note', { hidden: true }, text('magpieHint'), document.createTextNode(' '), el('code', 'pc-magpie-origin'), el('br'), text('magpieAuth')),
    ),
    field('provider', el('input', 'pc-input', { name: 'provider', maxlength: 200, placeholder: 'OpenAI / Magpie / …', autocomplete: 'off' })),
    field('url', el('input', 'pc-input', { name: 'url', type: 'url', placeholder: 'https://api.example.com/v1', required: true, autocomplete: 'off', spellcheck: 'false' })),
    el('label', 'pc-field', {}, el('span', 'pc-key-label'),
      el('div', 'pc-key', {}, keyInput, el('button', 'pc-show-key', { type: 'button' }))),
    el('div', 'pc-discover', {}, el('button', 'pc-small pc-load', { type: 'button' }), button('pc-link pc-manual', 'manual')),
    el('label', 'pc-field pc-model-field', {}, el('span', '', {}, text('model')),
      el('input', 'pc-input', { name: 'model', placeholder: 'model-id', required: true, autocomplete: 'off', spellcheck: 'false' }), modelSelect),
    field('effort', effort),
    el('p', 'pc-note', {}, text('effortHint')),
    el('label', 'pc-check', {}, el('input', '', { name: 'tools', type: 'checkbox', checked: true }), el('span', '', {}, text('allowActions'))),
    el('p', 'pc-note', {}, text('actionsHint')),
    el('label', 'pc-check', {}, el('input', '', { name: 'remember', type: 'checkbox', checked: true }), el('span', '', {}, text('remember'))),
    el('p', 'pc-note', {}, text('keyNote')),
    el('button', 'pc-primary', { type: 'submit' }, text('connect'), icon('send', document)),
    el('button', 'pc-small pc-visit-only', { type: 'submit', hidden: true, 'aria-describedby': 'pc-visit-note' }, text('visitOnly')),
    el('p', 'pc-note pc-visit-note', { id: 'pc-visit-note', hidden: true }, text('visitOnlyNote')),
    privacy,
  );
  const input = attr(labelled(el('textarea', '', { name: 'message', rows: 1, maxlength: 8000 }), 'placeholder'), 'placeholder', 'placeholder');
  panel.append(
    header,
    el('p', 'pc-storage', { hidden: true }, text('storage')),
    el('div', 'pc-content', {}, setup,
      el('div', 'pc-empty', {}, el('div', 'pc-hero', { 'aria-hidden': 'true' }), el('h3', '', {}, text('empty')), el('p', '', {}, text('emptyBody'))),
      labelled(el('div', 'pc-messages', { role: 'log', 'aria-live': 'off' }), 'chat')),
    el('p', 'pc-error', { role: 'alert', hidden: true }),
    el('div', 'pc-tools', {}, el('span', 'pc-activity'), button('pc-link pc-clear', 'clear'),
      el('span', 'pc-confirm', { hidden: true }, el('span', '', {}, text('confirmClear')), button('pc-link pc-clear-now', 'clearNow'), button('pc-link pc-cancel', 'cancel'))),
    el('form', 'pc-composer', {},
      el('div', 'pc-compose-row', {}, input, iconButton('pc-icon pc-submit', 'send', 'send', 'submit')),
      el('p', 'pc-foot', {}, text('footer'))),
    el('span', 'pc-sr pc-announcement', { role: 'status' }),
  );
  attr(panel, 'aria-label', 'chat');
  const translate = () => { for (const update of bindings) update(); };
  translate();
  return { translate };
}
