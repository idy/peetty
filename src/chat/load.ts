import type { createChatPanel } from './panel.ts';

let scriptChatUrl: string | undefined;

/** Called while the external classic script is evaluating, before currentScript disappears. */
export function setChatScriptSource(source: string): void {
  scriptChatUrl = new URL('chat/panel.js', source).href;
}

export function loadChatPanel(): Promise<{ createChatPanel: typeof createChatPanel }> {
  // The global build uses an absolute URL captured from its own script tag.
  // ESM builds keep a normal relative import so bundlers can split the module.
  return scriptChatUrl ? import(scriptChatUrl) : import('./panel.ts');
}
