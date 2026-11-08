/** An OpenAI-compatible chat endpoint. SDK credentials are kept in memory. */
export interface PeettyModelOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  getApiKey?: () => string | Promise<string>;
  headers?: Record<string, string>;
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
