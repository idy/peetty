// Maintains the figure catalog in figures/.
//
// - Figures with a source in figures/src/<id>.mjs are validated and written
//   to figures/<id>.json.
// - Every figures/<id>.json, generated or contributed directly as JSON, is
//   validated and listed in figures/index.json.
// - The catalog is mirrored into flutter/assets/figures/ for the Flutter package.
//
// `--check` writes nothing and fails if any generated file is out of date.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { CATALOG_FORMAT, PRESET_IDS } from '../src/catalog.ts';
import { validateFigure } from '../src/figure/validate.ts';

const check = process.argv.includes('--check');
const dir = new URL('../figures/', import.meta.url);
const problems = [];

async function output(name, text) {
  const target = new URL(name, dir);
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== text) problems.push(`figures/${name} is out of date; run npm run figures`);
  } else {
    await writeFile(target, text);
  }
}

const sources = (await readdir(new URL('src/', dir))).filter((f) => f.endsWith('.mjs') && f !== 'kit.mjs');
for (const file of sources) {
  const id = file.slice(0, -4);
  const { default: figure } = await import(new URL(`src/${file}`, dir).href);
  validateFigure(figure);
  if (figure.id !== id) throw new Error(`figures/src/${file} declares id "${figure.id}"`);
  const json = `${JSON.stringify(figure)}\n`;
  await output(`${id}.json`, json);
  if (!check) console.log(`figures/${id}.json  ${(json.length / 1024).toFixed(1)} KB, ${figure.parts.length} parts`);
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
const entries = [];
for (const file of files) {
  let figure;
  try {
    figure = validateFigure(JSON.parse(await readFile(new URL(file, dir), 'utf8')));
  } catch (error) {
    problems.push(`figures/${file}: ${error.message}`);
    continue;
  }
  if (`${figure.id}.json` !== file) problems.push(`figures/${file}: the file must be named ${figure.id}.json`);
  if (!figure.author) problems.push(`figures/${file}: catalog figures need an author`);
  if (!figure.license) problems.push(`figures/${file}: catalog figures need a license (an SPDX id such as CC-BY-4.0)`);
  entries.push({
    id: figure.id,
    name: figure.name,
    ...(figure.description ? { description: figure.description } : {}),
    author: figure.author,
    license: figure.license,
    renderer: figure.renderer,
    // Bundled into the SDK; every other catalog figure loads on demand.
    bundled: PRESET_IDS.includes(figure.id),
    // Resolve against the fetched index, preserving its CDN host and version.
    url: file,
  });
}
// Bundled presets first in their own order, then the rest by id.
const rank = (e) => (e.bundled ? PRESET_IDS.indexOf(e.id) : PRESET_IDS.length);
entries.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
await output('index.json', `${JSON.stringify({ format: CATALOG_FORMAT, version: 1, figures: entries }, null, 2)}\n`);
if (!check) console.log(`figures/index.json  ${entries.length} figures`);

// The Flutter package bundles the same catalog as assets.
const flutterDir = new URL('../flutter/assets/figures/', import.meta.url);
const mirrored = new Set([...files, 'index.json']);
if (!check) await mkdir(flutterDir, { recursive: true });
for (const file of mirrored) {
  const text = await readFile(new URL(file, dir), 'utf8');
  const target = new URL(file, flutterDir);
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== text) problems.push(`flutter/assets/figures/${file} is out of date; run npm run figures`);
  } else {
    await writeFile(target, text);
  }
}
for (const file of await readdir(flutterDir).catch(() => [])) {
  if (file.endsWith('.json') && !mirrored.has(file)) {
    if (check) problems.push(`flutter/assets/figures/${file} is not in figures/; run npm run figures`);
    else await rm(new URL(file, flutterDir));
  }
}
if (!check) console.log(`flutter/assets/figures/  ${mirrored.size} files`);

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
