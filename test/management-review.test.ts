import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { createManagement } from '../src/chat/management.ts';
import { COPY as CHAT_COPY } from '../src/chat/copy.ts';
import { COMPANION_ACTIONS } from '../src/chat/types.ts';
import { BrowserProfileStore, type BackupDownloadFile } from '../src/chat/profiles.ts';
import { PROFILE_LIMITS } from '../src/chat/limits.ts';
import type { Language } from '../src/pet/i18n.ts';
import type { Figure } from '../src/figure/types.ts';
import { installChatIndexedDB } from './helpers/chat-storage.ts';
import { deferred } from './helpers/pet-dom.ts';

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const memory = (id: string, text: string) => ({ id, text, manual: true, createdAt: 1, updatedAt: 2 });

async function mount(t: TestContext, options: {
  store?: BrowserProfileStore;
  seed?: (store: BrowserProfileStore) => Promise<void>;
  onSelect?: () => Promise<void>;
  onReload?: () => Promise<void>;
  onBusy?: (busy: boolean) => void;
  backup?: (signal?: AbortSignal) => Promise<string | AsyncIterable<BackupDownloadFile>>;
} = {}) {
  const window = new Window({ url: 'https://host.example/' });
  const document = window.document as unknown as Document;
  const store = options.store ?? new BrowserProfileStore(`management-${crypto.randomUUID()}`);
  await store.initialize({ name: 'Original profile' });
  await options.seed?.(store);
  const viewport = document.createElement('div'); const host = document.createElement('div');
  viewport.append(host); document.body.append(viewport);
  const root = host.attachShadow({ mode: 'open' });
  let language: Language = 'en';
  const management = createManagement({
    document, store, language: () => language, onSelect: options.onSelect ?? (async () => {}), onReload: options.onReload ?? (async () => {}),
    onTab() {}, ...(options.onBusy ? { onBusy: options.onBusy } : {}), backup: options.backup ?? (() => store.backup()),
  });
  root.append(management.element); management.show(true);
  t.after(async () => { management.destroy(); store.close(); await window.happyDOM.abort(); window.close(); });
  const query = <T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = root): T => {
    const result = scope.querySelector<T>(selector); assert.ok(result, `${selector} exists`); return result;
  };
  const click = (text: string, scope: ParentNode = root) => {
    const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
    assert.ok(result, `${text} button exists`); result.click(); return result;
  };
  const tab = (name: 'profile' | 'memory' | 'history' | 'data') => query<HTMLButtonElement>(`[data-tab="${name}"]`).click();
  const input = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  };
  const select = async (id: string) => {
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = id;
    selector.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event); await flush();
  };
  return { window, document, store, root, viewport, management, query, click, tab, input, select, language(value: Language) { language = value; management.translate(); } };
}

function forbidSnapshots(t: TestContext, store: BrowserProfileStore) {
  for (const key of ['activeProfile', 'profiles']) {
    Object.defineProperty(store, key, { configurable: true, get() { throw new Error(`Management must not read ${key}.`); } });
    t.after(() => Reflect.deleteProperty(store, key));
  }
}

