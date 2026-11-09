import { Lexer, type MarkedToken, type Tokens } from 'marked';

export const MARKDOWN_STYLE = `
.pc-markdown { white-space: normal; overflow-wrap: anywhere; }
.pc-markdown > :first-child { margin-top: 0; }
.pc-markdown > :last-child { margin-bottom: 0; }
.pc-markdown p { margin: 0 0 .65em; }
.pc-markdown h3, .pc-markdown h4, .pc-markdown h5, .pc-markdown h6 { margin: 1em 0 .4em; font-size: 1.05em; line-height: 1.45; }
.pc-markdown ul, .pc-markdown ol { margin: .5em 0; padding-left: 1.5em; }
.pc-markdown li { margin: .2em 0; }
.pc-markdown li > p { margin: 0; }
.pc-markdown blockquote { margin: .6em 0; padding: .2em .75em; border-left: 1px solid var(--pc-line, var(--peetty-line, #e2deef)); }
.pc-markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; background: var(--pc-soft, var(--peetty-hover, #f2edf9)); border-radius: 4px; padding: .12em .3em; }
.pc-markdown pre { max-width: 100%; overflow: auto; margin: .65em 0; padding: 10px 12px; border-radius: 9px; background: var(--pc-soft, var(--peetty-hover, #f2edf9)); white-space: pre; overflow-wrap: normal; word-break: normal; tab-size: 2; line-height: 1.5; }
.pc-markdown pre code { display: block; background: none; padding: 0; white-space: inherit; }
.pc-markdown a { color: var(--pc-accent, var(--peetty-accent, #6753b8)); text-decoration: underline; text-underline-offset: 3px; }
.pc-markdown a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 2px; }
.pc-markdown hr { border: 0; border-top: 1px solid var(--pc-line, var(--peetty-line, #e2deef)); margin: .8em 0; }
.pc-markdown table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; margin: .65em 0; font-size: .9em; }
.pc-markdown th, .pc-markdown td { padding: .35em .6em; border: 1px solid var(--pc-line, var(--peetty-line, #e2deef)); text-align: left; }
.pc-markdown .pc-literal { white-space: pre-wrap; }
.bubble .pc-markdown { max-height: 180px; overflow: auto; pointer-events: auto; line-height: 1.45; }
.bubble .pc-markdown pre { padding: 7px 9px; }
`;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function references(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (source, name: string) => {
    if (!name.startsWith('#')) return ENTITIES[name.toLowerCase()] ?? source;
    const point = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '�';
  });
}

/** Markdown tokens become DOM nodes, never HTML strings. Images remain alt text. */
export function renderMarkdown(target: HTMLElement, source: string, options: { links?: boolean } = {}): void {
  const doc = target.ownerDocument;
  let count = 0;
  const children = (tokens: readonly MarkedToken[], depth: number): DocumentFragment => {
    if (depth > 48 || count > 4096) throw new Error('Markdown exceeds the display budget.');
    const fragment = doc.createDocumentFragment();
    for (const token of tokens) fragment.appendChild(render(token, depth));
    return fragment;
  };
  const wrap = (tag: string, tokens: readonly MarkedToken[], depth: number): HTMLElement => {
    if (++count > 4096) throw new Error('Markdown exceeds the display budget.');
    const element = doc.createElement(tag);
    element.append(children(tokens, depth + 1));
    return element;
  };
  const render = (token: MarkedToken, depth: number): Node => {
    if (++count > 4096) throw new Error('Markdown exceeds the display budget.');
    switch (token.type) {
      case 'space': case 'def': return doc.createTextNode('');
      case 'br': return doc.createElement('br');
      case 'hr': return doc.createElement('hr');
      case 'paragraph': return wrap('p', token.tokens as MarkedToken[], depth);
      case 'heading': return wrap(`h${Math.min(6, token.depth + 2)}`, token.tokens as MarkedToken[], depth);
      case 'blockquote': return wrap('blockquote', token.tokens as MarkedToken[], depth);
      case 'strong': return wrap('strong', token.tokens as MarkedToken[], depth);
      case 'em': return wrap('em', token.tokens as MarkedToken[], depth);
      case 'del': return wrap('del', token.tokens as MarkedToken[], depth);
      case 'text': return token.tokens ? children(token.tokens as MarkedToken[], depth + 1) : doc.createTextNode(references(token.text));
      case 'escape': return doc.createTextNode(token.text);
      case 'codespan': {
        const code = doc.createElement('code'); code.textContent = token.text; return code;
      }
      case 'code': {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = token.text;
        if (token.lang && /^[\w+-]{1,32}$/.test(token.lang)) code.dataset.language = token.lang;
        pre.append(code); return pre;
      }
      case 'list': {
        const list = doc.createElement(token.ordered ? 'ol' : 'ul');
        if (token.ordered && typeof token.start === 'number' && Number.isSafeInteger(token.start)) list.setAttribute('start', String(token.start));
        for (const item of token.items) list.append(render(item, depth + 1));
        return list;
      }
      case 'list_item': return wrap('li', token.tokens as MarkedToken[], depth);
      case 'checkbox': {
        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox'; checkbox.disabled = true; checkbox.checked = token.checked; return checkbox;
      }
      case 'link': {
        const label = children(token.tokens as MarkedToken[], depth + 1);
        let url: URL | undefined;
        try { url = new URL(token.autolink ? token.href : references(token.href), doc.baseURI); } catch { /* Invalid destinations stay text. */ }
        if (options.links === false || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return label;
        const link = doc.createElement('a');
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
        if (token.title) link.title = references(token.title);
        link.append(label); return link;
      }
      case 'image': return doc.createTextNode(references(token.text || '[image]'));
      case 'html': {
        const literal = doc.createElement('span');
        literal.className = 'pc-literal'; literal.textContent = token.text; return literal;
      }
      case 'table': {
        const table = doc.createElement('table');
        const row = (cells: Tokens.TableCell[], header: boolean) => {
          const tr = doc.createElement('tr');
          for (const cell of cells) {
            const td = wrap(header ? 'th' : 'td', cell.tokens as MarkedToken[], depth + 1);
            if (cell.align) td.style.textAlign = cell.align;
            tr.append(td);
          }
          return tr;
        };
        const head = doc.createElement('thead'); head.append(row(token.header, true));
        const body = doc.createElement('tbody');
        for (const cells of token.rows) body.append(row(cells, false));
        table.append(head, body); return table;
      }
    }
  };
  target.classList.add('pc-markdown');
  try { target.replaceChildren(children(Lexer.lex(source, { gfm: true, breaks: true }) as MarkedToken[], 0)); }
  catch {
    const literal = doc.createElement('div'); literal.className = 'pc-literal'; literal.textContent = source;
    target.replaceChildren(literal);
  }
}

/** Compact bubbles share formatting, but never add links to the companion's tab order. */
export function renderMarkdownBubble(target: HTMLElement, source: string): void {
  const content = target.ownerDocument.createElement('div');
  renderMarkdown(content, source, { links: false });
  target.replaceChildren(content);
}
