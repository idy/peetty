// Verify the files npm will publish, including relative declaration imports.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = new Set(result[0].files.map((file) => file.path));
const required = ['dist/index.js', 'dist/index.d.ts', 'dist/peetty.global.js', 'figures/index.json', 'schema/figure-v1.json'];
for (const path of required) {
  if (!files.has(path)) throw new Error(`Package is missing ${path}`);
}
for (const file of files) {
  if (!file.endsWith('.d.ts')) continue;
  const text = await readFile(file, 'utf8');
  const imports = text.matchAll(/(?:from\s+|import\()['"](\.\.?\/[^'"]+)['"]/g);
  for (const [, specifier] of imports) {
    if (!specifier.endsWith('.js')) throw new Error(`${file} has non-JavaScript declaration import ${specifier}`);
    const declaration = new URL(specifier.replace(/\.js$/, '.d.ts'), new URL(`../${file}`, import.meta.url));
    await readFile(declaration).catch(() => { throw new Error(`${file} references missing declaration ${specifier}`); });
  }
}
console.log(`Package verified: ${result[0].name}@${result[0].version}, ${files.size} files`);