describe('multipart backup UI', () => {
  it('pulls streaming parts lazily with at most two retained URLs and localized progress', async (t) => {
    installChatIndexedDB(t);
    let produced = 0; let closed = false;
    async function* parts() {
      try { for (let i = 1; i <= 5; i++) { produced++; yield { name: `part-${i}.json`, text: `fixture part ${i}` }; } }
      finally { closed = true; }
    }
    const ui = await mount(t, { backup: async () => parts() }); ui.tab('data');
    let created = 0; const retained = new Set<string>(); const names: string[] = [];
    t.mock.method(URL, 'createObjectURL', () => { const url = `blob:fixture-part-${++created}`; retained.add(url); assert.ok(retained.size <= 2); return url; });
    t.mock.method(URL, 'revokeObjectURL', (url: string) => { retained.delete(url); });
    ui.root.addEventListener('click', event => { const link = (event.target as Element).closest<HTMLAnchorElement>('a[download]'); if (link) { event.preventDefault(); names.push(link.download); } });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    ui.click('Download full backup'); await flush();
    assert.equal(produced, 2, 'the producer is not advanced while URL slots are full'); assert.equal(created, 2);
    assert.equal(ui.query<HTMLButtonElement>('[data-cancel-download]').disabled, false);
    assert.match(ui.query('.pc-manage-status').textContent!, /Allow multiple downloads.*keep every part.*two parts per minute/);
    ui.language('zh'); assert.match(ui.query('.pc-manage-status').textContent!, /允许浏览器下载多个文件.*保留全部分卷.*每分钟最多下载两个分卷/);
    t.mock.timers.tick(59_999); await flush(); assert.equal(produced, 2); assert.equal(retained.size, 2);
    t.mock.timers.tick(1); await flush(); assert.equal(produced, 4); assert.equal(retained.size, 2);
    t.mock.timers.tick(60_000); await flush(); assert.equal(produced, 5); assert.equal(closed, true);
    assert.deepEqual(names, [1, 2, 3, 4, 5].map(i => `part-${i}.json`));
    assert.match(ui.query('.pc-manage-status').textContent!, /全部备份分卷已准备下载/);
    ui.management.destroy(); ui.window.close(); t.mock.timers.tick(59_999); assert.equal(retained.size, 1);
    t.mock.timers.tick(1); assert.equal(retained.size, 0);
  });

  for (const ending of ['cancel', 'destroy'] as const) {
    it(`closes a waiting producer on ${ending} without shortening existing URL lifetimes`, async (t) => {
      installChatIndexedDB(t); let produced = 0; let closed = 0;
      async function* parts() { try { for (;;) { produced++; yield { name: `part-${produced}.json`, text: 'fixture bounded part' }; } } finally { closed++; } }
      const ui = await mount(t, { backup: async () => parts() }); ui.tab('data');
      let created = 0; const revoked: string[] = [];
      t.mock.method(URL, 'createObjectURL', () => `blob:cancel-part-${++created}`); t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
      ui.root.addEventListener('click', event => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      ui.click('Download full backup'); await flush(); assert.equal(produced, 2);
      if (ending === 'cancel') ui.click('Cancel remaining downloads'); else ui.management.destroy();
      await flush(); assert.equal(closed, 1, 'return releases the suspended producer immediately'); assert.equal(produced, 2);
      if (ending === 'cancel') {
        assert.match(ui.query('.pc-manage-status').textContent!, /canceled.*incomplete/); assert.equal(ui.query<HTMLButtonElement>('.pc-backup').disabled, false);
        ui.click('Download full backup'); await flush(); assert.equal(produced, 2, 'a retry also respects still-live URLs');
        ui.click('Cancel remaining downloads'); await flush();
      }
      t.mock.timers.tick(59_999); await flush(); assert.deepEqual(revoked, []); assert.equal(produced, 2);
      t.mock.timers.tick(1); await flush(); assert.deepEqual(revoked, ['blob:cancel-part-1', 'blob:cancel-part-2']); assert.equal(created, 2);
    });
  }

  it('requests producer closure promptly when cancellation interrupts a pending next()', async (t) => {
    installChatIndexedDB(t); const next = deferred<IteratorResult<BackupDownloadFile>>(); let returned = 0;
    const producer: AsyncIterable<BackupDownloadFile> = { [Symbol.asyncIterator]: () => ({ next: () => next.promise, return: async () => { returned++; return { done: true, value: undefined }; } }) };
    const ui = await mount(t, { backup: async () => producer }); ui.tab('data');
    const create = t.mock.method(URL, 'createObjectURL', () => 'blob:late-producer');
    ui.click('Download full backup'); await flush();
    ui.click('Cancel remaining downloads'); await flush();
    assert.equal(returned, 1); assert.match(ui.query('.pc-manage-status').textContent!, /canceled/);
    assert.equal(ui.query<HTMLButtonElement>('.pc-backup').disabled, false);
    next.resolve({ done: false, value: { name: 'late.json', text: 'late fixture part' } }); await flush();
    assert.equal(create.mock.callCount(), 0, 'late parts cannot become downloads after cancellation');
  });

  it('reads all selected restore parts together and retains single-file memory import', async (t) => {
    installChatIndexedDB(t); const ui = await mount(t); ui.tab('data');
    const restore = t.mock.method(ui.store, 'restoreFiles', async (_texts: readonly string[]) => {});
    const input = ui.query<HTMLInputElement>('input[type="file"][multiple]');
    assert.equal(input.multiple, true);
    const files = [new ui.window.File(['first fixture part'], 'part-1.json'), new ui.window.File(['second fixture part'], 'part-2.json')];
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new ui.window.Event('change') as unknown as Event); await flush();
    assert.equal(restore.mock.callCount(), 1);
    assert.deepEqual(restore.mock.calls[0]!.arguments[0], ['first fixture part', 'second fixture part']);
    assert.equal(ui.query<HTMLInputElement>('input[type="file"]:not([multiple])').multiple, false);
    assert.match(ui.query('.pc-manage-status').textContent!, /Import complete/);
  });

  it('validates every restore part size before reading any file', async (t) => {
    installChatIndexedDB(t); const ui = await mount(t); ui.tab('data');
    let reads = 0;
    const file = (size: number) => ({ size, text: async () => { reads++; return '{}'; } });
    const input = ui.query<HTMLInputElement>('input[type="file"][multiple]');
    Object.defineProperty(input, 'files', { configurable: true, value: [file(2), file(PROFILE_LIMITS.fileBytes + 1)] });
    const restore = t.mock.method(ui.store, 'restoreFiles', async (_texts: readonly string[]) => {});
    input.dispatchEvent(new ui.window.Event('change') as unknown as Event); await flush();
    assert.equal(reads, 0); assert.equal(restore.mock.callCount(), 0);
    assert.equal(ui.query('.pc-manage-status').hasAttribute('data-error'), true);
  });
});

describe('explicit previous-format cleanup', () => {
  it('requires confirmation, supports cancellation and leaves the current profile intact', async (t) => {
    installChatIndexedDB(t); const ui = await mount(t); const before = ui.store.activeProfile;
    const cleanup = t.mock.method(ui.store, 'clearLegacyData', async () => {});
    ui.tab('data'); assert.equal(cleanup.mock.callCount(), 0);
    assert.match(ui.root.textContent!, /previous-format chat and API key copies.*current profiles, conversations and connections are kept/);
    ui.click('Delete previous-format copies'); assert.equal(cleanup.mock.callCount(), 0);
    assert.equal(ui.query('[data-focus-key="confirm-legacy"]').parentElement!.hidden, false);
    ui.click('Cancel'); assert.equal(cleanup.mock.callCount(), 0);
    assert.equal(ui.query('[data-focus-key="confirm-legacy"]').parentElement!.hidden, true);
    ui.click('Delete previous-format copies'); ui.language('zh');
    assert.match(ui.root.textContent!, /当前档案、聊天与模型连接都会保留/);
    ui.click('永久删除旧聊天与密钥副本'); await flush();
    assert.equal(cleanup.mock.callCount(), 1); assert.deepEqual(ui.store.activeProfile, before);
    assert.match(ui.query('.pc-manage-status').textContent!, /旧格式副本已删除，当前档案已保留/);
    assert.equal(ui.query('[data-focus-key="confirm-legacy"]').parentElement!.hidden, true);
  });

  it('reports failed cleanup without hiding the confirmation or changing current data', async (t) => {
    installChatIndexedDB(t); const ui = await mount(t); const before = ui.store.activeProfile;
    const cleanup = t.mock.method(ui.store, 'clearLegacyData', async () => { throw new Error('Fixture legacy database is blocked'); });
    ui.tab('data'); ui.click('Delete previous-format copies'); ui.click('Permanently delete old chat and key copies'); await flush();
    assert.equal(cleanup.mock.callCount(), 1); assert.deepEqual(ui.store.activeProfile, before);
    assert.equal(ui.query('.pc-manage-status').hasAttribute('data-error'), true);
    assert.equal(ui.query('[data-focus-key="confirm-legacy"]').parentElement!.hidden, false);
    assert.equal(ui.query<HTMLButtonElement>('[data-focus-key="confirm-legacy"]').disabled, false);
    ui.click('Cancel'); assert.equal(cleanup.mock.callCount(), 1);
  });
});

