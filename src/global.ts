/**
 * Script-tag build: exposes `window.Peetty` and, when the script tag has
 * `data-peetty-auto`, adds a companion once the page is ready.
 *
 *   <script src="https://peetty.idy.dev/sdk/peetty.global.js" data-peetty-auto data-figure="shiori" defer></script>
 */
import { createPeetty, type Activity, type PeettyOptions } from './pet/pet.ts';
import { setChatScriptSource } from './chat/load.ts';

export * from './index.ts';

const script = document.currentScript as HTMLScriptElement | null;
if (script?.src) setChatScriptSource(script.src);
if (script?.hasAttribute('data-peetty-auto')) {
  const data = script.dataset;
  const options: PeettyOptions = {};
  if (data.figure) options.figure = data.figure;
  if (data.size && Number(data.size) > 0) options.size = Number(data.size);
  if (data.activity === 'calm' || data.activity === 'normal' || data.activity === 'lively') options.activity = data.activity as Activity;
  if (data.language === 'en' || data.language === 'zh') options.language = data.language;
  if (data.greet === 'false') options.greet = false;
  const start = () => {
    const pet = createPeetty(options);
    (globalThis as { peetty?: unknown }).peetty = pet;
    pet.mount().catch((error: unknown) => console.error('[peetty]', error));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
