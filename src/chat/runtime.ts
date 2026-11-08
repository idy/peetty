import type { Agent, AgentEvent, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Message, Model, Usage } from '@earendil-works/pi-ai';
import { boundedEntries, BrowserChatStore } from './store.ts';
import { normalizeBaseUrl, normalizeModelOptions as modelOptions } from './connections.ts';
export { normalizeBaseUrl } from './connections.ts';
import type { ChatStorage, StoredConnection } from './store.ts';
import type { ChatEntry, CompanionAction, ModelChoice, PeettyChatOptions, PeettyModelOptions } from './types.ts';

export type { ChatEntry, CompanionAction, ModelChoice, PeettyChatOptions, PeettyModelOptions } from './types.ts';

const ACTIONS: CompanionAction[] = ['wave', 'sit', 'lie', 'sleep', 'move', 'idle'];
const MAX_INPUT = 8_000;
const MAX_OUTPUT = 16_000;
const MAX_CONTEXT_CHARS = 24_000;
const MAX_CONTEXT_MESSAGES = 24;
const MAX_REQUESTS = 4;
const MAX_ACTIONS = 6;
const TIMEOUT_MS = 60_000;
const EMPTY_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let sequence = 0;

export interface ChatRuntimeOptions {
  model?: PeettyModelOptions;
  chat?: PeettyChatOptions;
  onAction?: (action: CompanionAction, signal?: AbortSignal) => string | void | Promise<string | void>;
  onChange?: () => void;
  /** Internal seams: tests still run the real Pi agent and its tool loop. */
  _testing?: {
    storage?: ChatStorage;
    streamFn?: StreamFn;
    timeoutMs?: number;
  };
}

interface Run {
  controller: AbortController;
  agent?: Agent;
  unsubscribe?: () => void;
  assistantId?: string;
  requests: number;
  actions: number;
}

function aborted(): DOMException { return new DOMException('Request stopped.', 'AbortError'); }

/** Settle promptly even when a host credential callback or a faulty provider ignores abort. */
export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(aborted()); };
    if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); reject(aborted()); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', cancel); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', cancel); reject(error); },
    );
  });
}

function statusError(status: number): string {
  if (status === 401 || status === 403) return 'The endpoint rejected access. Check your API key.';
  if (status === 404) return 'The endpoint or model was not found.';
  if (status === 429) return 'The endpoint is busy or out of quota. Try again later.';
  return 'The endpoint could not complete the request.';
}

