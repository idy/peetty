// Keep the historical website endpoint readable by SDK releases before 0.3.1.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeSiteFigures(source, target) {
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    if (file.endsWith('.json') && file !== 'index.json') await cp(join(source, file), join(target, file));
  }
  const index = JSON.parse(await readFile(join(source, 'index.json'), 'utf8'));
  const legacy = { ...index, figures: index.figures.map(entry => ({
    ...entry, url: new URL(entry.url, 'https://peetty.idy.dev/figures/').href,
  })) };
  await writeFile(join(target, 'index.json'), `${JSON.stringify(legacy, null, 2)}\n`);
}
