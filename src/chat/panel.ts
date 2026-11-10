import { abortable, ChatRuntime, fetchModelList, normalizeBaseUrl } from './runtime.ts';
import { isCredentialHeader, LOCAL_MAGPIE, localMagpieConnection, normalizeModelOptions, toStoredConnection } from './connections.ts';
import { SecretRegistry } from './secrets.ts';
import { PROFILE_LIMITS } from './limits.ts';
import type { ChatEntry, CompanionAction, PeettyChatOptions, PeettyModelOptions, PeettyReasoningEffort, SessionModel } from './types.ts';
import type { Language } from '../pet/i18n.ts';
import { COPY } from './copy.ts';
import { buildChatView, icon, setIcon } from './view.ts';
import { MARKDOWN_STYLE, renderMarkdown, renderMarkdownBubble } from './markdown.ts';
import { BrowserProfileStore } from './profiles.ts';
import { createManagement, MANAGEMENT_STYLE } from './management.ts';

import { imageColorById, type ImageColor } from '../figure/image-color.ts';
import { pageColor } from './page-color.ts';
import type { Portrait } from '../figure/portrait.ts';

const STYLE = `
.peetty-chat {
  --pc-color: #6a58e0; --pc-color-end: #9a4fd3; --pc-light: #b9afff;
  --pc-bg: color-mix(in srgb, var(--pc-color) 5%, #fff); --pc-input: #fff;
  --pc-ink: #2a2b47; --pc-muted: #636786; --pc-error: #b8203f;
  --pc-accent: color-mix(in srgb, var(--pc-color) 80%, #17172e);
  --pc-soft: color-mix(in srgb, var(--pc-color) 11%, #fff);
  --pc-line: color-mix(in srgb, var(--pc-color) 18%, #e9e9f0);
  --pc-line-strong: color-mix(in srgb, var(--pc-color) 35%, #9a9cb5);
  --pc-round: ui-rounded, 'Hiragino Maru Gothic ProN', 'Yuanti SC', system-ui, sans-serif;
  display: flex; flex-direction: column; width: 100%; height: 100%; box-sizing: border-box;
  background: var(--pc-bg); color: var(--pc-ink); border-radius: 22px;
  font: 400 14px/1.6 system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  overflow: hidden; isolation: isolate; text-align: left; color-scheme: light; pointer-events: auto;
  font-variant-numeric: tabular-nums;
}
.peetty-chat[data-color='pink'] { --pc-color: #d02f74; --pc-color-end: #b845b0; --pc-light: #ff9dc0; }
.peetty-chat[data-color='red'] { --pc-color: #d43545; --pc-color-end: #c8491f; --pc-light: #ffa0a3; }
.peetty-chat[data-color='orange'] { --pc-color: #bd5008; --pc-color-end: #a8650a; --pc-light: #ffb37c; }
.peetty-chat[data-color='green'] { --pc-color: #148049; --pc-color-end: #0d7f78; --pc-light: #7fdcaa; }
.peetty-chat[data-color='teal'] { --pc-color: #0c7f8f; --pc-color-end: #2a70c9; --pc-light: #72d6e2; }
.peetty-chat[data-color='blue'] { --pc-color: #2d6bd8; --pc-color-end: #5a5fdc; --pc-light: #9bbdff; }
.peetty-chat *, .peetty-chat *::before, .peetty-chat *::after { box-sizing: border-box; }
.peetty-chat[hidden], .peetty-chat [hidden] { display: none !important; }
.peetty-chat ::selection { background: var(--pc-color); color: #fff; }
.peetty-chat button, .peetty-chat input, .peetty-chat select, .peetty-chat textarea { font: inherit; }
.peetty-chat button { cursor: pointer; color: inherit; }
.peetty-chat button:disabled { cursor: default; opacity: .5; }
.peetty-chat :focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }
.pc-header { position: relative; display: flex; align-items: center; gap: 10px; padding: 22px 16px; flex-shrink: 0; isolation: isolate; overflow: hidden; background: linear-gradient(120deg, var(--pc-color), var(--pc-color-end)); color: #fff; }
.pc-header::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: radial-gradient(circle, rgb(255 255 255 / .18) 1px, transparent 1.5px) right top / 7px 7px; mask-image: linear-gradient(105deg, transparent 35%, #000); }
.pc-header::after { content: ''; position: absolute; width: 90px; height: 180px; right: 16px; top: -60px; transform: rotate(32deg); border-inline: 1px solid rgb(255 255 255 / .15); z-index: -1; pointer-events: none; }
.pc-avatar { width: 60px; height: 60px; flex-shrink: 0; overflow: hidden; border-radius: 50%; background: #f5f1ff; border: 3px solid #fff; color: var(--pc-color); display: grid; place-items: center; }
.pc-avatar > svg { width: 100%; height: 100%; }
.pc-avatar > svg:not(:has(use, defs)) { width: 28px; height: 28px; }
.pc-heading { flex: 1; min-width: 0; }
.pc-name { margin: 0 0 5px; font: 750 21px/1.2 var(--pc-round); letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-status { width: fit-content; max-width: 100%; padding: 3px 8px; border-radius: 20px; background: rgb(0 0 0 / .18); color: #fff; font-size: 10px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-icon { display: inline-grid; place-items: center; padding: 8px; min-width: 36px; min-height: 36px; border: 0; border-radius: 50%; background: transparent; flex-shrink: 0; transition: background-color .15s; }
.pc-header .pc-icon { background: rgb(0 0 0 / .12); }
.pc-header .pc-icon:hover { background: rgb(0 0 0 / .25); }
.pc-header :focus-visible { outline-color: #fff; outline-offset: 2px; }
.pc-content { flex: 1; overflow: auto; min-height: 0; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--pc-line-strong) transparent; }
.pc-setup { padding: 20px 22px 28px; }
.pc-setup h3 { margin: 0 0 6px; font: 750 21px/1.4 var(--pc-round); }
.pc-intro { margin: 0 0 22px; color: var(--pc-muted); font-size: 13px; }
.pc-local { margin-bottom: 22px; }
.pc-local > button { width: 100%; }
.pc-local .pc-note { margin: 8px 0 0; }
.pc-local code { font: inherit; color: var(--pc-ink); overflow-wrap: anywhere; }
.pc-field { display: block; margin: 0 0 16px; font-size: 12px; font-weight: 650; }
.pc-field > span { display: block; margin-bottom: 6px; }
.pc-input { width: 100%; min-height: 42px; padding: 10px 12px; background: var(--pc-input); color: var(--pc-ink); border: 1px solid var(--pc-line-strong); border-radius: 10px; caret-color: var(--pc-accent); font-size: 13px !important; transition: border-color .15s; }
.peetty-chat .pc-input, .peetty-chat .pc-key button { font-weight: 400; }
.pc-input:hover:not(:disabled) { border-color: var(--pc-accent); }
.pc-input:focus-visible { border-color: var(--pc-accent); outline-offset: 2px; }
.pc-input::placeholder { color: var(--pc-muted); opacity: 1; }
textarea.pc-input { line-height: 1.65; }
.pc-key { display: flex; gap: 6px; align-items: center; }
.pc-key input { flex: 1; min-width: 0; }
.pc-key button { white-space: nowrap; font-size: 12px !important; border: 1px solid var(--pc-line-strong); background: var(--pc-input); border-radius: 10px; min-height: 42px; padding: 0 10px; }
.pc-discover { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 16px; }
.pc-small { border: 1px solid var(--pc-line-strong); background: var(--pc-input); color: var(--pc-accent) !important; min-height: 36px; padding: 7px 14px; border-radius: 20px; font-size: 12px !important; font-weight: 600 !important; transition: background-color .15s, border-color .15s; }
.pc-small:hover:not(:disabled), .pc-key button:hover:not(:disabled) { background: var(--pc-soft); border-color: var(--pc-accent); }
.pc-link { border: 0; padding: 6px 0; background: none; color: var(--pc-accent) !important; font-size: 12px !important; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.pc-link:hover:not(:disabled) { text-decoration-thickness: 2px; }
.pc-check { display: flex; align-items: center; gap: 9px; font-size: 13px; margin: 16px 0 6px; }
.pc-check input { accent-color: var(--pc-color); margin: 0; width: 17px; height: 17px; }
.pc-note { color: var(--pc-muted); font-size: 12px; margin: 4px 0 16px; line-height: 1.65; }
.pc-primary { display: inline-flex; justify-content: center; align-items: center; gap: 8px; width: 100%; padding: 12px 16px; min-height: 44px; border: 0; border-radius: 24px; color: #fff !important; background: var(--pc-color); font-weight: 650 !important; transition: background-color .15s; }
.pc-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--pc-color) 85%, #17172e); }
.pc-primary svg { width: 17px; height: 17px; }
.pc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 290px; height: 100%; padding: 28px; text-align: center; }
.pc-hero { position: relative; width: 112px; height: 112px; margin-bottom: 22px; border-radius: 50%; background: var(--pc-soft); color: var(--pc-accent); }
.pc-hero::before, .pc-hero::after { content: ''; position: absolute; width: 18px; height: 18px; background: var(--pc-accent); clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); }
.pc-hero::before { left: -18px; top: 24px; width: 13px; height: 13px; }
.pc-hero::after { right: -13px; top: 2px; transform: rotate(15deg); }
.pc-hero > svg { width: 100%; height: 100%; border-radius: 50%; overflow: hidden; }
.pc-hero > svg:not(:has(use)) { padding: 32px; }
.pc-empty h3 { font: 750 23px/1.4 var(--pc-round); letter-spacing: -.02em; margin: 0 0 10px; }
.pc-empty p { max-width: 28ch; font-size: 13px; color: var(--pc-muted); margin: 0; line-height: 1.8; }
.pc-messages { padding: 22px 18px 4px; }
.pc-message { position: relative; margin: 0 0 20px; overflow-wrap: anywhere; min-width: 0; }
.pc-author { margin: 0 0 6px; color: var(--pc-muted); font-size: 11px; line-height: 1.4; font-weight: 650; }
.pc-text { white-space: pre-wrap; font-size: 14px; line-height: 1.75; padding: 12px 15px; border-radius: 4px 17px 17px; background: var(--pc-input); min-width: 0; }
.pc-message[data-role='assistant'] { padding-left: 38px; }
.pc-message-avatar { position: absolute; left: 0; top: 20px; width: 29px; height: 29px; border-radius: 50%; background: var(--pc-soft); color: var(--pc-accent); overflow: hidden; }
.pc-message-avatar > svg { width: 100%; height: 100%; }
.pc-message-avatar > svg:not(:has(use)) { padding: 7px; }
.pc-message[data-role='user'] { margin-left: 42px; display: flex; align-items: flex-end; flex-direction: column; }
.pc-message[data-role='user'] .pc-text { max-width: 100%; background: var(--pc-color); color: #fff; border-radius: 17px 4px 17px 17px; }
.pc-message[data-role='user'] .pc-author { text-align: right; }
.pc-message[data-role='action'] { color: var(--pc-muted); font-size: 12px; display: flex; gap: 6px; align-items: center; margin: -8px 0 20px 38px; }
.pc-message[data-role='action'] svg { width: 14px; height: 14px; color: var(--pc-accent); flex-shrink: 0; }
.pc-message[data-role='action'] .pc-text { font-size: 12px; line-height: 1.6; background: none; padding: 0; }
.pc-tools { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-height: 26px; padding: 0 20px 4px; color: var(--pc-muted); font-size: 12px; }
.pc-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.pc-composer { padding: 8px 16px 10px; background: var(--pc-bg); }
.pc-compose-row { display: flex; align-items: flex-end; gap: 6px; padding: 5px; border: 1px solid var(--pc-line-strong); border-radius: 26px; background: var(--pc-input); transition: border-color .15s; }
.pc-compose-row:focus-within { border-color: var(--pc-accent); outline: 1px solid var(--pc-accent); outline-offset: 2px; }
.pc-compose-row textarea { display: block; min-height: 40px; max-height: 126px; resize: none; border: 0; background: transparent; color: var(--pc-ink); padding: 9px 12px; flex: 1; min-width: 0; font-size: 14px; line-height: 1.6; caret-color: var(--pc-accent); }
.pc-compose-row textarea:focus-visible { outline: none; }
.pc-compose-row textarea::placeholder { color: var(--pc-muted); opacity: 1; }
.pc-submit { background: var(--pc-color); color: #fff !important; width: 40px; height: 40px; }
.pc-submit:hover:not(:disabled) { background: var(--pc-color-end); }
.pc-submit:disabled { background: var(--pc-soft); color: var(--pc-muted) !important; opacity: 1; }
.pc-foot { margin: 8px 0 0; color: var(--pc-muted); font-size: 10px; text-align: center; }
.pc-error { font-size: 12px; color: var(--pc-error); padding: 10px 18px; margin: 0; overflow-wrap: anywhere; background: color-mix(in srgb, var(--pc-error) 8%, var(--pc-input)); }
.pc-storage { font-size: 12px; color: var(--pc-ink); padding: 8px 18px; margin: 0; background: var(--pc-soft); }
.pc-sr { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
@media (prefers-color-scheme: dark) {
  .peetty-chat { --pc-bg: color-mix(in srgb, var(--pc-color) 7%, #131322); --pc-input: color-mix(in srgb, var(--pc-color) 10%, #1d1d31); --pc-ink: #eeedf7; --pc-muted: #a5a7c4; --pc-error: #ff9db0; --pc-accent: var(--pc-light); --pc-soft: color-mix(in srgb, var(--pc-color) 22%, #1a1a2d); --pc-line: color-mix(in srgb, var(--pc-color) 24%, #303044); --pc-line-strong: color-mix(in srgb, var(--pc-light) 38%, #4a4c6c); color-scheme: dark; }
}
.pc-mobile .pc-header { padding: 18px 12px; gap: 7px; }
.pc-mobile .pc-avatar { width: 48px; height: 48px; }
.pc-mobile .pc-name { font-size: 19px; }
.pc-mobile .pc-setup { padding-inline: 18px; }
.pc-mobile .pc-messages { padding-inline: 12px; }
.pc-mobile .pc-input, .pc-mobile .pc-compose-row textarea { font-size: 16px !important; }
.pc-mobile .pc-icon { min-width: 44px; min-height: 44px; }
@media (prefers-reduced-motion: no-preference) {
  .peetty-chat { animation: pc-enter .24s cubic-bezier(.16, 1, .3, 1); }
  @keyframes pc-enter { from { transform: translateY(8px); opacity: .7; } to { transform: none; opacity: 1; } }
}
`;