/** An explicit setup action; constructing or initializing a runtime never calls this. */
export async function fetchModelList(baseUrl: string, apiKey?: string, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<ModelChoice[]> {
  const base = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) throw aborted();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  try {
    const key = apiKey?.trim();
    const headers = new Headers(extraHeaders);
    headers.set('Accept', 'application/json');
    if (key && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${key}`);
    const response = await abortable(fetch(`${base}/models`, {
      headers,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }), controller.signal);
    if (!response.ok) throw new Error(statusError(response.status));
    const payload: unknown = await abortable(response.json(), controller.signal);
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new Error('Could not read the model list. Enter a model ID manually.');
    }
    const choices = new Map<string, ModelChoice>();
    for (const value of payload.data.slice(0, 10_000)) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string') continue;
      const id: string = value.id.trim();
      if (!id || id.length > 200 || /[\r\n]/.test(id)) continue;
      const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 200) : id;
      choices.set(id, { id, name });
    }
    return [...choices.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (controller.signal.aborted) throw new Error('The model list request timed out. Try again.');
    // Never expose provider bodies, request URLs, or thrown credential-bearing messages.
    if (error instanceof Error && [
      'The endpoint rejected access. Check your API key.', 'The endpoint or model was not found.',
      'The endpoint is busy or out of quota. Try again later.', 'The endpoint could not complete the request.',
      'Could not read the model list. Enter a model ID manually.',
    ].includes(error.message)) throw error;
    throw new Error('Could not load models. Check the endpoint and your connection.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export class ChatRuntime {
  private readonly options: ChatRuntimeOptions;
  private readonly storage: ChatStorage;
  private readonly secrets = new Set<string>();
  private currentModel: PeettyModelOptions | undefined;
  private history: ChatEntry[] = [];
  private currentError: string | null = null;
  private storageFailed = false;
  private active: Run | undefined;
  private initialization: Promise<void> | undefined;
  private connectionChosen: boolean;
  private historyTouched = false;
  private revision = 0;
  private destroyed = false;

  constructor(options: ChatRuntimeOptions = {}) {
    this.options = options;
    this.storage = options._testing?.storage ?? new BrowserChatStore(options.chat?.storageKey ?? 'peetty', options.chat?.persist ?? true);
    this.connectionChosen = options.model !== undefined;
    if (options.model) {
      this.currentModel = modelOptions(options.model);
      this.rememberSecrets(this.currentModel);
    }
  }

  get model(): PeettyModelOptions | undefined {
    return this.currentModel ? { ...this.currentModel, ...(this.currentModel.headers ? { headers: { ...this.currentModel.headers } } : {}) } : undefined;
  }
  get entries(): readonly ChatEntry[] { return this.history; }
  get busy(): boolean { return this.active !== undefined; }
  get error(): string | null { return this.currentError; }
  get persistenceWarning(): boolean { return this.storageFailed || this.storage.persistenceWarning; }

  private changed(): void {
    if (this.destroyed) return;
    try { this.options.onChange?.(); } catch { /* Host rendering must not break request cleanup. */ }
  }

  private rememberSecrets(model: PeettyModelOptions): void {
    if (model.apiKey) this.secrets.add(model.apiKey);
    for (const [name, value] of Object.entries(model.headers ?? {})) {
      if (/authorization|api[-_]?key|token|secret/i.test(name) && value) {
        this.secrets.add(value);
        this.secrets.add(value.replace(/^Bearer\s+/i, ''));
      }
    }
  }

  private redact(text: string): string {
    for (const secret of this.secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }

  initialize(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.initialization ??= (async () => {
      try {
        const stored = await this.storage.load();
        if (this.destroyed) return;
        // Remember old stored secrets for redaction, but never merge them into a new connection.
        if (stored.connection?.apiKey) this.secrets.add(stored.connection.apiKey);
        if (!this.connectionChosen && stored.connection) {
          try {
            this.currentModel = modelOptions(stored.connection);
            this.rememberSecrets(this.currentModel);
          } catch { /* Ignore an invalid saved connection and allow setup. */ }
        }
        if (!this.historyTouched) this.history = boundedEntries(stored.entries).map((entry) => ({ ...entry, text: this.redact(entry.text) }));
      } catch { this.storageFailed = true; }
      this.changed();
    })();
    return this.initialization;
  }

  async configure(model: PeettyModelOptions, rememberKey: boolean): Promise<void> {
    if (this.destroyed) return;
    let chosen: PeettyModelOptions;
    try { chosen = modelOptions(model); }
    catch {
      this.currentError = 'Enter a valid API base URL and model ID.';
      this.changed();
      throw new Error(this.currentError);
    }
    this.stop();
    const revision = ++this.revision;
    this.connectionChosen = true;
    this.currentError = null;
    this.currentModel = chosen;
    this.rememberSecrets(chosen);
    this.changed();
    await this.initialize();
    if (this.destroyed || revision !== this.revision) return;
    const connection: StoredConnection = {
      id: chosen.id, baseUrl: chosen.baseUrl,
      ...(rememberKey && chosen.apiKey && !chosen.getApiKey ? { apiKey: chosen.apiKey } : {}),
    };
    await this.persist(() => this.storage.saveConnection(connection));
  }

  private async persist(save: () => Promise<void>): Promise<void> {
    if (this.destroyed || this.options.chat?.persist === false) return;
    const warning = this.persistenceWarning;
    try { await save(); } catch { this.storageFailed = true; }
    if (!this.destroyed && warning !== this.persistenceWarning) this.changed();
  }

  private saveHistory(): Promise<void> {
    const entries = boundedEntries(this.history).map((entry) => ({ ...entry, text: this.redact(entry.text) }));
    return this.persist(() => this.storage.saveEntries(entries));
  }

  private append(role: ChatEntry['role'], text: string): ChatEntry {
    const entry: ChatEntry = { id: `chat-${Date.now().toString(36)}-${++sequence}`, role, text: this.redact(text), createdAt: Date.now() };
    this.history = [...this.history, entry];
    this.historyTouched = true;
    return entry;
  }

  private live(run: Run): boolean { return this.active === run && !run.controller.signal.aborted && !this.destroyed; }

  private context(model: Model<'openai-completions'>): Message[] {
    const recent: ChatEntry[] = [];
    let remaining = MAX_CONTEXT_CHARS;
    for (let i = this.history.length - 1; i >= 0 && recent.length < MAX_CONTEXT_MESSAGES && remaining > 0; i--) {
      const entry = this.history[i]!;
      if (entry.role === 'action' || !entry.text.trim()) continue;
      const text = this.redact(entry.text).slice(-remaining);
      recent.push({ ...entry, text });
      remaining -= text.length;
    }
    const messages: Message[] = recent.reverse().map((entry) => entry.role === 'user'
      ? { role: 'user', content: entry.text, timestamp: entry.createdAt }
      : {
        role: 'assistant', content: [{ type: 'text', text: entry.text }], api: model.api,
        provider: model.provider, model: model.id, usage: structuredClone(EMPTY_USAGE), stopReason: 'stop', timestamp: entry.createdAt,
      });
    // A bounded transcript starts at user input, never at an orphaned assistant reply.
    while (messages[0]?.role === 'assistant') messages.shift();
    return messages;
  }

  private systemPrompt(): string {
    const name = this.redact(this.options.chat?.name?.trim() || 'Peetty').slice(0, 100);
    const personality = this.redact(this.options.chat?.personality?.trim() || 'Be warm, curious, concise, and considerate.').slice(0, 4_000);
    return `You are ${name}, a small browser companion. ${personality}\nReply in the user's language. Use companion_action for a requested physical action when useful. You may wave, sit, lie down, sleep, move, or return to idle. Do not claim an action succeeded unless the tool confirms it. You have no page contents, browsing, or long-term memory. Never ask for or reveal API keys. Keep replies brief.`;
  }

  private tool(run: Run): AgentTool {
    return {
      name: 'companion_action', label: 'Companion action',
      description: 'Perform one physical action as the browser companion.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS } }, required: ['action'], additionalProperties: false },
      executionMode: 'sequential',
      execute: async (_id, args, signal) => {
        const action = (args as { action: CompanionAction }).action;
        if (!this.live(run) || signal?.aborted) return { content: [{ type: 'text', text: 'Action stopped.' }], details: {}, isError: true, terminate: true };
        if (!ACTIONS.includes(action) || run.actions >= MAX_ACTIONS) {
          return { content: [{ type: 'text', text: 'Action limit reached.' }], details: {}, isError: true, terminate: true };
        }
        run.actions++;
        try {
          if (!this.options.onAction) return { content: [{ type: 'text', text: 'This action is unavailable.' }], details: {}, isError: true };
          const feedback = await abortable(Promise.resolve(this.options.onAction(action, run.controller.signal)), run.controller.signal);
          if (!this.live(run)) return { content: [{ type: 'text', text: 'Action stopped.' }], details: {}, isError: true, terminate: true };
          this.append('action', action);
          this.changed();
          return { content: [{ type: 'text', text: this.redact(feedback || `Action performed: ${action}.`).slice(0, 1_000) }], details: {} };
        } catch {
          return { content: [{ type: 'text', text: 'The action could not be performed.' }], details: {}, isError: true };
        }
      },
    };
  }

  private event(run: Run, event: AgentEvent): void {
    if (!this.live(run)) return;
    if ((event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
      const message = event.message;
      const raw = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      const text = this.redact(raw).slice(0, MAX_OUTPUT);
      if (event.type === 'message_start') delete run.assistantId;
      if (text && !run.assistantId) run.assistantId = this.append('assistant', text).id;
      else if (text && run.assistantId) this.history = this.history.map((entry) => entry.id === run.assistantId ? { ...entry, text } : entry);
      if (event.type === 'message_end' && message.stopReason === 'error') {
        // Provider error bodies may echo a key. Only fixed app-owned copy reaches the UI.
        this.currentError = 'Could not get a response. Check the endpoint, model, and API key.';
      }
      this.changed();
      if (raw.length > MAX_OUTPUT) {
        this.currentError = 'The response was too long. Try a shorter request.';
        this.stop();
      }
    }
  }

  async send(input: string): Promise<void> {
    const text = input.trim();
    if (this.destroyed || this.busy || !text) return;
    if (text.length > MAX_INPUT) {
      this.currentError = 'Please keep your message under 8,000 characters.';
      this.changed();
      return;
    }
    const run: Run = { controller: new AbortController(), requests: 0, actions: 0 };
    this.active = run;
    this.currentError = null;
    this.changed();
    const timeout = this.options._testing?.timeoutMs ?? TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!this.live(run)) return;
      this.currentError = 'The response timed out. Try again.';
      this.stop();
    }, timeout);
    try {
      await abortable(this.initialize(), run.controller.signal);
      if (!this.live(run)) return;
      const selected = this.currentModel;
      if (!selected) {
        this.currentError = 'Choose an API endpoint and model first.';
        return;
      }
      const messagesBeforeInput = this.history.length;
      this.append('user', text);
      this.changed();
      let key: string;
      try {
        key = (await abortable(Promise.resolve().then(() => selected.getApiKey ? selected.getApiKey() : selected.apiKey ?? ''), run.controller.signal)).trim();
      } catch {
        if (this.live(run)) this.currentError = 'Could not access your API key. Try again.';
        return;
      }
      if (!this.live(run)) return;
      if (key) this.secrets.add(key);
      this.history = this.history.map((entry) => ({ ...entry, text: this.redact(entry.text) }));
      const [{ Agent }, { createModels, createProvider }, { openAICompletionsApi }] = await abortable(Promise.all([
        import('@earendil-works/pi-agent-core'),
        import('@earendil-works/pi-ai/models'),
        import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      ]), run.controller.signal);
      if (!this.live(run)) return;
      const model: Model<'openai-completions'> = {
        id: selected.id, name: selected.id, api: 'openai-completions', provider: 'peetty', baseUrl: selected.baseUrl,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384, maxTokens: 1_200,
      };
      // Explicit auth only: no env lookup, prior endpoint key, or SDK credential store.
      // Pi requires a nonempty key even for keyless servers. The sentinel never becomes a header.
      const headers = { ...selected.headers };
      const hasAuthHeader = Object.keys(headers).some((name) => /^(authorization|cf-aig-authorization)$/i.test(name));
      const requestHeaders = !key && !hasAuthHeader ? { ...headers, Authorization: null } : headers;
      const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
      models.setProvider(createProvider({
        id: 'peetty', models: [model], api: openAICompletionsApi(),
        auth: { apiKey: { name: 'User connection', resolve: async () => ({ auth: {} }) } },
      }));
      const stream: StreamFn = this.options._testing?.streamFn ?? models.streamSimple.bind(models);
      const recent = this.context(model);
      // The newly appended user input is passed to prompt rather than installed twice.
      if (this.history.length > messagesBeforeInput && recent.at(-1)?.role === 'user') recent.pop();
      const agent = new Agent({
        initialState: { model, systemPrompt: this.systemPrompt(), messages: recent, tools: [this.tool(run)], thinkingLevel: 'off' },
        toolExecution: 'sequential', identity: { attribution: null },
        streamFn: async (requestModel, context, options) => {
          if (!this.live(run) || ++run.requests > MAX_REQUESTS) throw aborted();
          return stream(requestModel, context, {
            ...options, apiKey: key || 'peetty-keyless', headers: requestHeaders,
            maxRetries: 0, timeoutMs: timeout, maxTokens: 1_200, cacheRetention: 'none',
          });
        },
        beforeToolCall: async ({ args }) => {
          if (!this.live(run) || run.actions >= MAX_ACTIONS || JSON.stringify(args).length > 2_000) {
            return { block: true, reason: 'Action limit reached.', terminate: true };
          }
          return undefined;
        },
        finishTurn: ({ message }) => {
          if (this.live(run) && message.stopReason === 'toolUse' && (run.requests >= MAX_REQUESTS || run.actions >= MAX_ACTIONS)) {
            this.currentError = 'Action limit reached. Try a simpler request.';
            this.changed();
            return { action: 'end' };
          }
        },
      });
      run.agent = agent;
      run.unsubscribe = agent.subscribe((event) => this.event(run, event));
      await abortable(agent.prompt({ role: 'user', content: this.redact(text), timestamp: Date.now() }), run.controller.signal);
    } catch {
      if (this.live(run)) this.currentError = 'Could not get a response. Check the endpoint, model, and API key.';
    } finally {
      clearTimeout(timer);
      run.unsubscribe?.();
      if (this.active === run) {
        this.active = undefined;
        this.history = boundedEntries(this.history);
        this.changed();
        await this.saveHistory();
      }
    }
  }

  stop(): void {
    const run = this.active;
    if (!run) return;
    this.active = undefined;
    run.controller.abort();
    run.agent?.abort();
    run.unsubscribe?.();
    this.history = boundedEntries(this.history);
    this.changed();
    void this.saveHistory();
  }

  async clear(): Promise<void> {
    if (this.destroyed) return;
    this.stop();
    this.historyTouched = true;
    this.history = [];
    this.currentError = null;
    this.changed();
    await this.initialize();
    if (!this.destroyed) await this.saveHistory();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.revision++;
    this.storage.close();
    this.secrets.clear();
    this.currentModel = undefined;
  }
}
