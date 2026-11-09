export type PeettyReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** An OpenAI-compatible chat endpoint. SDK credentials are kept in memory. */
export interface PeettyModelOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  getApiKey?: () => string | Promise<string>;
  headers?: Record<string, string>;
  /** Enable companion action tools. Defaults to true. */
  tools?: boolean;
  /** Explicit reasoning effort. Omit to leave the provider's default unchanged. */
  effort?: PeettyReasoningEffort;
}

export interface PeettyChatOptions {
  storageKey?: string;
  persist?: boolean;
  personality?: string;
  name?: string;
}

export type CompanionAction = 'wave' | 'sit' | 'lie' | 'sleep' | 'move' | 'idle';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'action';
  /** Action entries contain the literal CompanionAction, for localization. */
  text: string;
  createdAt: number;
}

export interface ModelChoice {
  id: string;
  name: string;
}
