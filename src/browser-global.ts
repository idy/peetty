/** CDN classic build: configure the catalog before automatic mounting starts. */
import { setFigureScriptSource } from './catalog.ts';
import { mountFromScript } from './script.ts';

export * from './index.ts';
const script = document.currentScript as HTMLScriptElement | null;
if (script?.src) setFigureScriptSource(script.src);
mountFromScript(script);