describe('management draft and language continuity', () => {
  it('translates profile controls in place and preserves unsaved fields, selection and scroll through refresh', async (t) => {
    installChatIndexedDB(t);
    const ui = await mount(t);
    forbidSnapshots(t, ui.store); ui.tab('profile');
    const name = ui.query<HTMLInputElement>('[aria-label="Profile name"]'); name.value = 'Unsaved name';
    const character = ui.query<HTMLSelectElement>('[aria-label="Character"]'); character.value = 'elsie';
    const personality = ui.query<HTMLTextAreaElement>('[aria-label="Personality and conversation style"]');
    personality.value = 'Keep the user text Edit, Delete and Profile verbatim.\nAnother line.';
    const newName = ui.query<HTMLInputElement>('[aria-label="New profile name"]'); newName.value = 'Uncreated companion';
    personality.focus(); personality.setSelectionRange(5, 17, 'backward'); personality.scrollTop = 26; ui.viewport.scrollTop = 210;
    ui.language('zh');
    assert.equal(ui.query('[aria-label="性格与交流方式"]'), personality, 'language changes keep the input node');
    assert.equal(ui.root.activeElement, personality);
    assert.deepEqual([personality.selectionStart, personality.selectionEnd, personality.selectionDirection], [5, 17, 'backward']);
    assert.equal(personality.scrollTop, 26); assert.equal(ui.viewport.scrollTop, 210);
    assert.equal(name.value, 'Unsaved name'); assert.equal(character.value, 'elsie'); assert.equal(newName.value, 'Uncreated companion');
    ui.management.refresh();
    const restored = ui.query<HTMLTextAreaElement>('[aria-label="性格与交流方式"]');
    assert.equal(restored.value, personality.value); assert.equal(ui.root.activeElement, restored);
    assert.deepEqual([restored.selectionStart, restored.selectionEnd, restored.selectionDirection], [5, 17, 'backward']);
    assert.equal(restored.scrollTop, 26); assert.equal(ui.viewport.scrollTop, 210);
    assert.equal(ui.query<HTMLInputElement>('[aria-label="档案名称"]').value, 'Unsaved name');
    assert.equal(ui.query<HTMLSelectElement>('[aria-label="角色"]').value, 'elsie');
    assert.equal(ui.query<HTMLInputElement>('[aria-label="新档案名称"]').value, 'Uncreated companion');
    assert.equal(ui.store.profileInfo(ui.store.activeProfileId)!.name, 'Original profile');
  });

  for (const kind of ['memory', 'history'] as const) {
    it(`keeps multiple ${kind} editors, caret, search and user content when translating or refreshing`, async (t) => {
      installChatIndexedDB(t);
      const ui = await mount(t, { seed: async (store) => {
        const id = store.activeProfileId;
        await store.storage(id).saveEntries(Array.from({ length: 4 }, (_, i) => ({ id: `history-${i}`, role: 'user' as const, text: `match Edit <b>source ${i}</b>`, createdAt: i + 1 })));
        await store.importMemories(id, JSON.stringify({ format: 'peetty-memories', version: 1, memories: Array.from({ length: 4 }, (_, i) => memory(`memory-${i}`, `match Delete <b>fact ${i}</b>`)) }));
      } });
      forbidSnapshots(t, ui.store); ui.tab(kind);
      const search = ui.query<HTMLInputElement>('input[type="search"]'); ui.input(search, 'match');
      let draft: HTMLTextAreaElement | undefined;
      if (kind === 'memory') { draft = ui.query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]'); draft.value = 'Unsubmitted memory in English'; draft.scrollTop = 11; }
      const records = [...ui.root.querySelectorAll<HTMLElement>('.pc-record')];
      ui.click('Edit', records[0]!); ui.click('Edit', records[1]!);
      const editors = [...ui.root.querySelectorAll<HTMLTextAreaElement>('[aria-label="Edit"]')];
      editors[0]!.value = 'First unsaved Edit <script>literal user text</script>';
      editors[0]!.setSelectionRange(2, 8, 'forward'); editors[0]!.scrollTop = 13;
      editors[1]!.value = 'Second unsaved Delete 中文'; editors[1]!.focus(); editors[1]!.setSelectionRange(4, 12, 'backward'); editors[1]!.scrollTop = 22;
      ui.viewport.scrollTop = 480; ui.language('zh');
      assert.equal(ui.root.querySelectorAll('[aria-label="编辑"]')[0], editors[0]);
      assert.equal(ui.root.activeElement, editors[1]); assert.equal(search.value, 'match');
      assert.deepEqual([editors[1]!.selectionStart, editors[1]!.selectionEnd, editors[1]!.selectionDirection], [4, 12, 'backward']);
      assert.match(ui.root.textContent!, kind === 'memory' ? /match Delete <b>fact/ : /match Edit <b>source/);
      assert.equal(ui.root.querySelector('script,b'), null, 'user markup remains literal text');
      ui.management.refresh();
      const restored = [...ui.root.querySelectorAll<HTMLTextAreaElement>('[aria-label="编辑"]')];
      assert.equal(restored.length, 2); assert.equal(restored[0]!.value, editors[0]!.value); assert.equal(restored[1]!.value, editors[1]!.value);
      assert.equal(ui.root.activeElement, restored[1]);
      assert.deepEqual([restored[0]!.selectionStart, restored[0]!.selectionEnd, restored[0]!.selectionDirection, restored[0]!.scrollTop], [2, 8, 'forward', 13]);
      assert.deepEqual([restored[1]!.selectionStart, restored[1]!.selectionEnd, restored[1]!.selectionDirection, restored[1]!.scrollTop], [4, 12, 'backward', 22]);
      assert.equal(ui.query<HTMLInputElement>('input[type="search"]').value, 'match'); assert.equal(ui.viewport.scrollTop, 480);
      if (draft) assert.equal(ui.query<HTMLTextAreaElement>('[aria-label="你希望伙伴记住什么？"]').value, draft.value);
    });
  }

  it('preserves expanded source details and literal source text without HTML string sinks', async (t) => {
    installChatIndexedDB(t);
    const ui = await mount(t, { seed: async (store) => {
      const id = store.activeProfileId;
      await store.storage(id).saveEntries([{ id: 'source', role: 'user', text: 'Edit <b>my literal source</b>', createdAt: 1 }]);
      await store.saveMemory(id, { text: 'A source-linked fact', sourceEntryId: 'source', manual: true });
    } });
    const innerHTML = Object.getOwnPropertyDescriptor(ui.window.Element.prototype, 'innerHTML')!;
    let writes = 0;
    Object.defineProperty(ui.window.Element.prototype, 'innerHTML', { ...innerHTML, set() { writes++; throw new TypeError('TrustedHTML required.'); } });
    t.after(() => Object.defineProperty(ui.window.Element.prototype, 'innerHTML', innerHTML));
    forbidSnapshots(t, ui.store);
    const sourceText = ui.store.sourceText.bind(ui.store); const sources: string[] = [];
    t.mock.method(ui.store, 'sourceText', (id: string, entryId: string) => { sources.push(entryId); return sourceText(id, entryId); });
    ui.tab('memory'); const details = ui.query<HTMLDetailsElement>('details');
    assert.deepEqual(sources, [], 'collapsed sources do not build the history index');
    assert.equal(details.querySelector('p'), null, 'source text is not materialized until expansion');
    details.open = true; details.dispatchEvent(new ui.window.Event('toggle') as unknown as Event);
    details.open = false; details.open = true; details.dispatchEvent(new ui.window.Event('toggle') as unknown as Event);
    assert.deepEqual(sources, ['source'], 'reopening an existing source reuses its contents');
    const summary = ui.query<HTMLElement>('summary', details); summary.focus(); ui.viewport.scrollTop = 140;
    ui.language('zh'); assert.equal(ui.query('details'), details); assert.equal(details.open, true); assert.equal(ui.root.activeElement, summary);
    assert.match(details.textContent!, /Edit <b>my literal source<\/b>/); assert.equal(details.querySelector('b'), null);
    ui.management.refresh(); assert.equal(ui.query<HTMLDetailsElement>('details').open, true);
    assert.equal(ui.root.activeElement, ui.query('summary'));
    assert.match(ui.query('details').textContent!, /Edit <b>my literal source<\/b>/); assert.equal(ui.viewport.scrollTop, 140);
    assert.deepEqual(sources, ['source', 'source']); assert.equal(writes, 0);
  });
});

