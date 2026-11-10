// Keep the catalog on the same CDN host and version as this browser entry.
import { setFigureScriptSource } from './catalog.ts';

setFigureScriptSource(import.meta.url);
export * from './index.ts';
