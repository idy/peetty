import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { renderMarkdown, renderMarkdownBubble } from '../src/chat/markdown.ts';

function target(t: TestContext) {
  const window = new Window({ url: 'https://chat.example/session' });
  t.after(async () => { await window.happyDOM.abort(); window.close(); });
  const node = window.document.createElement('div');
  const element = node as unknown as HTMLElement;
  window.document.body.append(node);
  return { element, window };
}

const CAT = ' /\\_/\\\n( o.o )\n > ^ <';

describe('DOM-only Markdown', () => {
  it('preserves soft line breaks, paragraphs and inline formatting', (t) => {
    const { element } = target(t);
    renderMarkdown(element, '**Hello**\nsecond line\n\n*italic* and ~~old~~ with `a < b`');
    assert.equal(element.querySelectorAll('p').length, 2);
    assert.equal(element.querySelectorAll('br').length, 1);
    assert.equal(element.querySelector('strong')?.textContent, 'Hello');
    assert.equal(element.querySelector('em')?.textContent, 'italic');
    assert.equal(element.querySelector('del')?.textContent, 'old');
    assert.equal(element.querySelector('code')?.textContent, 'a < b');
  });

  it('keeps the cat’s spaces and newlines inside a fenced code block', (t) => {
    const { element } = target(t);
    renderMarkdown(element, `给你画一只小猫\n\n\`\`\`text\n${CAT}\n\`\`\``);
    assert.equal(element.querySelector('pre code')?.textContent, CAT);
    assert.equal(element.querySelector('code')?.dataset.language, 'text');
    assert.ok(!element.textContent?.includes('```'));
    renderMarkdown(element, `\`\`\`text\n${CAT.slice(0, 10)}`);
    assert.equal(element.querySelector('pre code')?.textContent, CAT.slice(0, 10));
    renderMarkdown(element, `\`\`\`text\n${CAT}\n\`\`\``);
    assert.equal(element.querySelectorAll('pre').length, 1);
    assert.equal(element.querySelector('pre code')?.textContent, CAT);
  });

  it('renders lists, quotes, headings and tables as semantic nodes', (t) => {
    const { element } = target(t);
    renderMarkdown(element, '# Heading\n\n> quoted\n\n3. third\n4. fourth\n\n- [x] ready\n- [ ] next\n\n| A | B |\n| --- | --- |\n| one | two |');
    assert.equal(element.querySelector('h3')?.textContent, 'Heading');
    assert.equal(element.querySelector('blockquote')?.textContent, 'quoted');
    assert.equal(element.querySelector('ol')?.getAttribute('start'), '3');
    assert.equal(element.querySelectorAll('input[type="checkbox"]').length, 2);
    assert.equal(element.querySelector<HTMLInputElement>('input')?.disabled, true);
    assert.equal(element.querySelector<HTMLInputElement>('input')?.checked, true);
    assert.equal(element.querySelectorAll('th').length, 2);
    assert.equal(element.querySelectorAll('td').length, 2);
  });

  it('uses safe HTTP links without referrers and never fetches images', (t) => {
    const { element } = target(t);
    renderMarkdown(element, '[docs](/docs?q=1&amp;b=2 "a title")\n\n![cat](https://tracker.example/pixel)');
    const link = element.querySelector('a')!;
    assert.equal(link.href, 'https://chat.example/docs?q=1&b=2');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.referrerPolicy, 'no-referrer');
    assert.equal(link.title, 'a title');
    assert.equal(element.querySelector('img'), null);
    assert.match(element.textContent ?? '', /cat/);
  });

  it('does not turn HTML, executable URLs or credential-bearing links into active content', (t) => {
    const { element } = target(t);
    const source = '<img src=x onerror=boom>\n\n<script>boom()</script>\n\n[x](javascript:alert(1)) [y](data:text/html,boom) [z](https://user:password@example.com)';
    renderMarkdown(element, source);
    assert.equal(element.querySelector('img, script, svg, iframe, a'), null);
    assert.match(element.textContent ?? '', /<img src=x onerror=boom>/);
    assert.match(element.textContent ?? '', /<script>boom\(\)<\/script>/);
    renderMarkdown(element, '[x](jav&#x61;script:alert(1))');
    assert.equal(element.querySelector('a'), null);
  });

  it('decodes ordinary text entities but leaves code literal', (t) => {
    const { element } = target(t);
    renderMarkdown(element, 'A &amp; B &#x1f431; \\*literal\\*\n\n`&amp;`');
    assert.match(element.textContent ?? '', /A & B 🐱 \*literal\*/);
    assert.equal(element.querySelector('code')?.textContent, '&amp;');
  });

  it('renders bubble Markdown without adding links to the tab order', (t) => {
    const { element } = target(t);
    renderMarkdownBubble(element, `[docs](https://example.com)\n\n\`\`\`text\n${CAT}\n\`\`\``);
    assert.ok(element.querySelector('.pc-markdown'));
    assert.equal(element.querySelector('a'), null);
    assert.equal(element.querySelector('pre code')?.textContent, CAT);
    assert.match(element.textContent ?? '', /docs/);
  });

  it('falls back to literal text when formatting exceeds the display budget', (t) => {
    const { element } = target(t);
    const source = '**word** '.repeat(3000);
    renderMarkdown(element, source);
    assert.ok(element.querySelector('.pc-literal'));
    assert.equal(element.textContent, source);
  });

  it('works with every innerHTML setter blocked', (t) => {
    const { element, window } = target(t);
    let prototype: object | null = window.HTMLElement.prototype;
    while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'innerHTML')?.set) prototype = Object.getPrototypeOf(prototype) as object | null;
    assert.ok(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'innerHTML')!;
    Object.defineProperty(prototype, 'innerHTML', { ...descriptor, set() { throw new TypeError('TrustedHTML required.'); } });
    try {
      renderMarkdown(element, `**safe**\n\n\`\`\`text\n${CAT}\n\`\`\``);
      assert.equal(element.querySelector('strong')?.textContent, 'safe');
      assert.equal(element.querySelector('pre code')?.textContent, CAT);
    } finally { Object.defineProperty(prototype, 'innerHTML', descriptor); }
  });
});