export interface ChatPanel {
  readonly isOpen: boolean;
  open: (settings?: boolean) => void;
  close: () => void;
  focus?: () => void;
  setModel: (model: PeettyModelOptions) => Promise<void>;
  setLanguage: (language: Language) => void;
  setFigure?: (figure: string | object, current?: () => boolean) => Promise<void>;
  destroy: () => void;
}
interface PanelOptions {
  root: ShadowRoot;
  language: Language;
  model?: PeettyModelOptions;
  chat?: PeettyChatOptions;
  onAction: (action: CompanionAction, signal?: AbortSignal) => string | void | Promise<string | void>;
  onReply: (text: string, render?: (target: HTMLElement) => void) => void;
  onState: (busy: boolean, speaking: boolean) => void;
  onClose: () => void;
  figure?: string | object;
  portrait?: (figure: string | object) => Promise<Portrait | null>;
  onFigure?: (figure: string | object) => Promise<void | boolean>;
  /** Invalidate SDK figure work before a profile runtime is replaced, even for identical figures. */
  onFigureOwnershipChange?: () => void;
}

export async function createChatPanel({
  root: parentRoot, language: initialLanguage, model: injectedModel, chat,
  figure: appliedFigure = 'miru', portrait: makePortrait, onFigure, onFigureOwnershipChange,
  onAction, onReply, onState, onClose,
}: PanelOptions): Promise<ChatPanel> {
  let language = initialLanguage;
  let t = COPY[language];
  let name = chat?.name?.trim() || t.companion;
  const parentDocument = parentRoot.ownerDocument;
  const parentWindow = parentDocument.defaultView!;
  const cleanups: (() => void)[] = [];
  const releaseResources = () => {
    for (const release of cleanups.splice(0).reverse()) { try { release(); } catch { /* Continue releasing the remaining resources. */ } }
  };
  try {
    const style = parentDocument.createElement('style');
    style.textContent = `
      .pc-frame { position: fixed; right: max(20px, env(safe-area-inset-right)); bottom: max(20px, env(safe-area-inset-bottom));
        width: min(390px, calc(100vw - 32px)); height: min(610px, calc(100dvh - 40px));
        border: 0; border-radius: 22px; box-shadow: 0 18px 54px rgb(30 24 65 / .24), 0 4px 12px rgb(30 24 65 / .1);
        display: block; pointer-events: auto; color-scheme: light dark; }
      .pc-frame[hidden] { display: none !important; }
      .pc-frame[data-releasing] { opacity: 0; pointer-events: none; }
      @media (max-width: 480px) { .pc-frame { right: 12px; bottom: max(12px, env(safe-area-inset-bottom));
        width: calc(100vw - 24px); height: min(610px, calc(100dvh - 24px)); } }
      ${MARKDOWN_STYLE}`;
    // The initial same-origin about:blank document requires no HTML string sinks.
    // This isolates event paths, not credentials, from a trusted same-origin host.
    const frame = parentDocument.createElement('iframe');
    frame.className = 'pc-frame';
    frame.title = t.chat;
    frame.lang = initialLanguage;
    frame.setAttribute('data-peetty', 'avoid');
    frame.hidden = true;
    cleanups.push(() => { frame.remove(); style.remove(); });
    parentRoot.append(style, frame);
    if (!frame.contentDocument) await new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    const document = frame.contentDocument!;
    document.documentElement.style.cssText = 'height:100%;overflow:hidden;background:transparent';
    document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:transparent';
    const host = document.createElement('div');
    host.style.cssText = 'display:block;height:100%';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const innerStyle = document.createElement('style');
    innerStyle.textContent = `${STYLE}\n${MANAGEMENT_STYLE}\n${MARKDOWN_STYLE}`;

    const panel = document.createElement('section');
    panel.className = 'peetty-chat';
    panel.setAttribute('data-peetty', 'avoid');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t.chat);
    panel.setAttribute('lang', initialLanguage);
    panel.hidden = true;
    const mobile = parentWindow.matchMedia('(max-width: 480px)');
    const resize = () => panel.classList.toggle('pc-mobile', mobile.matches);
    mobile.addEventListener('change', resize);
    cleanups.push(() => mobile.removeEventListener('change', resize));
    resize();
    const view = buildChatView(panel, () => t);
    const find = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
    const setup = find<HTMLFormElement>('.pc-setup');
    const composer = find<HTMLFormElement>('.pc-composer');
    const url = find<HTMLInputElement>('[name="url"]');
    const key = find<HTMLInputElement>('[name="key"]');
    const model = find<HTMLInputElement>('[name="model"]');
    const models = find<HTMLSelectElement>('.pc-models');
    const effort = find<HTMLSelectElement>('[name="effort"]');
    const tools = find<HTMLInputElement>('[name="tools"]');
    let keyEdited = false;
    let releaseEscapePress: ((restore?: boolean) => void) | undefined;
    let visible = false;
    let canceledTurn = false;
    let configuration = 0;
    const remember = find<HTMLInputElement>('[name="remember"]');
    // A host-supplied connection is ephemeral until the user opts in to saving its key.
    if (injectedModel) remember.checked = false;
    const input = find<HTMLTextAreaElement>('[name="message"]');
    const messages = find<HTMLDivElement>('.pc-messages');
    const content = find<HTMLDivElement>('.pc-content');
    const error = find<HTMLParagraphElement>('.pc-error');
    const settings = find<HTMLButtonElement>('.pc-settings');
    const submit = find<HTMLButtonElement>('.pc-submit');
    const clear = find<HTMLButtonElement>('.pc-clear');
    const confirmation = find<HTMLSpanElement>('.pc-confirm');
    const load = find<HTMLButtonElement>('.pc-load');
    const nodes = new Map<string, { element: HTMLElement; text: HTMLElement; author: HTMLElement; rendered: string | undefined }>();
    let settingsOpen = false;
    let disposed = false;
    let wasBusy = false;
    let discovery: AbortController | null = null;
    let returnFocus: HTMLElement | null = null;
    let shownError: (() => string) | undefined;
    let scheduled = false;
    find('.pc-name').textContent = name;
    find('.pc-magpie-origin').textContent = location.origin;

    const profiles = new BrowserProfileStore(chat?.storageKey ?? 'peetty', chat?.persist ?? true);
    cleanups.push(() => profiles.close());
    await profiles.initialize({
      name: name.slice(0, PROFILE_LIMITS.name), figure: appliedFigure ?? 'miru',
      ...(chat?.personality ? { personality: chat.personality.slice(0, PROFILE_LIMITS.personality) } : {}),
    });
    if (injectedModel || chat?.name || chat?.personality || appliedFigure && appliedFigure !== 'miru') await profiles.markBootstrapUsed();
    let currentProfileId = profiles.activeProfileId;
    const sessionModels = new Map<string, SessionModel>();
    const secretRegistries = new Map<string, SecretRegistry>();
    const activeBackups = new Set<AbortController>();
    cleanups.push(() => {
      for (const controller of activeBackups) controller.abort(); activeBackups.clear();
      sessionModels.clear(); for (const registry of secretRegistries.values()) registry.clear(); secretRegistries.clear();
    });
    if (injectedModel) sessionModels.set(currentProfileId, { model: injectedModel, rememberKey: false });
    let runtime!: ChatRuntime;
    cleanups.push(() => runtime?.destroy());
    let managementBusy = false;
    const modelChanges = new Set<number>();
    let formOwner: number | undefined;
    let figureFailure = false;
    let profileFigurePending = true;
    const setupLocked = () => managementBusy || modelChanges.size > 0;
    function syncSetupLock() {
      const locked = setupLocked();
      setup.inert = locked;
      setup.setAttribute('aria-busy', String(locked));
      find<HTMLButtonElement>('.pc-setup [type="submit"]').disabled = locked;
      if (runtime) render();
    }
    function ownsConnectionForm(): boolean {
      return !disposed && !setupLocked() && formOwner === configuration;
    }
    function makeRuntime(): ChatRuntime {
      const profileId = currentProfileId;
      const profile = profiles.profileInfo(profileId);
      if (!profile) throw new Error('Profile no longer exists.');
      let registry = secretRegistries.get(profileId);
      if (!registry) { registry = new SecretRegistry(); secretRegistries.set(profileId, registry); }
      const session = sessionModels.get(profileId);
      const rememberFact = async (text: string, sourceEntryId: string, signal?: AbortSignal) => {
        const source = instance.entries.find((entry) => entry.id === sourceEntryId);
        if (!source) throw new Error('The source message no longer exists.');
        await profiles.saveMemory(profileId, { text, sourceEntryId, sourceText: source.text, manual: false }, signal);
      };
      const instance: ChatRuntime = new ChatRuntime({
        ...(session ? { session } : {}),
        chat: { ...chat, persist: true, name: profile.name, personality: profile.personality },
        storage: profiles.runtimeStorage(profileId), secrets: registry,
        memory: {
          get entries() { return profiles.memoryTexts(profileId); },
          get enabled() { return profiles.memoryEnabled(profileId); },
          get remember() { return profiles.autoRememberEnabled(profileId) ? rememberFact : undefined; },
        },
        onAction: onAction,
        onChange: () => {
          if (runtime === instance && !scheduled && !disposed) {
            scheduled = true;
            queueMicrotask(() => { scheduled = false; render(); });
          }
        },
      });
      return instance;
    }
    function cacheSession() {
      const session = runtime.sessionOverride;
      if (session && profiles.listProfiles().some((profile) => profile.id === currentProfileId)) sessionModels.set(currentProfileId, { ...session, rememberKey: remember.checked });
      else sessionModels.delete(currentProfileId);
    }
    const sameFigure = (a: string | object, b: string | object) => a === b || typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
    async function applyProfileFigure(owner: ChatRuntime, profileId: string) {
      const figure = profiles.profileInfo(profileId)?.figure;
      if (figure === undefined) return;
      if (sameFigure(appliedFigure, figure)) { figureFailure = false; showError(); return; }
      try {
        const applied = await onFigure?.(figure);
        if (disposed || runtime !== owner || currentProfileId !== profileId || applied === false) return;
        appliedFigure = figure; figureFailure = false;
        portraitFigure = undefined; portraitToken = undefined;
        showError();
      } catch {
        if (!disposed && runtime === owner && currentProfileId === profileId) { figureFailure = true; showError(() => t.figureFailed); }
      }
    }
    runtime = makeRuntime();
    async function reloadProfile() {
      const previousId = currentProfileId;
      cacheSession();
      canceledTurn = true; wasBusy = false; configuration++;
      profileFigurePending = true;
      onFigureOwnershipChange?.();
      cancelDiscovery(); runtime.destroy();
      currentProfileId = profiles.activeProfileId;
      const nextRuntime = makeRuntime(); runtime = nextRuntime;
      if (previousId !== currentProfileId) { input.value = ''; input.style.height = ''; }
      confirmation.hidden = true;
      name = profiles.profileInfo(currentProfileId)?.name ?? t.companion;
      find('.pc-name').textContent = name;
      const liveIds = new Set(profiles.listProfiles().map((profile) => profile.id));
      for (const [id, registry] of secretRegistries) {
        if (!liveIds.has(id)) { registry.clear(); secretRegistries.delete(id); sessionModels.delete(id); }
      }
      await nextRuntime.initialize();
      if (disposed || runtime !== nextRuntime) return;
      remember.checked = runtime.rememberKey;
      fillSettings(); render();
      await applyProfileFigure(nextRuntime, currentProfileId);
      if (disposed || runtime !== nextRuntime) return;
      profileFigurePending = false;
      render();
    }
    async function backup(): Promise<string> {
      canceledTurn = true; runtime.stop(); cacheSession();
      const controller = new AbortController(); activeBackups.add(controller);
      const timer = setTimeout(() => controller.abort(), 20_000);
      const liveIds = new Set(profiles.listProfiles().map((profile) => profile.id));
      try {
        const sessions = await Promise.all([...sessionModels].filter(([id]) => liveIds.has(id)).map(async ([profileId, session]) => {
          const model = session.model;
          const apiKey = model.getApiKey ? await abortable(Promise.resolve().then(() => model.getApiKey!()), controller.signal) : model.apiKey;
          const resolvedKey = apiKey?.trim() || undefined;
          if (resolvedKey) secretRegistries.get(profileId)?.add(resolvedKey);
          const connection = toStoredConnection(model, resolvedKey);
          return { profileId, connection, rememberKey: session.rememberKey && !model.getApiKey };
        }));
        return await profiles.backup({ sessions });
      } finally { clearTimeout(timer); controller.abort(); activeBackups.delete(controller); }
    }
    const management = createManagement({
      document, store: profiles, language: () => language,
      onSelect: reloadProfile, onReload: reloadProfile, backup,
      onBusy: (busy) => { managementBusy = busy; syncSetupLock(); },
      onTab: (connection) => { setup.hidden = !connection; },
    });
    cleanups.push(() => management.destroy());
    content.insertBefore(management.element, setup);

    function updateError() {
      const text = shownError?.() ?? '';
      error.textContent = text;
      error.hidden = !text;
    }
    function showError(content?: () => string) { shownError = content ?? (figureFailure ? () => t.figureFailed : undefined); updateError(); }
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
      name = profiles.profileInfo(currentProfileId)?.name ?? t.companion;
      if (settingsOpen) management.translate();
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
      find<HTMLInputElement>('[name="provider"]').value = current?.provider ?? '';
      url.value = current?.baseUrl ?? '';
      key.value = current?.apiKey ?? '';
      keyEdited = false;
      key.type = 'password';
      find('.pc-show-key').textContent = t.show;
      key.placeholder = current?.getApiKey ? t.keyProvided : t.optional;
      model.value = current?.id ?? '';
      effort.value = current?.effort ?? '';
      tools.checked = current?.tools !== false;
      showManualModel();
      formOwner = configuration;
      updateLocalHint();
    }
    function setSettings(show: boolean) {
      const entering = show && !settingsOpen;
      settingsOpen = show;
      management.show(show);
      composer.hidden = show;
      find('.pc-tools').hidden = show;
      setIcon(settings, show ? 'back' : 'settings');
      settings.setAttribute('aria-label', show ? t.back : t.settings);
      settings.title = show ? t.back : t.settings;
      if (entering && !setupLocked()) fillSettings();
      render();
      if (visible && (entering || !show)) {
        if (show && !management.connectionVisible) management.focus();
        else (show ? url : input).focus();
      }
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
      if (entry.role === 'action') element.append(icon('spark', document), text);
      else {
        if (entry.role === 'assistant') {
          const face = document.createElement('div');
          face.className = 'pc-message-avatar';
          face.setAttribute('aria-hidden', 'true');
          stampPortrait(face); element.append(face);
        }
        element.append(author, text);
      }
      const item = { element, text, author, rendered: undefined as string | undefined };
      nodes.set(entry.id, item);
      return item;
    }
    let portrait: Portrait | null = null;
    let portraitFigure: string | object | undefined;
    let portraitToken: string | symbol | undefined;
    let portraitProfileId = '';
    let portraitRequest = 0;
    const avatar = find('.pc-avatar');
    const hero = find('.pc-hero');
    let hostColor: ImageColor | undefined;
    let colorTimer: ReturnType<typeof setTimeout> | undefined;
    function applyColor() {
      panel.dataset.color = hostColor ?? portrait?.color ?? imageColorById(typeof portraitFigure === 'string' ? portraitFigure : currentProfileId);
    }
    function refreshPageColor() {
      if (disposed || !visible) return;
      hostColor = pageColor(parentDocument);
      applyColor();
    }
    function schedulePageColor() {
      if (disposed || !visible || colorTimer !== undefined) return;
      colorTimer = setTimeout(() => { colorTimer = undefined; refreshPageColor(); }, 100);
    }
    const colorObserver = new parentWindow.MutationObserver(schedulePageColor);
    const themeAttributes = ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme'];
    colorObserver.observe(parentDocument.documentElement, { attributes: true, attributeFilter: themeAttributes });
    if (parentDocument.body) colorObserver.observe(parentDocument.body, { attributes: true, attributeFilter: themeAttributes });
    if (parentDocument.head) colorObserver.observe(parentDocument.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content', 'media', 'href', 'disabled'] });
    const colorScheme = parentWindow.matchMedia('(prefers-color-scheme: dark)');
    colorScheme.addEventListener('change', schedulePageColor);
    parentWindow.addEventListener('resize', schedulePageColor);
    cleanups.push(() => {
      colorObserver.disconnect(); clearTimeout(colorTimer);
      colorScheme.removeEventListener('change', schedulePageColor);
      parentWindow.removeEventListener('resize', schedulePageColor);
    });
    function stampPortrait(target: HTMLElement) {
      target.replaceChildren(portrait?.stamp() ?? icon('spark', document));
    }
    function syncPortrait() {
      if (profileFigurePending) return;
      const token = profiles.figureToken(currentProfileId);
      if (portraitProfileId === currentProfileId && portraitToken === token) return;
      portraitProfileId = currentProfileId; portraitToken = token;
      const figure = profiles.profileInfo(currentProfileId)?.figure ?? 'miru';
      if (portraitFigure !== undefined && sameFigure(portraitFigure, figure)) return;
      portraitFigure = figure;
      const request = ++portraitRequest;
      portrait?.destroy(); portrait = null;
      applyColor();
      avatar.replaceChildren(icon('spark', document));
      stampPortrait(hero);
      for (const node of messages.querySelectorAll<HTMLElement>('.pc-message-avatar')) stampPortrait(node);
      if (!makePortrait || figureFailure) return;
      void makePortrait(figure).then((next) => {
        if (disposed || request !== portraitRequest) { next?.destroy(); return; }
        portrait = next;
        if (next) { avatar.replaceChildren(next.element); applyColor(); }
        stampPortrait(hero);
        for (const node of messages.querySelectorAll<HTMLElement>('.pc-message-avatar')) stampPortrait(node);
        render();
      }).catch(() => { /* The pet reports figure errors; the panel keeps a decorative fallback. */ });
    }
    cleanups.push(() => { portraitRequest++; portrait?.destroy(); });
    function render() {
      if (disposed) return;
      syncPortrait();
      const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 90;
      const live = new Set(runtime.entries.map((entry) => entry.id));
      for (const [id, node] of nodes) if (!live.has(id)) { node.element.remove(); nodes.delete(id); }
      let cursor = messages.firstElementChild;
      for (const entry of runtime.entries) {
        const node = nodes.get(entry.id) ?? createEntry(entry);
        if (node.element !== cursor) messages.insertBefore(node.element, cursor);
        cursor = node.element.nextElementSibling;
        const text = entry.role === 'action' ? t.actions[entry.text as CompanionAction] ?? entry.text : entry.text;
        if (node.rendered !== text) {
          if (entry.role === 'assistant') renderMarkdown(node.text, text);
          else node.text.textContent = text;
          node.rendered = text;
        }
        const author = entry.role === 'user' ? t.you : name;
        if (node.author.textContent !== author) node.author.textContent = author;
      }
      messages.hidden = settingsOpen || !runtime.entries.length;
      find('.pc-empty').hidden = settingsOpen || !!runtime.entries.length;
      find('.pc-storage').hidden = !runtime.persistenceWarning && !profiles.persistenceWarning;
      panel.dataset.mode = settingsOpen ? 'settings' : 'chat';
      find('.pc-status').textContent = settingsOpen ? t.settings : runtime.model?.id ?? t.connectFirst;
      find('.pc-status').title = runtime.model?.baseUrl ?? '';
      find('.pc-activity').textContent = runtime.busy ? t.thinking : '';
      setIcon(submit, runtime.busy ? 'stop' : 'send');
      submit.setAttribute('aria-label', runtime.busy ? t.stop : t.send);
      submit.title = runtime.busy ? t.stop : t.send;
      submit.disabled = setupLocked() || currentProfileId !== profiles.activeProfileId || !runtime.busy && (!input.value.trim() || !runtime.model);
      clear.hidden = !runtime.entries.length || !confirmation.hidden;
      const last = runtime.reply;
      const speaking = runtime.busy && !!last?.text && runtime.entries[runtime.entries.length - 1]?.role === 'assistant';
      portrait?.setMood(runtime.busy ? speaking ? 'talk' : 'think' : 'calm');
      portrait?.setLive(visible);
      onState(runtime.busy, speaking);
      if (wasBusy && !runtime.busy) {
        const announce = visible && !canceledTurn && !runtime.error;
        find('.pc-announcement').textContent = announce ? last?.text ?? '' : '';
        if (runtime.error) showRuntimeError(runtime.error);
        else { showError(); if (announce && last?.text) onReply(last.text, target => renderMarkdownBubble(target, last.text)); }
      }
      wasBusy = runtime.busy;
      if (runtime.error && !shownError) showRuntimeError(runtime.error);
      if (nearBottom && !settingsOpen) content.scrollTop = content.scrollHeight;
    }
    function cancelDiscovery() { discovery?.abort(); discovery = null; load.disabled = false; load.textContent = t.load; }
    function sameEndpoint(): boolean {
      try { return normalizeBaseUrl(url.value) === runtime.model?.baseUrl; } catch { return false; }
    }
    function connectionAuth(baseUrl: string) {
      const current = runtime.model;
      const matching = current?.baseUrl === baseUrl ? current : undefined;
      const typedKey = key.value.trim();
      const replacement = keyEdited || typedKey !== (matching?.apiKey ?? '');
      const headers = matching?.headers ? { ...matching.headers } : undefined;
      if (replacement && headers) {
        for (const name of Object.keys(headers)) {
          if (isCredentialHeader(name)) delete headers[name];
        }
      }
      return { typedKey, headers, matching, getApiKey: !replacement ? matching?.getApiKey : undefined };
    }
    function showManualModel() { model.hidden = false; model.required = true; models.hidden = true; }
    function manualModel() { showManualModel(); model.focus(); }
    async function discover() {
      if (!ownsConnectionForm()) return;
      cancelDiscovery();
      const controller = new AbortController();
      discovery = controller;
      load.disabled = true;
      load.textContent = t.loading;
      showError();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const baseUrl = normalizeBaseUrl(url.value);
        const { typedKey, headers, getApiKey, matching } = connectionAuth(baseUrl);
        const apiKey = getApiKey
          ? await abortable(Promise.resolve().then(() => getApiKey.call(matching)), controller.signal)
          : typedKey || undefined;
        if (disposed || controller !== discovery || controller.signal.aborted) return;
        const list = await fetchModelList(baseUrl, apiKey, controller.signal, headers);
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
    url.addEventListener('input', () => { cancelDiscovery(); if (!sameEndpoint()) key.value = ''; showManualModel(); model.value = ''; updateLocalHint(); });
    find('.pc-magpie').addEventListener('click', () => {
      cancelDiscovery();
      const local = localMagpieConnection(runtime.model);
      url.value = local.baseUrl;
      key.value = local.apiKey ?? '';
      keyEdited = false;
      key.type = 'password';
      find('.pc-show-key').textContent = t.show;
      model.value = local.id;
      effort.value = local.effort ?? '';
      showManualModel();
      showError();
      updateLocalHint();
      // Magpie requires page authorization and a gateway key for browser clients.
      if (local.apiKey || local.getApiKey) void discover();
      else key.focus({ preventScroll: true });
    });
    key.addEventListener('input', () => { keyEdited = true; cancelDiscovery(); });
    find('.pc-show-key').addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; find('.pc-show-key').textContent = key.type === 'password' ? t.show : t.hide; });
    load.addEventListener('click', () => { void discover(); });
    find('.pc-manual').addEventListener('click', () => { cancelDiscovery(); manualModel(); });
    models.addEventListener('change', () => { model.value = models.value; });
    setup.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!ownsConnectionForm()) return;
      const owner = runtime;
      const ownerId = currentProfileId;
      const revision = ++configuration;
      formOwner = revision;
      void (async () => {
        try {
          const baseUrl = normalizeBaseUrl(url.value);
          const id = model.value.trim();
          if (!id) { showError(() => t.invalid); return; }
          const { typedKey, headers, getApiKey } = connectionAuth(baseUrl);
          cancelDiscovery();
          canceledTurn = true;
          await owner.configure({ baseUrl, id, provider: find<HTMLInputElement>('[name="provider"]').value, tools: tools.checked, ...(effort.value ? { effort: effort.value as PeettyReasoningEffort } : {}), ...(typedKey ? { apiKey: typedKey } : {}), ...(getApiKey ? { getApiKey } : {}), ...(headers ? { headers } : {}) }, remember.checked);
          if (disposed || revision !== configuration || runtime !== owner || currentProfileId !== ownerId) return;
          cacheSession();
          showError(); setSettings(false);
        } catch { if (!disposed && revision === configuration) showError(() => t.invalid); }
      })();
    });
    function send() {
      if (setupLocked() || currentProfileId !== profiles.activeProfileId) return;
      if (runtime.busy) { canceledTurn = true; runtime.stop(); return; }
      const text = input.value.trim();
      if (!text || !runtime.model) return;
      input.value = ''; input.style.height = '';
      showError();
      canceledTurn = false;
      find('.pc-announcement').textContent = '';
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
    function focusCurrent() {
      if (!visible || disposed) return;
      if (settingsOpen && !management.connectionVisible) { frame.focus(); management.focus(); return; }
      const form = settingsOpen ? setup : composer;
      const active = root.activeElement;
      const target = active && form.contains(active) ? active as HTMLElement : settingsOpen ? url : input;
      frame.focus();
      target.focus();
    }
    function restoreParentFocus() {
      if (returnFocus?.isConnected) returnFocus.focus();
    }
    function close(deferFocus = false) {
      releaseEscapePress?.(false);
      cancelDiscovery(); visible = false; canceledTurn = true;
      portrait?.setLive(false);
      find('.pc-announcement').textContent = '';
      runtime.stop();
      if (deferFocus) {
        // Keep the child browsing context focused through the consumed key's release.
        frame.setAttribute('data-releasing', '');
        const childWindow = document.defaultView!;
        const release = (restore = true) => {
          childWindow.removeEventListener('keyup', keyup, true);
          childWindow.removeEventListener('keydown', freshPress, true);
          childWindow.removeEventListener('blur', blur);
          parentWindow.removeEventListener('blur', blur);
          releaseEscapePress = undefined;
          frame.removeAttribute('data-releasing');
          frame.hidden = true;
          panel.hidden = true;
          if (restore && !disposed) restoreParentFocus();
        };
        const keyup = (event: KeyboardEvent) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); release(); }
        };
        const freshPress = (event: KeyboardEvent) => {
          if (!event.repeat) release();
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
        };
        const blur = () => release();
        childWindow.addEventListener('keyup', keyup, true);
        childWindow.addEventListener('keydown', freshPress, true);
        childWindow.addEventListener('blur', blur);
        parentWindow.addEventListener('blur', blur);
        releaseEscapePress = release;
      } else {
        panel.hidden = true; frame.hidden = true; restoreParentFocus();
      }
      onClose();
    }
    find('.pc-close').addEventListener('click', () => close());
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !visible) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    });
    root.append(innerStyle, panel);
    await runtime.initialize();
    remember.checked = runtime.rememberKey;
    cacheSession();
    await applyProfileFigure(runtime, currentProfileId);
    profileFigurePending = false;
    refreshCopy();
    return {
      get isOpen() { return visible; },
      open(showSettings = false) {
        if (disposed) return;
        const active = parentRoot.activeElement ?? parentDocument.activeElement;
        if (!visible && !releaseEscapePress && active instanceof parentWindow.HTMLElement && active !== frame) returnFocus = active;
        releaseEscapePress?.(false);
        const opening = !visible;
        visible = true; frame.hidden = false;
        panel.hidden = false;
        refreshPageColor();
        if (opening) frame.focus();
        showError();
        setSettings(showSettings || !runtime.model);
        if (opening) focusCurrent();
      },
      close: () => close(),
      focus: focusCurrent,
      async setFigure(figure, current = () => true) {
        if (disposed || !current()) return;
        const ownerId = currentProfileId;
        const savedFigure = profiles.profileInfo(ownerId)?.figure;
        if (savedFigure === undefined || !current()) return;
        // The SDK has already changed the artwork. Track that before storage yields,
        // so a profile switch cannot take a stale same-figure shortcut.
        appliedFigure = figure; figureFailure = false; showError();
        if (!sameFigure(savedFigure, figure)) await profiles.update(ownerId, { figure });
        if (!disposed && currentProfileId === ownerId && current()) {
          // The same URL may now resolve to different artwork after an SDK refresh.
          portraitFigure = undefined; portraitToken = undefined;
          render();
        }
      },
      setLanguage(nextLanguage) {
        if (disposed) return;
        if (nextLanguage !== 'en' && nextLanguage !== 'zh') throw new TypeError('Unsupported interface language.');
        language = nextLanguage;
        t = COPY[language];
        frame.title = t.chat;
        frame.lang = language;
        panel.setAttribute('lang', language);
        refreshCopy();
      },
      async setModel(next) {
        if (disposed) return;
        const chosen = normalizeModelOptions(next);
        const revision = ++configuration;
        const owner = runtime;
        const ownerId = currentProfileId;
        remember.checked = false;
        sessionModels.set(ownerId, { model: chosen, rememberKey: false });
        modelChanges.add(revision); syncSetupLock(); cancelDiscovery();
        try {
          const replacement = owner.setModel(chosen);
          if (!owner.busy) canceledTurn = true;
          await Promise.all([replacement, profiles.markBootstrapUsed(ownerId)]);
          if (!disposed && revision === configuration && runtime === owner && currentProfileId === ownerId) {
            remember.checked = false; cacheSession(); fillSettings(); showError(); setSettings(false);
          }
        } finally { modelChanges.delete(revision); syncSetupLock(); }
      },
      destroy() {
        if (disposed) return;
        const focused = parentRoot.activeElement === frame;
        disposed = true; configuration++;
        releaseEscapePress?.(false);
        if (focused) restoreParentFocus();
        visible = false; cancelDiscovery(); releaseResources();
      },
    };
  } catch (error) {
    releaseResources();
    throw error;
  }
}
