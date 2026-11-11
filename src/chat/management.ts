import type { Language } from '../pet/i18n.ts';
import { PRESET_IDS } from '../catalog.ts';
import type { BackupDownloadFile, BrowserProfileStore, MemoryEntry, ProfileInfo } from './profiles.ts';
import type { ChatEntry, CompanionAction } from './types.ts';
import { COPY as CHAT_COPY } from './copy.ts';
import { PROFILE_LIMITS } from './limits.ts';
import { ChatStorageError } from './store.ts';

const HISTORY_PREVIEW_CHARS = 4_000;

function scheduleDownloadRevocation(url: string): Promise<void> {
  // This module-realm timer retains the URL and completion signal, never the Blob,
  // serialized part or management view. Teardown must not shorten download availability.
  return new Promise(resolve => {
    const timer = setTimeout(() => { URL.revokeObjectURL(url); resolve(); }, 60_000);
    (timer as { unref?: () => void }).unref?.();
  });
}

function untilCanceled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new DOMException('Download canceled.', 'AbortError')); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

const COPY = {
  en: {
    profile: 'Profile', profiles: 'Profiles', memory: 'Memory', history: 'History', connection: 'Connection', data: 'Data',
    name: 'Profile name', character: 'Character', customCharacter: 'Custom character', personality: 'Personality and conversation style',
    create: 'Create profile', newName: 'New profile name', save: 'Save changes', removeProfile: 'Delete profile',
    isolation: 'Each profile has its own character, memories, history and model connection.',
    useMemory: 'Use saved memories in conversation', autoMemory: 'Let the model remember stable facts',
    autoHint: 'Automatic memory needs a model with tool calling and companion tools enabled. Only facts from your current message may be saved.',
    addMemory: 'Add memory', memoryText: 'What should your companion remember?', searchMemory: 'Search memories',
    memoryEmpty: 'No memories yet. Add something you want this companion to know.',
    searchHistory: 'Search conversation history', historyEmpty: 'No matching messages.',
    historyHint: 'Editing or deleting a message does not change its memories. Review linked memories separately.',
    showFull: 'Show full message', showPreview: 'Show message preview',
    sourceChanged: 'This message has changed. The original source is shown.',
    edit: 'Edit', remove: 'Delete', confirm: 'Confirm deletion', cancel: 'Cancel', source: 'Source message', sourceMissing: 'Source message is no longer in history.',
    manual: 'Added or edited by you', automatic: 'Remembered from chat', you: 'You', companion: 'Companion', action: 'Action', more: 'Show more',
    backupTitle: 'Backup and restore', backupHint: 'Download all profiles, characters, memories, conversations, providers and model settings. API keys are included in plain text; keep this file private.',
    backupWithoutCredentials: 'Download backup without credentials', backupWithoutCredentialsHint: 'Recovery option: keeps profiles, characters, memories, history and model settings, but omits API keys and authentication headers from all saved and session connections. Credential callbacks are not called. Reenter credentials after restore. Credentials typed into messages or memories are not removed.',
    backupFailed: 'Could not create the full backup. A credential callback may be unavailable or exceeded its 20-second deadline. Retry, or download a backup without credentials to recover your data.',
    restoreLimits: 'Each file must be 50 MiB or smaller. Backup parts are read sequentially; select every part together.',
    memorySaveFailed: 'Could not save this memory setting to browser storage. The checkbox shows the last saved setting. Export unsaved changes before reloading to restore storage access, then retry.',
    memoryReloadFailed: 'The memory setting was saved, but the conversation could not reload. The checkbox shows the saved setting. Retry the setting or reload the page to recover.',
    backup: 'Download full backup', multipartDownloaded: 'All backup parts are ready. Keep every part together. To restore, select all parts at once.',
    multipartWorking: 'Downloading backup parts. Allow multiple downloads and keep every part. Larger backups download up to two parts per minute. To restore, select all parts at once.',
    cancelDownload: 'Cancel remaining downloads', downloadCanceled: 'Backup download canceled. Previously downloaded parts are incomplete; start a new full backup to restore it.',
    legacyTitle: 'Previous-format data', legacyHint: 'Preserve pending work and upgrade pages running older Peetty releases before cleanup. Old clients stop saving; reloading a page pinned to an old version will not restore saving. This removes previous-format chat and key copies while keeping current profiles, conversations and connections.',
    clearLegacy: 'Delete previous-format copies', confirmLegacy: 'Permanently delete old chat and key copies', legacyCleared: 'Previous-format copies deleted. Current profiles are kept.',
    legacyFailed: 'Could not complete cleanup. Close other Peetty tabs, check browser storage, and try again.',
    privacyDeleteFailed: 'Could not delete this data from browser storage. Your data has been kept. Export unsaved changes before reloading to restore storage access, then retry.',
    profileDeleteFailed: 'Could not delete this profile from browser storage. Your profile has been kept. Export unsaved changes before reloading to restore storage access, then retry.',
    restore: 'Restore backup', restoreHint: 'Restore creates independent profiles and keeps your existing data. Select the backup file, or all files of a multipart backup together. Connections are used only after you start chatting.',
    memoryTitle: 'Import and export memory', memoryHint: 'Only the selected profile’s memories. Source messages, conversation history and API keys are omitted.',
    exportMemory: 'Download memory JSON', exportMarkdown: 'Download memory Markdown', importMemory: 'Import memory JSON',
    imported: 'Import complete.', saved: 'Changes saved.', downloaded: 'Download ready.', working: 'Working…', failed: 'Could not complete this operation. Check the file and try again.',
    lastProfile: 'Keep at least one profile.', required: 'Enter some text first.',
  },
  zh: {
    profile: '档案', profiles: '档案', memory: '记忆', history: '历史', connection: '模型连接', data: '数据',
    name: '档案名称', character: '角色', customCharacter: '自定义角色', personality: '性格与交流方式',
    create: '创建档案', newName: '新档案名称', save: '保存修改', removeProfile: '删除档案',
    isolation: '每份档案都有独立的角色、记忆、聊天历史和模型连接。',
    useMemory: '聊天时使用已有记忆', autoMemory: '允许模型记住长期有用的信息',
    autoHint: '自动记忆需要模型支持工具调用，并开启角色工具。只从当前消息记忆信息，不扫描旧聊天。',
    addMemory: '添加记忆', memoryText: '你希望伙伴记住什么？', searchMemory: '搜索记忆',
    memoryEmpty: '还没有记忆。可以添加你希望这位伙伴了解的事。',
    searchHistory: '搜索聊天历史', historyEmpty: '没有匹配的聊天记录。',
    historyHint: '修改或删除聊天不会自动修改关联记忆，请单独检查。',
    showFull: '显示完整消息', showPreview: '显示消息预览',
    sourceChanged: '这条消息已被修改，以下显示原始来源。',
    edit: '编辑', remove: '删除', confirm: '确认删除', cancel: '取消', source: '来源消息', sourceMissing: '来源消息已不在聊天历史中。',
    manual: '由你添加或修改', automatic: '从聊天中记住', you: '你', companion: '伙伴', action: '动作', more: '显示更多',
    backupTitle: '备份与恢复', backupHint: '下载全部档案、角色、记忆、聊天、Provider 和模型设置。文件包含明文 API Key，请妥善保管。',
    backupWithoutCredentials: '下载不含连接凭据的备份', backupWithoutCredentialsHint: '恢复选项：保留档案、角色、记忆、聊天和模型设置，但省略全部已保存及会话连接的 API Key 和认证请求头，不调用密钥回调。恢复后需重新输入凭据。不会移除你写在聊天或记忆中的凭据。',
    backupFailed: '完整备份未能完成。密钥回调可能不可用或已超过 20 秒期限。请重试，或下载不含连接凭据的备份来恢复数据。',
    restoreLimits: '单个文件不超过 50 MiB。备份分卷按顺序读取，请一次选中全部分卷。',
    memorySaveFailed: '记忆设置未能保存到浏览器存储。勾选框显示上次保存的设置，请先导出尚未保存的数据，再刷新页面恢复存储访问后重试。',
    memoryReloadFailed: '记忆设置已保存，但聊天未能重新加载。勾选框显示已保存的设置，请重试设置或刷新页面以恢复。',
    backup: '下载完整备份', multipartDownloaded: '全部备份分卷已准备下载。请保留全部分卷，恢复时一次选中所有分卷。',
    multipartWorking: '正在下载备份分卷。请允许浏览器下载多个文件并保留全部分卷。较大备份每分钟最多下载两个分卷。恢复时请一次选中所有分卷。',
    cancelDownload: '取消剩余下载', downloadCanceled: '备份下载已取消。此前下载的分卷不完整，请重新下载完整备份后再恢复。',
    legacyTitle: '旧格式数据', legacyHint: '清理前请先保留旧版 Peetty 网页中尚未保存的内容，并升级这些网页。旧版客户端将停止保存，刷新仍固定使用旧版的网页不能恢复保存功能。此操作删除旧格式聊天与密钥副本，当前档案、聊天和模型连接都会保留。',
    clearLegacy: '删除旧格式副本', confirmLegacy: '永久删除旧聊天与密钥副本', legacyCleared: '旧格式副本已删除，当前档案已保留。',
    legacyFailed: '暂时无法完成清理。请关闭其他 Peetty 标签页，并确认浏览器存储可用后重试。',
    privacyDeleteFailed: '暂时无法从浏览器存储删除数据。当前数据已保留，请先导出尚未保存的数据，再刷新页面恢复存储访问后重试。',
    profileDeleteFailed: '暂时无法从浏览器存储删除档案。当前档案已保留，请先导出尚未保存的数据，再刷新页面恢复存储访问后重试。',
    restore: '恢复备份', restoreHint: '恢复为独立的新档案，保留现有数据。请选择备份文件，分卷备份需一次选中全部文件。只有你开始聊天后才会使用恢复的连接。',
    memoryTitle: '导入与导出记忆', memoryHint: '只包含当前档案的记忆，不包含来源消息、聊天历史或 API Key。',
    exportMemory: '下载记忆 JSON', exportMarkdown: '下载记忆 Markdown', importMemory: '导入记忆 JSON',
    imported: '导入完成。', saved: '修改已保存。', downloaded: '已准备下载。', working: '正在处理…', failed: '操作未完成，请检查文件后重试。',
    lastProfile: '至少需要保留一份档案。', required: '请先填写内容。',
  },
} as const;

