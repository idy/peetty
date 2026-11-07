// Declaration files refer to source .ts imports. Rewrite those references to
// .js, so TypeScript consumers can resolve the declarations in the package.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewrite(path);
    else if (entry.name.endsWith('.d.ts')) {
      const contents = await readFile(path, 'utf8');
      const fixed = contents.replace(/((?:from\s+|import\()['"])(\.\.?\/[^'"]+)\.ts(?=['"])/g, '$1$2.js');
      if (fixed !== contents) await writeFile(path, fixed);
    }
  }
}

await rewrite('dist');
