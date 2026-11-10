// Portable by default; official deployments can explicitly retain legacy URLs.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeSiteFigures(source, target, catalogBase) {
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    if (file.endsWith('.json') && file !== 'index.json') await cp(join(source, file), join(target, file));
  }
  const index = JSON.parse(await readFile(join(source, 'index.json'), 'utf8'));
  let output = index;
  if (catalogBase !== undefined) {
    const base = new URL(catalogBase);
    if (!['http:', 'https:'].includes(base.protocol) || !base.pathname.endsWith('/') || base.username || base.password) {
      throw new Error('Catalog base must be an HTTP(S) directory URL without credentials');
    }
    output = { ...index, figures: index.figures.map(entry => ({
      ...entry, url: new URL(entry.url, base).href,
    })) };
  }
  await writeFile(join(target, 'index.json'), `${JSON.stringify(output, null, 2)}\n`);
}