type CopyKey = keyof typeof COPY.en;
type Tab = 'profile' | 'memory' | 'history' | 'connection' | 'data';
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Disableable = Control | HTMLButtonElement;
interface Options {
  document: Document;
  store: BrowserProfileStore;
  language: () => Language;
  onSelect: () => Promise<void>;
  onReload: () => Promise<void>;
  onTab: (connection: boolean) => void;
  onBusy?: (busy: boolean) => void;
  backup: (signal?: AbortSignal, omitCredentials?: boolean) => Promise<string | AsyncIterable<BackupDownloadFile>>;
}
interface TextDraft {
  value: string;
  start: number | null;
  end: number | null;
  direction: 'forward' | 'backward' | 'none' | null;
  top: number;
  left: number;
}
interface ListState {
  query: string;
  count: number;
  editors: Map<string, TextDraft>;
  confirming: Set<string>;
  sources: Set<string>;
  expanded: Set<string>;
}
interface ViewState {
  fields: Map<string, TextDraft & { initial: string }>;
  memory: ListState;
  history: ListState;
  deleting: boolean;
}
const listState = (): ListState => ({ query: '', count: 30, editors: new Map(), confirming: new Set(), sources: new Set(), expanded: new Set() });

export const MANAGEMENT_STYLE = `
.pc-management { padding: 14px 20px 26px; }
.pc-profile-bar { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; }
.pc-profile-bar label { flex: 1; min-width: 0; display: block; }
.pc-profile-select { width: 100%; font-weight: 600 !important; }
.pc-tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--pc-line-strong) transparent; margin: 12px -6px 24px; padding: 4px 2px; }
.pc-tabs button { flex: 1 0 auto; border: 0; border-radius: 22px; background: transparent; min-height: 38px; padding: 8px 10px; font-size: 12px; color: var(--pc-muted) !important; white-space: nowrap; transition: color .15s, background-color .15s; }
.pc-tabs button:hover { background: var(--pc-soft); color: var(--pc-accent) !important; }
.pc-tabs button[aria-pressed='true'] { background: var(--pc-color); color: #fff !important; font-weight: 650; }
.pc-tabs button:focus-visible { outline-offset: -3px; }
.pc-manage-page h3 { margin: 0 0 4px; font-size: 17px; line-height: 1.4; font-weight: 650; letter-spacing: -.01em; }
.pc-manage-page > h3:is([data-i18n='profile'], [data-i18n='memory'], [data-i18n='history']) { position: absolute; width: 1px; height: 1px; margin: 0; clip-path: inset(50%); overflow: hidden; }
.pc-manage-page h4 { margin: 34px 0 4px; font-size: 14px; line-height: 1.4; font-weight: 650; }
.pc-manage-page > .pc-note:first-of-type { margin-bottom: 18px; }
.pc-manage-page textarea.pc-input { resize: vertical; min-height: 72px; }
.pc-manage-page textarea[data-field='personality'] { min-height: 120px; }
.pc-field:has(> input[type='search']) > span { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
.pc-field:has(> input[type='search']) { margin: 26px 0 10px; }
.pc-manage-page .pc-check { align-items: flex-start; }
.pc-manage-page .pc-check input { flex-shrink: 0; margin-top: 2px; }
.pc-manage-page form > .pc-primary, .pc-manage-page form > .pc-small { margin-top: 2px; }
.pc-manage-page .pc-backup { margin: 6px 0 4px; }
.pc-row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 8px 0; }
.pc-new-profile { margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--pc-line); }
.pc-record-list { margin-top: 4px; border-top: 1px solid var(--pc-line); }
.pc-record { padding: 13px 0 6px; border-bottom: 1px solid var(--pc-line); overflow-wrap: anywhere; }
.pc-record p { margin: 0 0 6px; white-space: pre-wrap; line-height: 1.7; }
.pc-record[data-entry-id] > p { color: var(--pc-ink); }
.pc-record[data-memory-id] { position: relative; padding-left: 24px; }
.pc-record[data-memory-id]::before { content: ''; position: absolute; left: 0; top: 20px; width: 12px; height: 12px; background: var(--pc-accent); clip-path: polygon(50% 0, 63% 37%, 100% 50%, 63% 63%, 50% 100%, 37% 63%, 0 50%, 37% 37%); }
.pc-record[data-memory-id] > p:first-child + .pc-note { margin-top: 6px; }
.pc-record .pc-note { margin: 0 0 4px; font-size: 11px; }
.pc-record .pc-row-actions { margin: 4px 0; }
.pc-record .pc-link:not(.pc-danger) { color: var(--pc-ink) !important; }
.pc-record details { margin: 8px 0; font-size: 12px; }
.pc-record summary { cursor: pointer; color: var(--pc-muted); width: fit-content; }
.pc-record summary:hover { color: var(--pc-ink); }
.pc-record details p { margin: 6px 0; padding-left: 10px; border-left: 1px solid var(--pc-line-strong); color: var(--pc-muted); }
.pc-record form .pc-field { margin-bottom: 6px; }
.pc-manage-status { margin: 14px 0 0; font-size: 12px; color: var(--pc-accent); overflow-wrap: anywhere; }
.pc-manage-status:empty { display: none; }
.pc-manage-status[data-error] { color: var(--pc-error); }
.pc-management .pc-restored-focus { outline: 2px solid var(--pc-accent); outline-offset: 2px; }
.pc-danger { color: var(--pc-error) !important; }
.pc-management:has([data-connection='true']) { padding-bottom: 0; }
.pc-management + .pc-setup { padding-top: 0; }
.pc-manage-empty { margin: 20px 0; color: var(--pc-muted); font-size: 13px; line-height: 1.6; }
.pc-mobile .pc-management { padding-inline: 18px; }
.pc-mobile .pc-tabs { gap: 2px; }
.pc-mobile .pc-tabs button { min-height: 44px; padding-inline: 7px; font-size: 11px !important; }
.pc-manage-page h3, .pc-manage-page h4 { font-family: var(--pc-round); }
`;