describe('management source evidence and history previews', () => {
  it('shows the original memory source after edits and deletion with translated status', async (t) => {
    installChatIndexedDB(t);
    const ui = await mount(t, { seed: async (store) => {
      const id = store.activeProfileId;
      await store.storage(id).saveEntries([{ id: 'source', role: 'user', text: 'I prefer tea <b>original</b>.', createdAt: 1 }]);
      await store.saveMemory(id, { text: 'Prefers tea', sourceEntryId: 'source', manual: true });
      await store.editEntry(id, 'source', 'I prefer coffee now.');
    } });
    ui.tab('memory');
    const details = ui.query<HTMLDetailsElement>('details'); details.open = true;
    details.dispatchEvent(new ui.window.Event('toggle') as unknown as Event);
    assert.equal(ui.query('p', details).textContent, 'I prefer tea <b>original</b>.');
    assert.equal(details.querySelector('b'), null); assert.doesNotMatch(details.textContent!, /coffee/);
    assert.match(details.textContent!, /message has changed/);
    ui.language('zh'); assert.equal(ui.query('details'), details);
    assert.match(details.textContent!, /已被修改/); assert.match(details.textContent!, /I prefer tea/);
    ui.management.refresh(); assert.equal(ui.query<HTMLDetailsElement>('details').open, true);
    assert.equal(ui.query('details p').textContent, 'I prefer tea <b>original</b>.');
    await ui.store.removeEntry(ui.store.activeProfileId, 'source'); ui.management.refresh();
    assert.equal(ui.query('details p').textContent, 'I prefer tea <b>original</b>.');
    assert.match(ui.query('details').textContent!, /来源消息已不在/);
  });

  it('localizes every history action in place and on refresh without translating user text', async (t) => {
    installChatIndexedDB(t);
    const ui = await mount(t, { seed: async (store) => {
      await store.storage(store.activeProfileId).saveEntries([
        ...COMPANION_ACTIONS.map((action, i) => ({ id: action, role: 'action' as const, text: action, createdAt: i + 1 })),
        { id: 'literal', role: 'user', text: 'wave', createdAt: 10 },
      ]);
    } });
    ui.tab('history');
    const wave = ui.query('[data-entry-id="wave"] > p');
    for (const action of COMPANION_ACTIONS) assert.equal(ui.query(`[data-entry-id="${action}"] > p`).textContent, CHAT_COPY.en.actions[action]);
    ui.language('zh'); assert.equal(ui.query('[data-entry-id="wave"] > p'), wave);
    for (const action of COMPANION_ACTIONS) assert.equal(ui.query(`[data-entry-id="${action}"] > p`).textContent, CHAT_COPY.zh.actions[action]);
    ui.management.refresh();
    for (const action of COMPANION_ACTIONS) assert.equal(ui.query(`[data-entry-id="${action}"] > p`).textContent, CHAT_COPY.zh.actions[action]);
    assert.equal(ui.query('[data-entry-id="literal"] > p').textContent, 'wave');
    ui.language('en'); assert.equal(ui.query('[data-entry-id="wave"] > p').textContent, CHAT_COPY.en.actions.wave);
  });

  it('bounds initial large history rows while retaining full expansion, edit, search and backup text', async (t) => {
    installChatIndexedDB(t);
    const text = `${'long message\n'.repeat(75_000)}needle-at-the-end`;
    const store = new BrowserProfileStore(`management-preview-${crypto.randomUUID()}`, false);
    const ui = await mount(t, { store }); const id = store.activeProfileId;
    // A valid archive may contain thirty 1M-character messages on its first page.
    const archive = JSON.parse(await store.backup());
    archive.profiles[0].entries = Array.from({ length: 30 }, (_, i) => ({ id: `large-${i}`, role: 'user', text, createdAt: i + 1 }));
    await store.restore(JSON.stringify(archive)); ui.management.refresh(); ui.tab('history');
    const rows = [...ui.root.querySelectorAll<HTMLElement>('.pc-record')]; assert.equal(rows.length, 30);
    assert.ok(rows.every((row) => row.querySelector('p')!.textContent!.length <= 4_001));
    assert.ok(ui.query('.pc-record-list').textContent!.length < 130_000, 'initial page mounts bounded previews rather than 30M characters');
    const row = rows[0]!; const expand = ui.click('Show full message', row);
    assert.equal(ui.query('p', row).textContent, text); assert.equal(expand.getAttribute('aria-expanded'), 'true');
    ui.language('zh'); assert.equal(expand.textContent, '显示消息预览');
    ui.management.refresh(); const restored = ui.query(`[data-entry-id="${row.dataset.entryId}"]`);
    assert.equal(ui.query('p', restored).textContent, text, 'explicit expansion survives refresh');
    ui.click('显示消息预览', restored); assert.ok(ui.query('p', restored).textContent!.length <= 4_001);
    ui.click('编辑', restored); assert.equal(ui.query<HTMLTextAreaElement>('textarea', restored).value, text);
    ui.click('取消', restored);
    ui.input(ui.query<HTMLInputElement>('input[type="search"]'), 'needle-at-the-end');
    assert.equal(ui.root.querySelectorAll('.pc-record').length, 30, 'search includes text beyond the preview');
    const exported = JSON.parse(await store.backup());
    assert.ok(exported.profiles.find((profile: { id: string }) => profile.id === store.activeProfileId).entries.every((entry: { text: string }) => entry.text === text));
    assert.equal(store.profileInfo(id)!.entryCount, 0, 'restoring the fixture keeps the original profile independent');
  });
});

