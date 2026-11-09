import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, mock } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';

it('reuses the mounted companion on site language changes without recreating or persisting the session', async (t) => {
  const dom = new Window({ url: 'https://peetty.example/' });
  t.after(async () => { await dom.happyDOM.abort(); dom.close(); });
  const document = dom.document;
  for (const figure of ['miru', 'elsie']) {
    const button = document.createElement('button');
    button.dataset.figure = figure;
    document.body.append(button);
  }
  const input = document.createElement('input');
  input.dataset.i18nPlaceholder = 'demo.placeholder';
  const chat = document.createElement('button');
  chat.setAttribute('data-peetty-chat', '');
  document.body.append(input, chat);
  const pet = {
    mount: mock.fn(async () => {}),
    destroy: mock.fn(),
    setLanguage: mock.fn((_language: string) => {}),
    show: mock.fn(),
    setFigure: mock.fn(async (_figure: string) => {}),
    play: mock.fn((_action: string) => {}),
    openChat: mock.fn(async () => {}),
  };
  const create = mock.fn((_options: { figure: string; language: string }) => pet);
  const window = { Peetty: { createPeetty: create }, peetty: null as typeof pet | null };
  const site = { language: 'en', t(key: string) { return `${this.language}:${key}`; } };
  const save = mock.fn();
  const source = readFileSync(new URL('../site/script.js', import.meta.url), 'utf8');
  runInNewContext(source, { document, window, IdySite: site, localStorage: { getItem: () => null, setItem: save }, console });
  assert.equal(window.peetty, pet);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0]!.arguments[0].language, 'en');
  assert.equal(pet.mount.mock.callCount(), 1);
  assert.equal(input.placeholder, 'en:demo.placeholder');

  for (const language of ['zh', 'zh', 'en']) {
    site.language = language;
    document.dispatchEvent(new dom.Event('idy:languagechange'));
    assert.equal(window.peetty, pet);
    assert.equal(input.placeholder, `${language}:demo.placeholder`);
  }
  assert.deepEqual(pet.setLanguage.mock.calls.map((call) => call.arguments[0]), ['zh', 'en']);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(pet.mount.mock.callCount(), 1);
  assert.equal(pet.destroy.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
  chat.click();
  assert.equal(pet.show.mock.callCount(), 1);
  assert.equal(pet.openChat.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 1);
});