/** Settings use native controls and text nodes, including all imported content. */
export function createManagement(options: Options) {
  const { document, store } = options;
  const t = () => COPY[options.language()];
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const copy = <K extends keyof HTMLElementTagNameMap>(tag: K, key: CopyKey, cls = '') => {
    const node = el(tag, cls, t()[key]); node.dataset.i18n = key; return node;
  };
  const button = (key: CopyKey, cls = 'pc-small') => {
    const node = copy('button', key, cls); node.type = 'button'; return node;
  };
  const field = (key: CopyKey, input: HTMLElement) => {
    const label = el('label', 'pc-field'); label.append(copy('span', key), input); return label;
  };
  const textInput = (key: CopyKey, multiline = false) => {
    const node = multiline ? el('textarea', 'pc-input') : el('input', 'pc-input');
    node.dataset.i18nLabel = key; node.setAttribute('aria-label', t()[key]); return node;
  };
  const root = el('div', 'pc-management'); root.hidden = true;
  const bar = el('div', 'pc-profile-bar');
  const selector = el('select', 'pc-input pc-profile-select'); selector.dataset.focusKey = 'profile-selector';
  const selectorLabel = el('label'); selectorLabel.append(selector); bar.append(selectorLabel);
  const nav = el('nav', 'pc-tabs');
  const page = el('section', 'pc-manage-page');
  const status = el('p', 'pc-manage-status'); status.setAttribute('role', 'status');
  root.append(bar, nav, page, status);
  const views = new Map<string, ViewState>();
  const fieldBases = new WeakMap<Control, string>();
  const locked = new Map<Disableable, boolean>();
  let tab: Tab = 'connection';
  let boundProfileId = '';
  let visible = false;
  let busy = false;
  let destroyed = false;
  let activeDownload: AbortController | undefined;
  // Completion promises retain neither serialized parts nor Blobs, across canceled runs too.
  const downloadSlots: Promise<void>[] = [];

  function view(id: string): ViewState {
    let state = views.get(id);
    if (!state) {
      state = { fields: new Map(), memory: listState(), history: listState(), deleting: false };
      views.set(id, state);
    }
    return state;
  }
  function say(key?: CopyKey, error = false) {
    if (key) { status.dataset.i18n = key; status.textContent = t()[key]; }
    else { delete status.dataset.i18n; status.textContent = ''; }
    status.toggleAttribute('data-error', error);
  }
  function owns(id: string, origin: HTMLElement): boolean {
    return !destroyed && boundProfileId === id && store.activeProfileId === id && root.contains(origin) && origin.isConnected;
  }
  function requireOwner(id: string, origin: HTMLElement) {
    if (!owns(id, origin)) throw new Error('Profile view is no longer current.');
  }
  function textDraft(input: Control): TextDraft {
    const editable = input.tagName === 'SELECT' ? undefined : input as HTMLInputElement | HTMLTextAreaElement;
    return { value: input.value, start: editable?.selectionStart ?? null, end: editable?.selectionEnd ?? null,
      direction: editable?.selectionDirection ?? null, top: input.scrollTop, left: input.scrollLeft };
  }
  function restoreText(input: Control, draft: TextDraft, value = draft.value) {
    input.value = value;
    if (input.tagName !== 'SELECT' && draft.start !== null && draft.end !== null) {
      try { (input as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(draft.start, draft.end, draft.direction ?? undefined); }
      catch { /* Nontext input types do not support selection. */ }
    }
    input.scrollTop = draft.top; input.scrollLeft = draft.left;
  }
  function bindField(input: Control, key: string, initial: string, state: ViewState) {
    input.dataset.field = key; input.dataset.focusKey = key; fieldBases.set(input, initial);
    const draft = state.fields.get(key);
    if (draft) restoreText(input, draft, draft.value !== draft.initial ? draft.value : initial);
    else input.value = initial;
  }
  function captureDrafts() {
    if (!boundProfileId) return;
    const state = view(boundProfileId);
    for (const input of page.querySelectorAll<Control>('[data-field]')) {
      const key = input.dataset.field!;
      state.fields.set(key, { ...textDraft(input), initial: fieldBases.get(input) ?? '' });
    }
    for (const input of page.querySelectorAll<HTMLTextAreaElement>('[data-editor-id]')) {
      const list = input.dataset.editorKind === 'memory' ? state.memory : state.history;
      if (list.editors.has(input.dataset.editorId!)) list.editors.set(input.dataset.editorId!, textDraft(input));
    }
    for (const details of page.querySelectorAll<HTMLDetailsElement>('details[data-source-id]')) {
      if (details.open) state.memory.sources.add(details.dataset.sourceId!);
      else state.memory.sources.delete(details.dataset.sourceId!);
    }
  }
  function acceptFields(...inputs: Control[]) {
    for (const input of inputs) {
      fieldBases.set(input, input.value);
      view(boundProfileId).fields.delete(input.dataset.field!);
    }
  }
  function activeElement(): HTMLElement | null {
    return (root.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement | null;
  }
  function captureScroll() {
    const nodes = new Set<HTMLElement>();
    let node: HTMLElement | null = page;
    while (node) {
      nodes.add(node);
      node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host as HTMLElement | undefined) ?? null;
    }
    if (document.scrollingElement) nodes.add(document.scrollingElement as HTMLElement);
    return [...nodes].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
  }
  function restoreScroll(scroll: ReturnType<typeof captureScroll>) {
    for (const { node, top, left } of scroll) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
  }
  function captureFocus() {
    const active = activeElement();
    const record = active?.closest<HTMLElement>('.pc-record');
    const records = [...page.querySelectorAll<HTMLElement>('.pc-record')];
    const index = record ? records.indexOf(record) : -1;
    const identity = (node?: HTMLElement) => node?.dataset.memoryId ?? node?.dataset.entryId;
    return { active, profileId: boundProfileId, key: active?.dataset.focusKey, action: active?.dataset.action,
      ids: index < 0 ? [] : [identity(record ?? undefined), identity(records[index + 1]), identity(records[index - 1])].filter((id): id is string => !!id),
      scroll: captureScroll() };
  }
  function focusControl(target: HTMLElement) {
    target.focus({ preventScroll: true });
    target.classList.add('pc-restored-focus');
    target.addEventListener('blur', () => target.classList.remove('pc-restored-focus'), { once: true });
  }
  function restoreFocus(snapshot: ReturnType<typeof captureFocus>) {
    if (destroyed || root.hidden) return;
    const current = activeElement();
    if (current && root.contains(current) && current !== snapshot.active && !current.matches(':disabled')) return;
    let target: HTMLElement | undefined;
    if (snapshot.active && root.contains(snapshot.active) && snapshot.active.isConnected && !snapshot.active.matches(':disabled')) target = snapshot.active;
    if (!target && snapshot.profileId === boundProfileId) {
      if (snapshot.key) target = [...root.querySelectorAll<HTMLElement>('[data-focus-key]')].find((node) => node.dataset.focusKey === snapshot.key);
      if (!target) for (const id of snapshot.ids) {
        const record = [...page.querySelectorAll<HTMLElement>('.pc-record')].find((node) => (node.dataset.memoryId ?? node.dataset.entryId) === id);
        target = (snapshot.action ? [...record?.querySelectorAll<HTMLElement>('[data-action]') ?? []].find((node) => node.dataset.action === snapshot.action) : undefined)
          ?? record?.querySelector<HTMLElement>('textarea,input,button') ?? undefined;
        if (target) break;
      }
    }
    if (!target && snapshot.active && root.contains(snapshot.active)) target = selector;
    if (!target && snapshot.ids.length) target = page.querySelector<HTMLElement>('input[type="search"]') ?? selector;
    if (!target && snapshot.profileId !== boundProfileId) target = selector;
    if (target && !target.matches(':disabled')) focusControl(target);
    restoreScroll(snapshot.scroll);
  }
  function lockControls() {
    if (!busy) return;
    for (const control of root.querySelectorAll<Disableable>('button,input,select,textarea')) {
      if (control.hasAttribute('data-cancel-download')) continue;
      if (!locked.has(control)) locked.set(control, control.disabled);
      control.disabled = true;
    }
  }
  function releaseBusy() {
    if (!busy) return;
    busy = false;
    for (const [control, disabled] of locked) control.disabled = disabled;
    locked.clear();
    options.onBusy?.(false);
  }
  async function run(id: string, origin: HTMLElement, action: () => Promise<void>, success: CopyKey | (() => CopyKey) = 'saved', failure: CopyKey | (() => CopyKey) = 'failed') {
    if (busy || !owns(id, origin)) return;
    busy = true;
    options.onBusy?.(true);
    const focus = captureFocus();
    captureDrafts(); say('working'); lockControls();
    try { await action(); if (!destroyed) say(typeof success === 'function' ? success() : success); }
    catch (error) {
      if (!destroyed) say(error instanceof ChatStorageError && error.code === 'profile-delete' ? 'profileDeleteFailed'
        : error instanceof ChatStorageError && error.code === 'privacy-delete' ? 'privacyDeleteFailed'
        : error instanceof ChatStorageError && error.code === 'settings-save' ? 'memorySaveFailed'
        : error instanceof ChatStorageError && error.code === 'legacy-cleanup' ? 'legacyFailed' : typeof failure === 'function' ? failure() : failure, true);
    }
    finally {
      try {
        // Authoritative exports can discover that a peer deleted the selected profile.
        // Keep the sibling lock until the runtime adopts the store's fallback too.
        if (!destroyed && boundProfileId !== store.activeProfileId) await transition(async () => {});
      } catch { if (!destroyed) say('failed', true); }
      finally { releaseBusy(); restoreFocus(focus); }
    }
  }
  async function transition(action: () => Promise<unknown>) {
    try {
      await action();
      if (destroyed) return;
      refresh();
      await options.onSelect();
    } finally { if (!destroyed) refresh(); }
  }
  function refreshSelector() {
    const names = new Map<string, number>();
    selector.replaceChildren();
    for (const profile of store.listProfiles()) {
      const number = (names.get(profile.name) ?? 0) + 1;
      names.set(profile.name, number);
      const item = el('option', '', number > 1 ? `${profile.name} · ${number}` : profile.name);
      item.value = profile.id; selector.append(item);
    }
    selector.value = store.activeProfileId;
    selector.setAttribute('aria-label', t().profiles);
    nav.setAttribute('aria-label', t().profile);
  }
  selector.addEventListener('change', () => {
    const id = boundProfileId; const selected = selector.value;
    if (busy || !owns(id, selector)) { selector.value = store.activeProfileId; return; }
    void run(id, selector, () => transition(() => store.select(selected)));
  });
  function renderNav() {
    for (const key of ['profile', 'memory', 'history', 'connection', 'data'] as const) {
      let item = nav.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`);
      if (!item) {
        item = button(key); item.dataset.tab = key;
        item.addEventListener('click', () => {
          if (!busy && !destroyed) { captureDrafts(); tab = key; say(); renderNav(); renderPage(); }
        });
        nav.append(item);
      }
      item.textContent = t()[key];
      item.setAttribute('aria-pressed', String(tab === key));
    }
  }
  function renderProfile(info: ProfileInfo) {
    const { id: profileId, figure } = info;
    const state = view(profileId);
    const name = textInput('name'); name.maxLength = PROFILE_LIMITS.name; bindField(name, 'name', info.name, state);
    const character = el('select', 'pc-input'); character.dataset.i18nLabel = 'character'; character.setAttribute('aria-label', t().character);
    for (const id of PRESET_IDS) {
      const option = el('option', '', id[0]!.toUpperCase() + id.slice(1)); option.value = id; character.append(option);
    }
    const custom = '__peetty_custom_figure__';
    if (typeof figure === 'object') {
      const option = copy('option', 'customCharacter'); option.value = custom; character.append(option);
    } else if (!PRESET_IDS.some((id) => id === figure)) {
      const option = el('option', '', figure); option.value = figure; character.append(option);
    }
    bindField(character, 'character', typeof figure === 'string' ? figure : custom, state);
    const selectedFigure = () => character.value === custom && typeof figure === 'object' ? figure : character.value;
    const personality = textInput('personality', true); personality.maxLength = PROFILE_LIMITS.personality;
    bindField(personality, 'personality', info.personality, state);
    const form = el('form');
    const save = button('save', 'pc-primary'); save.type = 'submit'; save.dataset.focusKey = 'profile-save';
    form.append(field('name', name), field('character', character), field('personality', personality), save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!owns(profileId, form)) return;
      if (!name.value.trim()) { say('required', true); return; }
      const patch: Partial<Pick<ProfileInfo, 'name' | 'figure' | 'personality'>> = {};
      if (name.value !== fieldBases.get(name)) patch.name = name.value.trim();
      if (character.value !== fieldBases.get(character)) patch.figure = selectedFigure();
      if (personality.value !== fieldBases.get(personality)) patch.personality = personality.value;
      void run(profileId, form, async () => {
        await store.update(profileId, patch);
        acceptFields(name, character, personality);
        try { await options.onReload(); } finally { if (!destroyed) refresh(); }
      });
    });
    const deletion = el('div', 'pc-row-actions');
    function drawDeletion() {
      deletion.replaceChildren();
      if (state.deleting) {
        const yes = button('confirm', 'pc-link pc-danger'); const no = button('cancel', 'pc-link');
        yes.dataset.focusKey = 'profile-confirm'; no.dataset.focusKey = 'profile-cancel'; deletion.append(yes, no);
        yes.addEventListener('click', () => { void run(profileId, yes, () => transition(() => store.remove(profileId))); });
        no.addEventListener('click', () => {
          if (!owns(profileId, no) || busy) return;
          state.deleting = false; drawDeletion(); focusControl(deletion.querySelector('button')!);
        });
      } else {
        const remove = button('removeProfile', 'pc-link pc-danger'); remove.disabled = store.listProfiles().length <= 1;
        remove.dataset.focusKey = 'profile-remove'; deletion.append(remove);
        remove.addEventListener('click', () => {
          if (!owns(profileId, remove) || busy) return;
          state.deleting = true; drawDeletion(); focusControl(deletion.querySelector('button')!);
        });
      }
    }
    drawDeletion();
    const newSection = el('form', 'pc-new-profile');
    const newName = textInput('newName'); newName.maxLength = PROFILE_LIMITS.name; newName.required = true; bindField(newName, 'newName', '', state);
    const create = button('create'); create.type = 'submit'; create.dataset.focusKey = 'profile-create';
    newSection.append(field('newName', newName), create);
    newSection.addEventListener('submit', (event) => {
      event.preventDefault(); if (!owns(profileId, newSection) || !newName.value.trim()) return;
      const input = { name: newName.value.trim(), figure: selectedFigure() };
      void run(profileId, newSection, () => transition(async () => {
        await store.create(input); newName.value = ''; acceptFields(newName);
      }));
    });
    page.append(copy('h3', 'profile'), copy('p', 'isolation', 'pc-note'), form, deletion, newSection);
  }
  function dateNote(key: CopyKey, timestamp: number, dateOnly = false) {
    const note = el('div', 'pc-note'); const date = el('time');
    date.dataset.timestamp = String(timestamp); date.dataset.dateOnly = String(dateOnly);
    date.textContent = dateOnly ? new Date(timestamp).toLocaleDateString(options.language()) : new Date(timestamp).toLocaleString(options.language());
    note.append(copy('span', key), document.createTextNode(' · '), date); return note;
  }
  /** Reconcile just the revealed page: unchanged records and opened editors keep their DOM nodes. */
  function recordList<T extends MemoryEntry | ChatEntry>(profileId: string, kind: 'memory' | 'history', config: {
    limit: number;
    supply: (query: string, count: number) => { entries: T[]; hasMore: boolean };
    content: (record: HTMLElement, entry: T) => void;
    canEdit: (entry: T) => boolean;
    save: (id: string, text: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    onChange?: () => Promise<void>;
  }) {
    const state = view(profileId)[kind];
    const searchKey = kind === 'memory' ? 'searchMemory' : 'searchHistory';
    const search = textInput(searchKey); search.setAttribute('type', 'search'); search.dataset.i18nPlaceholder = searchKey;
    search.setAttribute('placeholder', t()[searchKey]); search.dataset.focusKey = `${kind}-search`; search.value = state.query;
    const list = el('div', 'pc-record-list');
    const rows = new WeakMap<HTMLElement, { entry: T; mode: string }>();
    const more = button('more'); more.dataset.focusKey = `${kind}-more`;
    more.addEventListener('click', () => {
      if (busy || !owns(profileId, more)) return;
      const previous = list.querySelectorAll('.pc-record').length;
      state.count += 30; draw();
      const target = list.querySelectorAll<HTMLElement>('.pc-record')[previous]?.querySelector<HTMLElement>('textarea,button');
      if (target) focusControl(target);
    });
    function renderRow(record: HTMLElement, entry: T) {
      const { id, text } = entry;
      record.replaceChildren();
      const draft = state.editors.get(id);
      if (draft) {
        const form = el('form'); const input = textInput('edit', true); input.maxLength = config.limit; input.required = true;
        input.dataset.editorId = id; input.dataset.editorKind = kind; input.dataset.focusKey = `${kind}-editor:${id}`; restoreText(input, draft);
        const actions = el('div', 'pc-row-actions'); const yes = button('save'); yes.type = 'submit'; yes.dataset.action = 'save';
        const no = button('cancel', 'pc-link'); no.dataset.action = 'cancel'; actions.append(yes, no); form.append(field('edit', input), actions); record.append(form);
        form.addEventListener('submit', (event) => {
          event.preventDefault(); if (!input.value.trim()) return;
          const value = input.value.trim();
          void run(profileId, form, async () => {
            await config.save(id, value); state.editors.delete(id); draw(); await config.onChange?.();
          });
        });
        no.addEventListener('click', () => {
          if (busy || !owns(profileId, no)) return;
          state.editors.delete(id); draw();
        });
        return;
      }
      config.content(record, entry);
      const actions = el('div', 'pc-row-actions'); record.append(actions);
      if (state.confirming.has(id)) {
        const yes = button('confirm', 'pc-link pc-danger'); const no = button('cancel', 'pc-link'); yes.dataset.action = 'confirm'; no.dataset.action = 'cancel'; actions.append(yes, no);
        yes.addEventListener('click', () => { void run(profileId, yes, async () => {
          await config.remove(id); state.confirming.delete(id); state.editors.delete(id); draw(); await config.onChange?.();
        }); });
        no.addEventListener('click', () => { if (busy || !owns(profileId, no)) return; state.confirming.delete(id); draw(); });
      } else {
        if (config.canEdit(entry)) {
          const edit = button('edit', 'pc-link'); edit.dataset.action = 'edit'; actions.append(edit);
          edit.addEventListener('click', () => {
            if (busy || !owns(profileId, edit)) return;
            state.editors.set(id, { value: text, start: text.length, end: text.length, direction: 'none', top: 0, left: 0 });
            draw(); const input = record.querySelector<HTMLTextAreaElement>('textarea'); if (input) focusControl(input);
          });
        }
        const remove = button('remove', 'pc-link pc-danger'); remove.dataset.action = 'remove'; actions.append(remove);
        remove.addEventListener('click', () => {
          if (busy || !owns(profileId, remove)) return;
          state.confirming.add(id); draw(); const yes = record.querySelector<HTMLElement>('[data-action="confirm"]'); if (yes) focusControl(yes);
        });
      }
    }
    function draw() {
      if (destroyed || boundProfileId !== profileId || store.activeProfileId !== profileId) return;
      const focus = captureFocus(); captureDrafts();
      // The store owns lookahead; the UI consumes exactly the requested page.
      const result = config.supply(state.query, state.count);
      const entries = result.entries;
      const existing = new Map([...list.querySelectorAll<HTMLElement>('.pc-record')].map((node) => [node.dataset.memoryId ?? node.dataset.entryId!, node]));
      let cursor = list.firstChild;
      for (const entry of entries) {
        const record = existing.get(entry.id) ?? el('article', 'pc-record'); existing.delete(entry.id);
        if (kind === 'memory') record.dataset.memoryId = entry.id; else record.dataset.entryId = entry.id;
        const mode = state.editors.has(entry.id) ? 'edit' : state.confirming.has(entry.id) ? 'confirm' : 'read';
        const old = rows.get(record);
        if (!old || old.mode !== mode || Object.keys({ ...old.entry, ...entry }).some((key) => entry[key as keyof T] !== old.entry[key as keyof T])) {
          renderRow(record, entry); rows.set(record, { entry, mode });
        }
        if (record !== cursor) list.insertBefore(record, cursor);
        cursor = record.nextSibling;
      }
      while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
      if (!entries.length) list.append(copy('p', kind === 'memory' ? 'memoryEmpty' : 'historyEmpty', 'pc-manage-empty'));
      if (result.hasMore) list.append(more);
      lockControls(); restoreFocus(focus);
    }
    search.addEventListener('input', () => {
      if (busy || !owns(profileId, search) || search.value === state.query) return;
      state.query = search.value; state.count = 30; draw();
    });
    return { search: field(searchKey, search), list, draw };
  }
  function renderMemory(info: ProfileInfo) {
    const profileId = info.id; const state = view(profileId);
    page.append(copy('h3', 'memory'));
    for (const key of ['useMemories', 'autoRemember'] as const) {
      const label = el('label', 'pc-check'); const check = el('input'); check.type = 'checkbox'; check.checked = info[key]; check.dataset.setting = key; check.dataset.focusKey = key;
      label.append(check, copy('span', key === 'useMemories' ? 'useMemory' : 'autoMemory')); page.append(label);
      check.addEventListener('change', () => {
        const checked = check.checked;
        if (busy || !owns(profileId, check)) { check.checked = store.profileInfo(profileId)?.[key] ?? info[key]; return; }
        let saved = false;
        void run(profileId, check, async () => {
          try {
            await store.update(profileId, { [key]: checked }); saved = true;
            await options.onReload();
          } finally {
            // A failed write can leave the previous setting authoritative; a failed
            // runtime reload can follow a successful write. Show the store in both cases.
            if (!destroyed) refresh();
          }
        }, 'saved', () => saved ? 'memoryReloadFailed' : 'memorySaveFailed');
      });
    }
    page.append(copy('p', 'autoHint', 'pc-note'));
    const form = el('form'); const input = textInput('memoryText', true); input.maxLength = PROFILE_LIMITS.memoryText; input.required = true; bindField(input, 'newMemory', '', state);
    const add = button('addMemory'); add.type = 'submit'; add.dataset.focusKey = 'memory-add'; form.append(field('memoryText', input), add);
    const records = recordList<MemoryEntry>(profileId, 'memory', {
      limit: PROFILE_LIMITS.memoryText, supply: (query, count) => store.memoryPage(profileId, query, count), canEdit: () => true,
      content(record, entry) {
        record.append(el('p', '', entry.text), dateNote(entry.manual ? 'manual' : 'automatic', entry.updatedAt, true));
        if (entry.sourceEntryId || entry.sourceText !== undefined) {
          const details = el('details'); details.dataset.sourceId = entry.id; details.open = state.memory.sources.has(entry.id);
          const summary = copy('summary', 'source'); summary.dataset.action = 'source'; details.append(summary);
          let loaded = false;
          function loadSource() {
            if (loaded || !details.open) return;
            loaded = true;
            const source = entry.sourceEntryId ? store.sourceText(profileId, entry.sourceEntryId) : undefined;
            if (entry.sourceText !== undefined && source !== undefined && entry.sourceText !== source) {
              details.append(copy('div', 'sourceChanged', 'pc-note'));
            }
            const original = entry.sourceText ?? source;
            if (original !== undefined) details.append(el('p', '', original));
            if (source === undefined) details.append(copy('div', 'sourceMissing', 'pc-note'));
          }
          details.addEventListener('toggle', () => { if (owns(profileId, details)) loadSource(); });
          loadSource(); // Restored expanded sources are visible immediately.
          record.append(details);
        }
      },
      save: (id, text) => store.saveMemory(profileId, { id, text, manual: true }),
      remove: (id) => store.removeMemory(profileId, id),
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (!input.value.trim()) return;
      const text = input.value;
      void run(profileId, form, async () => { await store.saveMemory(profileId, { text, manual: true }); input.value = ''; acceptFields(input); records.draw(); });
    });
    page.append(form, el('div', 'pc-row-actions'), records.search, records.list); records.draw();
  }
  function renderHistory(info: ProfileInfo) {
    const profileId = info.id;
    page.append(copy('h3', 'history'), copy('p', 'historyHint', 'pc-note'));
    const records = recordList<ChatEntry>(profileId, 'history', {
      limit: PROFILE_LIMITS.entryText, supply: (query, count) => store.historyPage(profileId, query, count), canEdit: (entry) => entry.role !== 'action',
      content(record, entry) {
        const body = el('p');
        record.append(dateNote(entry.role === 'user' ? 'you' : entry.role === 'action' ? 'action' : 'companion', entry.createdAt), body);
        const actions = CHAT_COPY[options.language()].actions;
        if (entry.role === 'action' && Object.hasOwn(actions, entry.text)) {
          body.dataset.historyAction = entry.text;
          body.textContent = actions[entry.text as CompanionAction];
          return;
        }
        const expanded = view(profileId).history.expanded;
        const long = entry.text.length > HISTORY_PREVIEW_CHARS;
        const expand = long ? button('showFull', 'pc-link') : undefined;
        function drawText() {
          const full = expanded.has(entry.id);
          body.textContent = long && !full ? `${entry.text.slice(0, HISTORY_PREVIEW_CHARS)}…` : entry.text;
          if (expand) {
            const key = full ? 'showPreview' : 'showFull';
            expand.dataset.i18n = key; expand.textContent = t()[key];
            expand.setAttribute('aria-expanded', String(full));
          }
        }
        drawText();
        if (expand) {
          expand.dataset.action = 'expand';
          expand.addEventListener('click', () => {
            if (busy || !owns(profileId, expand)) return;
            if (expanded.has(entry.id)) expanded.delete(entry.id); else expanded.add(entry.id);
            drawText();
          });
          record.append(expand);
        }
      },
      save: (id, text) => store.editEntry(profileId, id, text),
      remove: (id) => store.removeEntry(profileId, id),
      onChange: options.onReload,
    });
    page.append(records.search, records.list); records.draw();
  }
  function download(text: string, name: string, type = 'application/json'): Promise<void> {
    if (destroyed) return Promise.resolve();
    const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
    const released = scheduleDownloadRevocation(url);
    const link = el('a'); link.href = url; link.download = name; root.append(link);
    try { link.click(); } finally { link.remove(); }
    return released;
  }
  async function downloadParts(parts: AsyncIterable<BackupDownloadFile>, signal: AbortSignal) {
    const iterator = parts[Symbol.asyncIterator]();
    let returned = false;
    const close = () => {
      if (returned) return;
      returned = true;
      try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Cancellation still releases the UI. */ }
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      while (!signal.aborted) {
        // One bounded lookahead lets external producers without final metadata finish
        // immediately too. At most one serialized part waits behind the two live URLs.
        const next = await untilCanceled(iterator.next(), signal);
        if (signal.aborted) return;
        if (next.done) { returned = true; return; }
        if (downloadSlots.length >= 2) {
          await untilCanceled(downloadSlots[0]!, signal);
          downloadSlots.shift();
        }
        downloadSlots.push(download(next.value.text, next.value.name));
        // Core producers identify their last part without serializing this runtime flag.
        if (next.value.final) return;
      }
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  }
  function fileButton(profileId: string, key: CopyKey, action: (files: FileList, origin: HTMLInputElement) => Promise<void>, multiple = false) {
    const input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true; input.multiple = multiple;
    const trigger = button(key); trigger.dataset.focusKey = key; trigger.addEventListener('click', () => { if (!busy && owns(profileId, trigger)) input.click(); });
    input.addEventListener('change', () => {
      const selected = input.files;
      if (!selected?.length) { input.value = ''; return; }
      void run(profileId, input, async () => {
        // Keep the original FileList: the store validates and reads backup parts
        // sequentially without retaining every body or restricting valid archive totals.
        try { await action(selected, input); if (!destroyed) refresh(); }
        finally { input.value = ''; }
      }, 'imported');
    });
    const group = el('div', 'pc-row-actions'); group.append(trigger, input); return group;
  }
  function renderData(info: ProfileInfo) {
    const profileId = info.id;
    page.append(copy('h3', 'backupTitle'), copy('p', 'backupHint', 'pc-note'));
    const backup = button('backup', 'pc-primary'); backup.classList.add('pc-backup'); backup.dataset.focusKey = 'backup';
    const cancelDownload = button('cancelDownload'); cancelDownload.hidden = true; cancelDownload.dataset.cancelDownload = '';
    cancelDownload.addEventListener('click', () => activeDownload?.abort());
    const withoutCredentials = button('backupWithoutCredentials'); withoutCredentials.dataset.focusKey = 'backup-without-credentials';
    function startBackup(origin: HTMLButtonElement, omitCredentials = false) {
      let multipart = false;
      let canceled = false;
      void run(profileId, origin, async () => {
        const controller = new AbortController(); activeDownload = controller; cancelDownload.hidden = false;
        try {
          const pending = options.backup(controller.signal, omitCredentials);
          // Cancellation can precede snapshot creation. Close an eventual unused producer too.
          void pending.then(result => {
            if (controller.signal.aborted && typeof result !== 'string') {
              try { void Promise.resolve(result[Symbol.asyncIterator]().return?.()).catch(() => {}); } catch { /* Producer was never consumed. */ }
            }
          }, () => {});
          const result = await untilCanceled(pending, controller.signal);
          if (typeof result === 'string') download(result, `peetty-backup${omitCredentials ? '-without-credentials' : ''}-${new Date().toISOString().slice(0, 10)}.json`);
          else { multipart = true; say('multipartWorking'); await downloadParts(result, controller.signal); }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          canceled = true;
        } finally {
          canceled ||= controller.signal.aborted;
          if (activeDownload === controller) activeDownload = undefined;
          cancelDownload.hidden = true;
        }
      }, () => canceled ? 'downloadCanceled' : multipart ? 'multipartDownloaded' : 'downloaded', omitCredentials ? 'failed' : 'backupFailed');
    }
    backup.addEventListener('click', () => startBackup(backup));
    withoutCredentials.addEventListener('click', () => startBackup(withoutCredentials, true));
    page.append(backup, withoutCredentials, copy('p', 'backupWithoutCredentialsHint', 'pc-note'), cancelDownload,
      copy('p', 'restoreHint', 'pc-note'), copy('p', 'restoreLimits', 'pc-note'),
      fileButton(profileId, 'restore', (files) => transition(() => store.restoreFileSelection(files)), true));
    page.append(copy('h4', 'memoryTitle'), copy('p', 'memoryHint', 'pc-note'));
    const actions = el('div', 'pc-row-actions'); const json = button('exportMemory'); const markdown = button('exportMarkdown');
    json.dataset.focusKey = 'exportMemory'; markdown.dataset.focusKey = 'exportMarkdown';
    json.addEventListener('click', () => { void run(profileId, json, async () => { download(await store.exportMemories(profileId), 'peetty-memories.json'); }, 'downloaded'); });
    markdown.addEventListener('click', () => { void run(profileId, markdown, async () => { download(await store.exportMemoryMarkdown(profileId), 'peetty-memories.md', 'text/markdown'); }, 'downloaded'); });
    actions.append(json, markdown); page.append(actions, fileButton(profileId, 'importMemory', async (files, origin) => {
      const file = files[0]!;
      if (file.size > PROFILE_LIMITS.fileBytes) throw new Error('File too large.');
      const text = await file.text(); requireOwner(profileId, origin);
      await store.importMemories(profileId, text);
    }));
    page.append(copy('h4', 'legacyTitle'), copy('p', 'legacyHint', 'pc-note'));
    const clearLegacy = button('clearLegacy', 'pc-link pc-danger'); clearLegacy.dataset.focusKey = 'clear-legacy';
    const legacyConfirmation = el('div', 'pc-row-actions'); legacyConfirmation.hidden = true;
    const confirmLegacy = button('confirmLegacy', 'pc-small pc-danger'); confirmLegacy.dataset.focusKey = 'confirm-legacy';
    const cancelLegacy = button('cancel', 'pc-link'); cancelLegacy.dataset.focusKey = 'cancel-legacy';
    clearLegacy.addEventListener('click', () => {
      if (busy || !owns(profileId, clearLegacy)) return;
      clearLegacy.hidden = true; legacyConfirmation.hidden = false; confirmLegacy.focus();
    });
    cancelLegacy.addEventListener('click', () => {
      if (busy || !owns(profileId, cancelLegacy)) return;
      legacyConfirmation.hidden = true; clearLegacy.hidden = false; clearLegacy.focus();
    });
    confirmLegacy.addEventListener('click', () => {
      if (legacyConfirmation.hidden) return;
      void run(profileId, confirmLegacy, async () => {
        await store.clearLegacyData();
        legacyConfirmation.hidden = true; clearLegacy.hidden = false; clearLegacy.focus();
      }, 'legacyCleared', 'legacyFailed');
    });
    legacyConfirmation.append(confirmLegacy, cancelLegacy); page.append(clearLegacy, legacyConfirmation);
  }
  function renderPage() {
    page.replaceChildren(); page.dataset.connection = String(tab === 'connection');
    page.hidden = tab === 'connection'; options.onTab(visible && tab === 'connection');
    const info = store.profileInfo(boundProfileId);
    if (!info || destroyed) return;
    if (tab === 'profile') renderProfile(info);
    if (tab === 'memory') renderMemory(info);
    if (tab === 'history') renderHistory(info);
    if (tab === 'data') renderData(info);
    lockControls();
  }
  function refresh() {
    if (destroyed) return;
    const focus = captureFocus(); captureDrafts();
    boundProfileId = store.activeProfileId; root.dataset.profileId = boundProfileId;
    const ids = new Set(store.listProfiles().map((profile) => profile.id));
    for (const id of views.keys()) if (!ids.has(id)) views.delete(id);
    refreshSelector(); renderNav(); renderPage(); restoreFocus(focus);
  }
  function translate() {
    if (destroyed) return;
    const scroll = captureScroll();
    for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t()[node.dataset.i18n as CopyKey];
    for (const node of root.querySelectorAll<HTMLElement>('[data-history-action]')) {
      node.textContent = CHAT_COPY[options.language()].actions[node.dataset.historyAction as CompanionAction];
    }
    for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) node.setAttribute('aria-label', t()[node.dataset.i18nLabel as CopyKey]);
    for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) node.setAttribute('placeholder', t()[node.dataset.i18nPlaceholder as CopyKey]);
    for (const node of root.querySelectorAll<HTMLElement>('[data-timestamp]')) {
      const date = new Date(Number(node.dataset.timestamp));
      node.textContent = node.dataset.dateOnly === 'true' ? date.toLocaleDateString(options.language()) : date.toLocaleString(options.language());
    }
    selector.setAttribute('aria-label', t().profiles); nav.setAttribute('aria-label', t().profile);
    restoreScroll(scroll);
  }
  return {
    element: root,
    get connectionVisible() { return visible && tab === 'connection'; },
    show(show: boolean) { visible = show; root.hidden = !show; if (show) refresh(); else options.onTab(false); },
    refresh,
    translate,
    focus() { (page.querySelector<HTMLElement>('input,textarea,select,button') ?? selector).focus(); },
    destroy() {
      destroyed = true; activeDownload?.abort(); activeDownload = undefined; releaseBusy(); views.clear();
    },
  };
}