describe('management list position and keyboard focus', () => {
  for (const kind of ['memory', 'history'] as const) {
    it(`retains the ${kind} filter and revealed rows when cancelling, saving and deleting after row 30`, async (t) => {
      installChatIndexedDB(t);
      let otherId = '';
      const ui = await mount(t, { seed: async (store) => {
        const id = store.activeProfileId;
        if (kind === 'memory') await store.importMemories(id, JSON.stringify({ format: 'peetty-memories', version: 1,
          memories: Array.from({ length: 70 }, (_, i) => memory(`m-${i}`, `${i < 65 ? 'match' : 'other'} fact ${i}`)) }));
        else await store.storage(id).saveEntries(Array.from({ length: 70 }, (_, i) => ({ id: `h-${i}`, role: 'user' as const, text: `${i < 65 ? 'match' : 'other'} message ${i}`, createdAt: i + 1 })));
        otherId = (await store.create({ name: 'Independent list state' })).id; await store.select(id);
      } });
      forbidSnapshots(t, ui.store);
      const supplied: number[] = [];
      if (kind === 'history') {
        const original = ui.store.historyPage.bind(ui.store);
        t.mock.method(ui.store, 'historyPage', (id: string, query: string, count: number) => { supplied.push(count); return original(id, query, count); });
      }
      ui.tab(kind);
      const search = ui.query<HTMLInputElement>('input[type="search"]'); ui.input(search, 'match');
      const first = ui.query('.pc-record'); const more = ui.click('Show more');
      const rows = () => [...ui.root.querySelectorAll<HTMLElement>('.pc-record')];
      assert.equal(rows().length, 60); assert.equal(rows()[0], first, 'show more keeps previously rendered record nodes');
      assert.equal(ui.root.activeElement?.closest('.pc-record'), rows()[30], 'keyboard focus moves to the first revealed row');
      const target = rows()[45]!; const targetId = target.dataset.memoryId ?? target.dataset.entryId;
      const nextId = rows()[46]!.dataset.memoryId ?? rows()[46]!.dataset.entryId;
      ui.click('Edit', target);
      const edit = ui.query<HTMLTextAreaElement>('textarea', target); edit.value = 'Unsaved match text';
      const cancel = [...target.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === 'Cancel')!; cancel.focus(); cancel.click();
      assert.equal(rows().length, 60); assert.equal(search.value, 'match'); assert.equal(ui.root.activeElement?.closest('.pc-record'), target);
      assert.ok(ui.root.activeElement?.classList.contains('pc-restored-focus'));
      ui.click('Edit', target); const savedEditor = ui.query<HTMLTextAreaElement>('textarea', target); savedEditor.value = 'match corrected later row'; savedEditor.focus(); savedEditor.form!.requestSubmit(); await flush();
      assert.match(target.textContent!, /corrected later row/); assert.equal(rows().length, 60); assert.equal(search.value, 'match');
      ui.click('Delete', target); const cancelDelete = [...target.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === 'Cancel')!;
      cancelDelete.focus(); cancelDelete.click(); assert.equal(rows().length, 60); assert.equal(search.value, 'match');
      ui.click('Delete', target); const yes = ui.query<HTMLButtonElement>('[data-action="confirm"]', target); assert.equal(ui.root.activeElement, yes); yes.click(); await flush();
      assert.equal(rows().length, 60); assert.equal(search.value, 'match');
      assert.equal(rows().some((row) => (row.dataset.memoryId ?? row.dataset.entryId) === targetId), false);
      const focused = ui.root.activeElement?.closest<HTMLElement>('.pc-record');
      assert.equal(focused?.dataset.memoryId ?? focused?.dataset.entryId, nextId, 'deletion focuses the next surviving row');
      assert.ok(ui.root.activeElement?.classList.contains('pc-restored-focus'));
      ui.input(search, 'match'); assert.equal(rows().length, 60, 'unchanged query keeps the revealed count');
      ui.tab('data'); ui.tab(kind);
      assert.equal(ui.query<HTMLInputElement>('input[type="search"]').value, 'match'); assert.equal(rows().length, 60, 'tab changes keep the profile list position');
      const firstId = ui.store.activeProfileId; await ui.select(otherId);
      assert.equal(ui.query<HTMLInputElement>('input[type="search"]').value, ''); assert.equal(rows().length, 0, 'another profile has independent list state');
      await ui.select(firstId); assert.equal(ui.query<HTMLInputElement>('input[type="search"]').value, 'match'); assert.equal(rows().length, 60);
      ui.input(ui.query<HTMLInputElement>('input[type="search"]'), 'other'); assert.equal(rows().length, 5);
      ui.input(ui.query<HTMLInputElement>('input[type="search"]'), 'match'); assert.equal(rows().length, 30, 'only a changed query resets pagination');
      if (kind === 'history') assert.ok(supplied.length > 0 && supplied.every((count) => count === 30 || count === 60), 'history asks for only the revealed page; the store owns lookahead');
      assert.equal(more.isConnected, false);
    });
  }
});

