import { abortable, ChatRuntime, fetchModelList, normalizeBaseUrl } from './runtime.ts';
import { LOCAL_MAGPIE, localMagpieConnection } from './connections.ts';
import type { ChatEntry, CompanionAction, PeettyChatOptions, PeettyModelOptions } from './types.ts';
import type { Language } from '../pet/i18n.ts';
import { COPY } from './copy.ts';
import { buildChatView, icon, setIcon } from './view.ts';

const STYLE = `
.peetty-chat {
  --pc-bg: #fffefa; --pc-ink: #302d40; --pc-muted: #6c6679; --pc-line: #e8e3ee;
  --pc-accent: #6753b8; --pc-soft: #f2edf9; --pc-input: #ffffff; --pc-error: #a33345;
  position: fixed; right: max(20px, env(safe-area-inset-right)); bottom: max(20px, env(safe-area-inset-bottom));
  width: min(390px, calc(100vw - 32px)); height: min(610px, calc(100dvh - 40px));
  display: flex; flex-direction: column; box-sizing: border-box; pointer-events: auto;
  background: var(--pc-bg); color: var(--pc-ink); border-radius: 16px;
  box-shadow: 0 12px 50px rgb(32 22 55 / .22), 0 2px 8px rgb(32 22 55 / .08);
  font: 400 14px/1.55 system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  overflow: hidden; isolation: isolate; text-align: left; color-scheme: light;
}
.peetty-chat *, .peetty-chat *::before, .peetty-chat *::after { box-sizing: border-box; }
.peetty-chat[hidden], .peetty-chat [hidden] { display: none !important; }
.peetty-chat ::selection { background: #dcd2f4; color: #302d40; }
.peetty-chat button, .peetty-chat input, .peetty-chat select, .peetty-chat textarea { font: inherit; }
.peetty-chat button { cursor: pointer; color: inherit; }
.peetty-chat button:disabled { cursor: default; opacity: .5; }
.peetty-chat :focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }
.pc-header { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid var(--pc-line); flex-shrink: 0; }
.pc-mark { width: 34px; height: 34px; background: var(--pc-soft); color: var(--pc-accent); display: grid; place-items: center; border-radius: 11px; }
.pc-heading { flex: 1; min-width: 0; }
.pc-name { margin: 0; font-size: 15px; font-weight: 650; line-height: 1.4; }
.pc-status { color: var(--pc-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 230px; }
.pc-icon { display: inline-grid; place-items: center; padding: 8px; min-width: 36px; min-height: 36px; border: 0; border-radius: 8px; background: transparent; flex-shrink: 0; }
.pc-icon:hover { background: var(--pc-soft); }
.pc-content { flex: 1; overflow: auto; min-height: 0; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--pc-line) transparent; }
.pc-setup { padding: 24px 22px; }
.pc-setup h3 { margin: 0 0 7px; font-size: 22px; line-height: 1.35; letter-spacing: -.025em; font-weight: 650; }
.pc-intro { margin: 0 0 22px; color: var(--pc-muted); font-size: 13px; }
.pc-local { margin-bottom: 18px; }
.pc-local > button { width: 100%; }
.pc-local .pc-note { margin: 10px 0 0; }
.pc-local code { font: inherit; color: var(--pc-ink); overflow-wrap: anywhere; }
.pc-field { display: block; margin: 0 0 15px; font-size: 12px; font-weight: 600; }
.pc-field > span { display: block; margin-bottom: 6px; }
.pc-input { width: 100%; min-height: 42px; padding: 10px 11px; background: var(--pc-input); color: var(--pc-ink); border: 1px solid var(--pc-line); border-radius: 8px; caret-color: var(--pc-accent); font-size: 13px !important; }
.pc-input::placeholder { color: var(--pc-muted); opacity: 1; }
.pc-key { display: flex; gap: 7px; align-items: center; }
.pc-key input { flex: 1; min-width: 0; }
.pc-key button { white-space: nowrap; font-size: 11px !important; border: 0; background: var(--pc-soft); border-radius: 7px; padding: 9px; }
.pc-discover { display: flex; align-items: center; gap: 12px; margin: 0 0 15px; }
.pc-small { border: 1px solid var(--pc-line); background: var(--pc-input); padding: 8px 12px; border-radius: 8px; font-size: 12px !important; }
.pc-link { border: 0; padding: 5px 0; background: none; color: var(--pc-accent) !important; font-size: 12px !important; text-decoration: underline; text-underline-offset: 3px; }
.pc-check { display: flex; align-items: center; gap: 7px; font-size: 12px; margin: 18px 0 5px; }
.pc-check input { accent-color: var(--pc-accent); margin: 0; width: 15px; height: 15px; }
.pc-note { color: var(--pc-muted); font-size: 11px; margin: 5px 0 16px; line-height: 1.55; }
.pc-primary { display: inline-flex; justify-content: center; align-items: center; gap: 8px; width: 100%; padding: 11px 15px; min-height: 43px; border: 0; border-radius: 9px; color: #fff !important; background: var(--pc-button, var(--pc-accent)); font-weight: 600 !important; }
.pc-primary:hover:not(:disabled) { filter: brightness(.94); }
.pc-empty { display: grid; align-content: center; height: 100%; min-height: 210px; padding: 30px; }
.pc-empty h3 { font-size: 24px; line-height: 1.3; letter-spacing: -.025em; font-weight: 600; margin: 0 0 12px; }
.pc-empty p { max-width: 30ch; font-size: 13px; color: var(--pc-muted); margin: 0; line-height: 1.8; }
.pc-messages { padding: 22px 20px 12px; }
.pc-message { margin: 0 0 21px; overflow-wrap: anywhere; }
.pc-message[data-role='user'] { padding: 11px 14px; margin-left: 30px; background: var(--pc-soft); border-radius: 12px 12px 3px 12px; }
.pc-message[data-role='action'] { color: var(--pc-muted); font-size: 11px; display: flex; gap: 7px; align-items: center; margin: -7px 0 18px; }
.pc-author { margin-bottom: 5px; color: var(--pc-muted); font-size: 10px; font-weight: 600; }
.pc-message[data-role='user'] .pc-author { display: none; }
.pc-text { white-space: pre-wrap; font-size: 14px; line-height: 1.75; }
.pc-tools { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 0 18px 9px; color: var(--pc-muted); font-size: 11px; }
.pc-confirm { display: flex; align-items: center; gap: 9px; }
.pc-composer { border-top: 1px solid var(--pc-line); padding: 12px 14px 10px; }
.pc-compose-row { display: flex; align-items: flex-end; gap: 9px; }
.pc-compose-row textarea { display: block; min-height: 42px; max-height: 126px; resize: none; border: 0; outline-offset: 0 !important; background: transparent; color: var(--pc-ink); padding: 9px 5px; flex: 1; min-width: 0; font-size: 14px; line-height: 1.5; caret-color: var(--pc-accent); }
.pc-compose-row textarea::placeholder { color: var(--pc-muted); opacity: 1; }
.pc-submit { background: var(--pc-button, var(--pc-accent)); color: white !important; border-radius: 10px; width: 39px; height: 39px; }
.pc-submit:hover { background: var(--pc-button, var(--pc-accent)); filter: brightness(.94); }
.pc-foot { margin: 7px 0 0; color: var(--pc-muted); font-size: 10px; text-align: center; }
.pc-error { font-size: 12px; color: var(--pc-error); padding: 12px 18px; margin: 0; overflow-wrap: anywhere; background: var(--pc-bg); }
.pc-storage { font-size: 11px; color: var(--pc-muted); padding: 9px 18px; margin: 0; border-bottom: 1px solid var(--pc-line); }
.pc-sr { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
@media (prefers-color-scheme: dark) {
  .peetty-chat { --pc-bg: #24212e; --pc-ink: #f0edf6; --pc-muted: #b8b0c6; --pc-line: #4a4259; --pc-accent: #bda9ef; --pc-button: #7055b4; --pc-soft: #393044; --pc-input: #2d2837; --pc-error: #ffacb9; color-scheme: dark; }
}
@media (max-width: 480px) {
  .peetty-chat { right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); width: calc(100vw - 24px); height: min(610px, calc(100dvh - 24px)); }
  .pc-header { padding: 12px 14px; } .pc-setup { padding: 22px 18px; } .pc-input, .pc-compose-row textarea { font-size: 16px !important; }
}
@media (prefers-reduced-motion: no-preference) {
  .peetty-chat { animation: pc-enter .2s cubic-bezier(.16, 1, .3, 1); }
  @keyframes pc-enter { from { transform: translateY(9px); opacity: .4; } to { transform: none; opacity: 1; } }
}
`;

