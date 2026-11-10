/** Package classic build: preserve public-catalog loading for existing embeds. */
import { mountFromScript } from './script.ts';

export * from './index.ts';
mountFromScript(document.currentScript as HTMLScriptElement | null);