describe('management profile ownership', () => {
  it('saves only edited profile fields and preserves unrelated peer edits', async (t) => {
    installChatIndexedDB(t);
    const namespace = `management-peer-edit-${crypto.randomUUID()}`;
    const store = new BrowserProfileStore(namespace);
    const ui = await mount(t, { store }); const id = store.activeProfileId;
    const peer = new BrowserProfileStore(namespace); await peer.initialize(); t.after(() => peer.close());
    ui.tab('profile');
    const name = ui.query<HTMLInputElement>('[data-field="name"]'); name.value = 'My renamed profile';
    await peer.update(id, { figure: 'elsie', personality: 'Peer personality' });
    name.form!.requestSubmit(); await flush();
    assert.equal(store.profileInfo(id)!.name, 'My renamed profile');
    assert.equal(store.profileInfo(id)!.figure, 'elsie'); assert.equal(store.profileInfo(id)!.personality, 'Peer personality');
    assert.equal(ui.query<HTMLSelectElement>('[data-field="character"]').value, 'elsie');
    assert.equal(ui.query<HTMLTextAreaElement>('[data-field="personality"]').value, 'Peer personality');

    const personality = ui.query<HTMLTextAreaElement>('[data-field="personality"]'); personality.value = 'My edited personality';
    const character = ui.query<HTMLSelectElement>('[data-field="character"]'); character.value = 'miru'; character.value = 'elsie';
    await peer.update(id, { name: 'Peer renamed profile', figure: 'miru' });
    personality.form!.requestSubmit(); await flush();
    assert.equal(store.profileInfo(id)!.name, 'Peer renamed profile');
    assert.equal(store.profileInfo(id)!.figure, 'miru', 'reverted character input does not overwrite a peer edit');
    assert.equal(store.profileInfo(id)!.personality, 'My edited personality');
  });

  it('binds the committed selection despite a rejecting onSelect and rejects detached profile submissions', async (t) => {
    installChatIndexedDB(t);
    const gate = deferred<void>(); const busy: boolean[] = [];
    let firstId = ''; let secondId = '';
    const ui = await mount(t, { onSelect: () => gate.promise, onBusy: (value) => busy.push(value), seed: async (store) => {
      firstId = store.activeProfileId; secondId = (await store.create({ name: 'Second profile' })).id; await store.select(firstId);
    } });
    forbidSnapshots(t, ui.store); ui.tab('profile');
    const oldName = ui.query<HTMLInputElement>('[aria-label="Profile name"]'); oldName.value = 'Detached stale name';
    const oldForm = oldName.form!;
    const selector = ui.query<HTMLSelectElement>('.pc-profile-select'); selector.focus(); selector.value = secondId;
    selector.dispatchEvent(new ui.window.Event('change') as unknown as Event);
    assert.deepEqual(busy, [true], 'siblings are locked synchronously before selection awaits');
    await flush();
    assert.equal(ui.store.activeProfileId, secondId); assert.equal(selector.value, secondId);
    assert.equal(ui.query<HTMLInputElement>('[aria-label="Profile name"]').value, 'Second profile');
    assert.equal(ui.query<HTMLInputElement>('[aria-label="Profile name"]').disabled, true);
    oldForm.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    gate.reject(new Error('Figure failed to load')); await flush();
    assert.deepEqual(busy, [true, false]); assert.equal(ui.query<HTMLInputElement>('[aria-label="Profile name"]').disabled, false);
    assert.equal(ui.store.profileInfo(firstId)!.name, 'Original profile'); assert.equal(ui.store.profileInfo(secondId)!.name, 'Second profile');
    assert.match(ui.query('.pc-manage-status').textContent!, /Could not complete/); assert.equal(ui.root.activeElement, selector);
    oldForm.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event); await flush();
    assert.equal(ui.store.profileInfo(firstId)!.name, 'Original profile', 'detached A handlers cannot mutate A after B is selected');
    const current = ui.query<HTMLInputElement>('[aria-label="Profile name"]'); current.value = 'B saved'; current.form!.requestSubmit(); await flush();
    assert.equal(ui.store.profileInfo(secondId)!.name, 'B saved'); assert.equal(ui.store.profileInfo(firstId)!.name, 'Original profile');
  });

  it('rejects stale detached memory editors after a selection commits', async (t) => {
    installChatIndexedDB(t);
    let firstId = ''; let secondId = '';
    const ui = await mount(t, { onSelect: async () => { throw new Error('figure rejected'); }, seed: async (store) => {
      firstId = store.activeProfileId; await store.saveMemory(firstId, { text: 'Original A memory' });
      secondId = (await store.create({ name: 'B' })).id; await store.select(firstId);
    } });
    ui.tab('memory'); ui.click('Edit'); const oldEditor = ui.query<HTMLTextAreaElement>('[aria-label="Edit"]'); const oldForm = oldEditor.form!;
    await ui.select(secondId); oldEditor.value = 'Wrongly applied memory'; oldForm.dispatchEvent(new ui.window.Event('submit', { cancelable: true }) as unknown as Event); await flush();
    assert.equal(ui.store.memoryPage(firstId, '', 30).entries[0]!.text, 'Original A memory'); assert.equal(ui.store.profileInfo(secondId)!.memoryCount, 0);
    assert.equal(ui.root.querySelector('.pc-record'), null); assert.equal(ui.query<HTMLSelectElement>('.pc-profile-select').value, secondId);
  });

  it('shows committed history edits and deletion even when runtime reload rejects', async (t) => {
    installChatIndexedDB(t);
    const ui = await mount(t, { onReload: async () => { throw new Error('reload failed'); }, seed: async (store) => {
      await store.storage(store.activeProfileId).saveEntries([{ id: 'history', role: 'user', text: 'Original message', createdAt: 1 }]);
    } });
    ui.tab('history'); ui.click('Edit'); const editor = ui.query<HTMLTextAreaElement>('[aria-label="Edit"]'); editor.value = 'Committed edit'; editor.form!.requestSubmit(); await flush();
    assert.match(ui.query('.pc-record-list').textContent!, /Committed edit/); assert.equal(ui.root.querySelector('[aria-label="Edit"]'), null);
    ui.click('Delete'); ui.click('Confirm deletion'); await flush(); assert.equal(ui.root.querySelector('.pc-record'), null);
    assert.equal(ui.store.profileInfo(ui.store.activeProfileId)!.entryCount, 0); assert.match(ui.query('.pc-manage-status').textContent!, /Could not complete/);
  });

  it('refreshes committed create, remove and restore transitions even when onSelect rejects', async (t) => {
    installChatIndexedDB(t);
    const ui = await mount(t, { onSelect: async () => { throw new Error('unavailable custom figure'); } });
    ui.tab('profile'); const originalId = ui.store.activeProfileId;
    ui.query<HTMLInputElement>('[aria-label="New profile name"]').value = 'Committed new profile'; ui.query<HTMLFormElement>('.pc-new-profile').requestSubmit(); await flush();
    const createdId = ui.store.activeProfileId; assert.notEqual(createdId, originalId);
    assert.equal(ui.query<HTMLInputElement>('[aria-label="Profile name"]').value, 'Committed new profile');
    ui.click('Delete profile'); ui.click('Confirm deletion'); await flush();
    assert.equal(ui.store.activeProfileId, originalId); assert.equal(ui.query<HTMLInputElement>('[aria-label="Profile name"]').value, 'Original profile');
    assert.equal(ui.query<HTMLSelectElement>('.pc-profile-select').options.length, 1);
    const text = await ui.store.backup(); ui.tab('data');
    const restoreGroup = [...ui.root.querySelectorAll<HTMLElement>('.pc-row-actions')].find((node) => node.querySelector('button')?.textContent === 'Restore backup')!;
    const file = ui.query<HTMLInputElement>('input[type="file"]', restoreGroup);
    Object.defineProperty(file, 'files', { configurable: true, value: [new ui.window.File([text], 'backup.json', { type: 'application/json' })] });
    file.dispatchEvent(new ui.window.Event('change') as unknown as Event); await flush();
    assert.notEqual(ui.store.activeProfileId, originalId); assert.equal(ui.query<HTMLSelectElement>('.pc-profile-select').value, ui.store.activeProfileId);
    assert.equal(ui.query<HTMLSelectElement>('.pc-profile-select').options.length, 2);
    assert.match(ui.query('.pc-manage-status').textContent!, /Could not complete/);
  });

  it('releases the synchronous sibling lock exactly once on destroy during a pending operation', async (t) => {
    installChatIndexedDB(t);
    const gate = deferred<void>(); const busy: boolean[] = []; let secondId = '';
    const ui = await mount(t, { onSelect: () => gate.promise, onBusy: (value) => busy.push(value), seed: async (store) => {
      const first = store.activeProfileId; secondId = (await store.create({ name: 'Second' })).id; await store.select(first);
    } });
    await ui.select(secondId); assert.deepEqual(busy, [true]);
    ui.management.destroy(); assert.deepEqual(busy, [true, false]); gate.resolve(); await flush(); assert.deepEqual(busy, [true, false]);
  });
});

