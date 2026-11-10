import { createPeetty, type Activity, type PeettyOptions } from './pet/pet.ts';
import { setChatScriptSource } from './chat/load.ts';

/** Shared classic-script setup; catalog routing belongs to each build entry. */
export function mountFromScript(script: HTMLScriptElement | null): void {
  if (script?.src) setChatScriptSource(script.src);
  if (!script?.hasAttribute('data-peetty-auto')) return;
  const data = script.dataset;
  const options: PeettyOptions = {};
  if (data.figure) options.figure = data.figure;
  if (data.size && Number(data.size) > 0) options.size = Number(data.size);
  if (data.activity === 'calm' || data.activity === 'normal' || data.activity === 'lively') options.activity = data.activity as Activity;
  if (data.language === 'en' || data.language === 'zh') options.language = data.language;
  if (data.greet === 'false') options.greet = false;
  if (data.sound === 'true' || data.sound === 'false') options.sound = data.sound === 'true';
  const start = () => {
    const pet = createPeetty(options);
    (globalThis as { peetty?: unknown }).peetty = pet;
    pet.mount().catch((error: unknown) => console.error('[peetty]', error));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