export interface ChatPanel {
  readonly isOpen: boolean;
  open: (settings?: boolean) => void;
  close: () => void;
  setModel: (model: PeettyModelOptions) => Promise<void>;
  setLanguage: (language: Language) => void;
  destroy: () => void;
}
interface PanelOptions {
  root: ShadowRoot;
  language: Language;
  model?: PeettyModelOptions;
  chat?: PeettyChatOptions;
  onAction: (action: CompanionAction, signal?: AbortSignal) => string | void | Promise<string | void>;
  onReply: (text: string) => void;
  onState: (busy: boolean, speaking: boolean) => void;
  onClose: () => void;
}

export async function createChatPanel(options: PanelOptions): Promise<ChatPanel> {
  let t = COPY[options.language];
  let name = options.chat?.name ?? t.companion;
  const style = document.createElement('style');
  style.textContent = STYLE;
  const panel = document.createElement('section');
  panel.className = 'peetty-chat';
  panel.setAttribute('data-peetty', 'avoid');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t.chat);
  panel.setAttribute('lang', options.language);
  panel.hidden = true;
  const view = buildChatView(panel, () => t);
  const find = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const setup = find<HTMLFormElement>('.pc-setup');
  const composer = find<HTMLFormElement>('.pc-composer');
  const url = find<HTMLInputElement>('[name="url"]');
  const key = find<HTMLInputElement>('[name="key"]');
  const model = find<HTMLInputElement>('[name="model"]');
  const models = find<HTMLSelectElement>('.pc-models');
  const remember = find<HTMLInputElement>('[name="remember"]');
  // A host-supplied connection is ephemeral until the user opts in to saving its key.
  if (options.model) remember.checked = false;
  const input = find<HTMLTextAreaElement>('[name="message"]');
  const messages = find<HTMLDivElement>('.pc-messages');
  const content = find<HTMLDivElement>('.pc-content');
  const error = find<HTMLParagraphElement>('.pc-error');
  const settings = find<HTMLButtonElement>('.pc-settings');
  const submit = find<HTMLButtonElement>('.pc-submit');
  const clear = find<HTMLButtonElement>('.pc-clear');
  const confirmation = find<HTMLSpanElement>('.pc-confirm');
  const load = find<HTMLButtonElement>('.pc-load');
  const nodes = new Map<string, { element: HTMLElement; text: HTMLElement; author: HTMLElement }>();
  let settingsOpen = false;
  let disposed = false;
  let wasBusy = false;
  let discovery: AbortController | null = null;
  let returnFocus: HTMLElement | null = null;
  let shownError: (() => string) | undefined;
  let scheduled = false;
  find('.pc-name').textContent = name;
  find('.pc-magpie-origin').textContent = location.origin;

  const runtime = new ChatRuntime({
    ...(options.model ? { model: options.model } : {}),
    ...(options.chat ? { chat: options.chat } : {}),
    onAction: options.onAction,
    onChange: () => {
      if (!scheduled && !disposed) {
        scheduled = true;
        queueMicrotask(() => { scheduled = false; render(); });
      }
    },
  });

  function updateError() {
    const text = shownError?.() ?? '';
    error.textContent = text;
    error.hidden = !text;
  }
  function showError(content?: () => string) { shownError = content; updateError(); }
  function showRuntimeError(message: string) { showError(() => `${message}\n${t.network}`); }
  function isLocalMagpie(): boolean {
    try { return normalizeBaseUrl(url.value) === LOCAL_MAGPIE.baseUrl; } catch { return false; }
  }
  function updateLocalHint() {
    const local = isLocalMagpie();
    find('.pc-magpie-note').hidden = !local;
    find('.pc-key-label').textContent = local ? t.magpieKey : t.key;
    key.placeholder = sameEndpoint() && runtime.model?.getApiKey ? t.keyProvided : local ? t.magpieKey : t.optional;
  }
  function refreshCopy() {
    view.translate();
    name = options.chat?.name ?? t.companion;
    find('.pc-name').textContent = name;
    setIcon(settings, settingsOpen ? 'back' : 'settings');
    settings.setAttribute('aria-label', settingsOpen ? t.back : t.settings);
    settings.title = settingsOpen ? t.back : t.settings;
    find('.pc-show-key').textContent = key.type === 'password' ? t.show : t.hide;
    load.textContent = discovery ? t.loading : t.load;
    if (models.options[0]?.value === '') models.options[0].textContent = t.choose;
    updateLocalHint();
    updateError();
    render();
  }
  function fillSettings() {
    const current = runtime.model;
    url.value = current?.baseUrl ?? '';
    key.value = current?.apiKey ?? '';
    key.type = 'password';
    find('.pc-show-key').textContent = t.show;
    key.placeholder = current?.getApiKey ? t.keyProvided : t.optional;
    model.value = current?.id ?? '';
    model.hidden = false;
    model.required = true;
    models.hidden = true;
    updateLocalHint();
  }
  function setSettings(show: boolean) {
    settingsOpen = show;
    setup.hidden = !show;
    composer.hidden = show;
    find('.pc-tools').hidden = show;
    setIcon(settings, show ? 'back' : 'settings');
    settings.setAttribute('aria-label', show ? t.back : t.settings);
    settings.title = show ? t.back : t.settings;
    if (show) fillSettings();
    render();
    if (!panel.hidden) (show ? url : input).focus();
  }
  function createEntry(entry: ChatEntry) {
    const element = document.createElement('div');
    element.className = 'pc-message';
    element.dataset.role = entry.role;
    const author = document.createElement('div');
    author.className = 'pc-author';
    author.textContent = entry.role === 'user' ? t.you : name;
    const text = document.createElement('div');
    text.className = 'pc-text';
    if (entry.role === 'action') element.append(icon('spark'), text);
    else element.append(author, text);
    const item = { element, text, author };
    nodes.set(entry.id, item);
    return item;
  }
  function render() {
    if (disposed) return;
    const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 90;
    const live = new Set(runtime.entries.map((entry) => entry.id));
    for (const [id, node] of nodes) if (!live.has(id)) { node.element.remove(); nodes.delete(id); }
    let cursor = messages.firstElementChild;
    for (const entry of runtime.entries) {
      const node = nodes.get(entry.id) ?? createEntry(entry);
      if (node.element !== cursor) messages.insertBefore(node.element, cursor);
      cursor = node.element.nextElementSibling;
      const text = entry.role === 'action' ? t.actions[entry.text as CompanionAction] ?? entry.text : entry.text;
      if (node.text.textContent !== text) node.text.textContent = text;
      const author = entry.role === 'user' ? t.you : name;
      if (node.author.textContent !== author) node.author.textContent = author;
    }
    messages.hidden = settingsOpen || !runtime.entries.length;
    find('.pc-empty').hidden = settingsOpen || !!runtime.entries.length;
    find('.pc-storage').hidden = !runtime.persistenceWarning;
    find('.pc-status').textContent = settingsOpen ? t.settings : runtime.model?.id ?? t.connectFirst;
    find('.pc-status').title = runtime.model?.baseUrl ?? '';
    find('.pc-activity').textContent = runtime.busy ? t.thinking : '';
    setIcon(submit, runtime.busy ? 'stop' : 'send');
    submit.setAttribute('aria-label', runtime.busy ? t.stop : t.send);
    submit.title = runtime.busy ? t.stop : t.send;
    submit.disabled = !runtime.busy && (!input.value.trim() || !runtime.model);
    clear.hidden = !runtime.entries.length || !confirmation.hidden;
    const last = runtime.reply;
    const speaking = runtime.busy && !!last?.text && runtime.entries[runtime.entries.length - 1]?.role === 'assistant';
    options.onState(runtime.busy, speaking);
    if (wasBusy && !runtime.busy) {
      find('.pc-announcement').textContent = last?.text ?? '';
      if (runtime.error) showRuntimeError(runtime.error);
      else { showError(); if (last?.text) options.onReply(last.text); }
    }
    wasBusy = runtime.busy;
    if (runtime.error && !shownError) showRuntimeError(runtime.error);
    if (nearBottom && !settingsOpen) content.scrollTop = content.scrollHeight;
  }
  function cancelDiscovery() { discovery?.abort(); discovery = null; load.disabled = false; load.textContent = t.load; }
  function sameEndpoint(): boolean {
    try { return normalizeBaseUrl(url.value) === runtime.model?.baseUrl; } catch { return false; }
  }
  function manualModel() { model.hidden = false; model.required = true; models.hidden = true; model.focus(); }
  async function discover() {
    cancelDiscovery();
    const controller = new AbortController();
    discovery = controller;
    load.disabled = true;
    load.textContent = t.loading;
    showError();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const baseUrl = normalizeBaseUrl(url.value);
      const current = runtime.model;
      const matching = baseUrl === current?.baseUrl ? current : undefined;
      const typedKey = key.value.trim();
      const apiKey = typedKey || (matching?.getApiKey
        ? await abortable(Promise.resolve().then(() => matching.getApiKey!()), controller.signal)
        : undefined);
      if (disposed || controller !== discovery || controller.signal.aborted) return;
      const list = await fetchModelList(baseUrl, apiKey, controller.signal, matching?.headers);
      if (disposed || controller !== discovery || controller.signal.aborted) return;
      models.replaceChildren();
      const first = document.createElement('option');
      first.value = ''; first.textContent = t.choose;
      models.append(first);
      for (const item of list) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name === item.id ? item.id : `${item.name} · ${item.id}`; models.append(option); }
      if (!list.length) { manualModel(); showError(() => t.modelsEmpty); }
      else {
        model.hidden = true; model.required = false; models.hidden = false;
        models.value = list.some((item) => item.id === model.value) ? model.value : list.length === 1 ? list[0]!.id : '';
        model.value = models.value;
        models.focus();
      }
    } catch (error) {
      if (!disposed && discovery === controller) {
        manualModel();
        const auth = error instanceof Error && error.message === 'The endpoint rejected access. Check your API key.';
        const local = isLocalMagpie();
        showError(() => auth ? local ? t.magpieAuthFailed : t.authFailed : `${t.modelsFailed} ${t.network}`);
      }
    } finally {
      clearTimeout(timeout);
      if (discovery === controller) cancelDiscovery();
    }
  }
  url.addEventListener('input', () => { cancelDiscovery(); if (!sameEndpoint()) key.value = ''; model.hidden = false; model.required = true; models.hidden = true; model.value = ''; updateLocalHint(); });
  find('.pc-magpie').addEventListener('click', () => {
    cancelDiscovery();
    const local = localMagpieConnection(runtime.model);
    url.value = local.baseUrl;
    key.value = local.apiKey ?? '';
    key.type = 'password';
    find('.pc-show-key').textContent = t.show;
    model.value = local.id;
    model.hidden = false;
    model.required = true;
    models.hidden = true;
    showError();
    updateLocalHint();
    // Magpie requires page authorization and a gateway key for browser clients.
    if (local.apiKey || local.getApiKey) void discover();
    else key.focus({ preventScroll: true });
  });
  key.addEventListener('input', cancelDiscovery);
  find('.pc-show-key').addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; find('.pc-show-key').textContent = key.type === 'password' ? t.show : t.hide; });
  load.addEventListener('click', () => { void discover(); });
  find('.pc-manual').addEventListener('click', () => { cancelDiscovery(); manualModel(); });
  models.addEventListener('change', () => { model.value = models.value; });
  setup.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      try {
        const baseUrl = normalizeBaseUrl(url.value);
        const id = model.value.trim();
        if (!id) { showError(() => t.invalid); return; }
        const current = runtime.model;
        const getApiKey = !key.value.trim() && sameEndpoint() ? current?.getApiKey : undefined;
        const headers = sameEndpoint() ? current?.headers : undefined;
        cancelDiscovery();
        await runtime.configure({ baseUrl, id, ...(key.value.trim() ? { apiKey: key.value.trim() } : {}), ...(getApiKey ? { getApiKey } : {}), ...(headers ? { headers } : {}) }, remember.checked);
        if (disposed) return;
        showError(); setSettings(false);
      } catch { if (!disposed) showError(() => t.invalid); }
    })();
  });
  function send() {
    if (runtime.busy) { runtime.stop(); return; }
    const text = input.value.trim();
    if (!text || !runtime.model) return;
    input.value = ''; input.style.height = '';
    showError();
    void runtime.send(text);
    render(); content.scrollTop = content.scrollHeight; input.focus();
  }
  composer.addEventListener('submit', (event) => { event.preventDefault(); send(); });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(126, input.scrollHeight)}px`; render(); });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!runtime.busy) send(); } });
  clear.addEventListener('click', () => { confirmation.hidden = false; clear.hidden = true; });
  find('.pc-cancel').addEventListener('click', () => { confirmation.hidden = true; render(); });
  find('.pc-clear-now').addEventListener('click', () => { confirmation.hidden = true; showError(); void runtime.clear().then(render); });
  settings.addEventListener('click', () => { showError(); cancelDiscovery(); setSettings(!settingsOpen || !runtime.model); });
  const close = () => {
    cancelDiscovery(); panel.hidden = true; runtime.stop(); options.onClose();
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  find('.pc-close').addEventListener('click', close);
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  // Keep composer key events out of the host site's keyboard shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }
  options.root.append(style, panel);
  try { await runtime.initialize(); }
  catch (error) { runtime.destroy(); panel.remove(); style.remove(); throw error; }
  if (disposed) return { isOpen: false, open() {}, close() {}, async setModel() {}, setLanguage() {}, destroy() {} };
  refreshCopy();
  return {
    get isOpen() { return !panel.hidden; },
    open(showSettings = false) {
      const active = options.root.activeElement ?? document.activeElement;
      if (panel.hidden && active instanceof HTMLElement && !panel.contains(active)) returnFocus = active;
      panel.hidden = false;
      showError();
      setSettings(showSettings || !runtime.model);
    },
    close,
    setLanguage(language) {
      if (disposed) return;
      if (language !== 'en' && language !== 'zh') throw new TypeError('Unsupported interface language.');
      t = COPY[language];
      panel.setAttribute('lang', language);
      refreshCopy();
    },
    async setModel(next) {
      cancelDiscovery();
      await runtime.setModel(next);
      if (!disposed) { remember.checked = false; showError(); setSettings(false); }
    },
    destroy() { disposed = true; cancelDiscovery(); runtime.destroy(); panel.remove(); style.remove(); },
  };
}