describe('management custom figures and authoritative exports', () => {
  for (const failure of ['none', 'selection', 'backup'] as const) {
    it(`reconciles runtime after a backup discovers a deleted profile (${failure})`, async (t) => {
      installChatIndexedDB(t);
      const namespace = `management-backup-fallback-${crypto.randomUUID()}`;
      const store = new BrowserProfileStore(namespace); const gate = deferred<void>();
      const busy: boolean[] = []; const adopted: string[] = []; let firstId = ''; let secondId = '';
      const ui = await mount(t, { store, onBusy: (value) => busy.push(value),
        onSelect: async () => { adopted.push(store.activeProfileId); await gate.promise; },
        seed: async () => {
          firstId = store.activeProfileId; secondId = (await store.create({ name: 'Surviving profile' })).id; await store.select(firstId);
        },
      });
      const peer = new BrowserProfileStore(namespace); await peer.initialize(); t.after(() => peer.close());
      const backup = store.backup.bind(store);
      if (failure === 'backup') t.mock.method(store, 'backup', async () => { await backup(); throw new Error('Backup serialization failed'); });
      t.mock.method(URL, 'createObjectURL', () => 'blob:fallback'); t.mock.method(URL, 'revokeObjectURL', () => {});
      ui.root.addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
      ui.tab('data');
      await peer.remove(firstId);
      assert.equal(store.activeProfileId, firstId, 'management still has the stale active selection before export');
      const trigger = ui.query<HTMLButtonElement>('[data-focus-key="backup"]'); trigger.focus(); trigger.click(); await flush();
      assert.equal(store.activeProfileId, secondId); assert.deepEqual(adopted, [secondId]);
      assert.equal(ui.query<HTMLSelectElement>('.pc-profile-select').value, secondId);
      assert.deepEqual(busy, [true], 'runtime reconciliation stays inside the original busy lock');
      assert.ok([...ui.root.querySelectorAll<HTMLInputElement>('button:not([data-cancel-download]),input,textarea,select')].every((node) => node.disabled));
      if (failure === 'selection') gate.reject(new Error('Runtime initialization failed')); else gate.resolve();
      await flush();
      assert.deepEqual(busy, [true, false]); assert.deepEqual(adopted, [secondId], 'runtime is reconciled exactly once');
      assert.equal(ui.query<HTMLSelectElement>('.pc-profile-select').disabled, false);
      assert.equal(ui.root.activeElement, ui.query('.pc-profile-select'), 'focus follows the committed fallback profile');
      assert.equal(ui.query('.pc-manage-status').hasAttribute('data-error'), failure !== 'none');
      ui.tab('profile'); assert.equal(ui.query<HTMLInputElement>('[data-field="name"]').value, 'Surviving profile');
    });
  }

  it('preserves an inline custom figure while saving unrelated fields or creating the same character', async (t) => {
    installChatIndexedDB(t);
    const figure: Figure = {
      format: 'peetty.figure', version: 1, id: 'custom-sprite', name: { en: 'Inline original', zh: '自定义原稿' }, renderer: 'sprite',
      viewBox: [0, 0, 32, 32], height: 64, anchor: [16, 32], palette: {},
      sprite: { image: 'https://figures.example/custom.png', frameWidth: 32, frameHeight: 32, columns: 1, animations: { idle: { frames: [0], fps: 1 } } },
    };
    const ui = await mount(t, { seed: (store) => store.update(store.activeProfileId, { figure }) });
    forbidSnapshots(t, ui.store); ui.tab('profile');
    const character = ui.query<HTMLSelectElement>('[aria-label="Character"]');
    assert.equal(character.selectedOptions[0]!.textContent, 'Custom character'); assert.equal(character.options.length, 7);
    ui.query<HTMLInputElement>('[aria-label="Profile name"]').value = 'Renamed custom'; character.form!.requestSubmit(); await flush();
    assert.deepEqual(ui.store.profileInfo(ui.store.activeProfileId)!.figure, figure);
    ui.language('zh'); assert.equal(ui.query<HTMLSelectElement>('[aria-label="角色"]').selectedOptions[0]!.textContent, '自定义角色');
    ui.query<HTMLInputElement>('[aria-label="新档案名称"]').value = 'Second same character'; ui.query<HTMLFormElement>('.pc-new-profile').requestSubmit(); await flush();
    assert.deepEqual(ui.store.profileInfo(ui.store.activeProfileId)!.figure, figure);
    ui.query<HTMLSelectElement>('[aria-label="角色"]').value = 'elsie'; ui.query<HTMLSelectElement>('[aria-label="角色"]').form!.requestSubmit(); await flush();
    assert.equal(ui.store.profileInfo(ui.store.activeProfileId)!.figure, 'elsie');
    const url = `https://figures.example/${'very-long-path/'.repeat(50)}custom.json`;
    await ui.store.update(ui.store.activeProfileId, { figure: url }); ui.management.refresh();
    const customURL = ui.query<HTMLSelectElement>('[aria-label="角色"]'); assert.equal(customURL.value, url); customURL.form!.requestSubmit(); await flush();
    assert.equal(ui.store.profileInfo(ui.store.activeProfileId)!.figure, url);
  });

  for (const cleanup of ['iframe', 'management', 'both'] as const) {
    it(`keeps C22 export URLs usable for 60 seconds then revokes them after ${cleanup} destruction`, async (t) => {
      installChatIndexedDB(t);
      const ui = await mount(t); ui.tab('data');
      const created: string[] = []; const revoked: string[] = [];
      const createObjectURL = URL.createObjectURL.bind(URL); const revokeObjectURL = URL.revokeObjectURL.bind(URL);
      t.mock.method(URL, 'createObjectURL', (blob: Blob) => { const url = createObjectURL(blob); created.push(url); return url; });
      t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); revokeObjectURL(url); });
      t.after(() => { for (const url of created) revokeObjectURL(url); });
      ui.root.addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      // A child realm's timers are canceled by iframe teardown; downloads must not use them.
      t.mock.method(ui.document.defaultView!, 'setTimeout', () => { throw new Error('Document timer cannot own export cleanup'); });
      ui.click('Download memory JSON'); await flush(); ui.click('Download memory Markdown'); await flush();
      assert.equal(created.length, 2); assert.deepEqual(revoked, []);
      const contents = await Promise.all(created.map(async (url) => (await fetch(url)).text()));
      if (cleanup !== 'iframe') ui.management.destroy();
      if (cleanup !== 'management') { await ui.window.happyDOM.abort(); ui.window.close(); }
      t.mock.timers.tick(59_999);
      assert.deepEqual(revoked, [], 'teardown must not shorten the download retention period');
      assert.deepEqual(await Promise.all(created.map(async (url) => (await fetch(url)).text())), contents, 'download URLs still serve their contents during retention');
      t.mock.timers.tick(1);
      assert.deepEqual(revoked, created, 'module timers revoke every URL after retention despite teardown');
      for (const url of created) await assert.rejects(fetch(url), 'revoked URLs no longer serve downloads');
      ui.management.destroy(); t.mock.timers.tick(60_000); assert.equal(revoked.length, 2, 'URLs are revoked only once');
    });
  }

  it('awaits authoritative JSON and Markdown memory exports, retaining keyboard focus and latest peer data', async (t) => {
    installChatIndexedDB(t);
    const namespace = `memory-export-${crypto.randomUUID()}`;
    const store = new BrowserProfileStore(namespace); await store.initialize({ name: 'Cached name' });
    const id = store.activeProfileId; await store.saveMemory(id, { text: 'Initial memory' });
    const peer = new BrowserProfileStore(namespace); await peer.initialize(); t.after(() => peer.close());
    const busy: boolean[] = []; const ui = await mount(t, { store, onBusy: (value) => busy.push(value) }); forbidSnapshots(t, store);
    const downloads: Blob[] = [];
    t.mock.method(URL, 'createObjectURL', (blob: Blob) => { downloads.push(blob); return 'blob:management-export'; }); t.mock.method(URL, 'revokeObjectURL', () => {});
    ui.root.addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    const jsonGate = deferred<void>(); const markdownGate = deferred<void>();
    const jsonExport = store.exportMemories.bind(store); const markdownExport = store.exportMemoryMarkdown.bind(store);
    t.mock.method(store, 'exportMemories', async (profileId: string) => { await jsonGate.promise; return jsonExport(profileId); });
    t.mock.method(store, 'exportMemoryMarkdown', async (profileId: string) => { await markdownGate.promise; return markdownExport(profileId); });
    ui.tab('data');
    const json = [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === 'Download memory JSON')!; json.focus(); json.click();
    assert.deepEqual(busy, [true]); assert.equal(downloads.length, 0);
    await peer.saveMemory(id, { text: 'Peer memory committed while export waited' }); jsonGate.resolve(); await flush();
    assert.equal(downloads.length, 1); assert.equal(ui.root.activeElement, json); assert.ok(json.classList.contains('pc-restored-focus'));
    const saved = JSON.parse(await downloads[0]!.text()) as { memories: { text: string }[] };
    assert.ok(saved.memories.some((entry) => entry.text === 'Peer memory committed while export waited'));
    const markdown = [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === 'Download memory Markdown')!; markdown.focus(); markdown.click();
    assert.equal(downloads.length, 1); assert.deepEqual(busy, [true, false, true]);
    await peer.update(id, { name: 'Latest peer name' }); await peer.saveMemory(id, { text: 'Latest Markdown fact' }); markdownGate.resolve(); await flush();
    assert.equal(downloads.length, 2); assert.equal(downloads[1]!.type, 'text/markdown');
    const markdownText = await downloads[1]!.text(); assert.match(markdownText, /Latest peer name/); assert.match(markdownText, /Latest Markdown fact/);
    assert.deepEqual(busy, [true, false, true, false]); assert.equal(ui.root.activeElement, markdown); assert.ok(markdown.classList.contains('pc-restored-focus'));
  });
});
