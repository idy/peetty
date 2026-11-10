// Checked-in browser builds let jsDelivr serve a GitHub tag without npm auth.
import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserModules, browserGlobal } from './build-options.mjs';
import { bundledLicenses } from './bundled-licenses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'cdn');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const options = { absWorkingDir: root, minify: true, sourcemap: false, write: false, logLevel: 'silent', metafile: true, legalComments: 'inline' };
const builds = await Promise.all([
  build({ ...browserModules, ...options, outdir: directory }),
  build({ ...browserGlobal, ...options, outfile: join(directory, 'peetty.global.js') }),
]);
const files = new Map(builds.flatMap(result => result.outputFiles.map(file => [relative(directory, file.path).replaceAll('\\', '/'), file.text])));
for (const name of ['index.js', 'peetty.global.js', 'chat/panel.js']) {
  if (!files.has(name)) throw new Error(`CDN build is missing ${name}`);
}
for (const [name, text] of files) {
  if (text.includes('peetty.idy.dev')) throw new Error(`${name} still depends on the website domain`);
}
files.set('LICENSE', await readFile(join(root, 'LICENSE'), 'utf8'));
files.set('THIRD_PARTY_NOTICES.txt', await bundledLicenses(builds.map(result => result.metafile), root));
files.set('README.md', `# Peetty browser distribution\n\nGenerated for v${version} by \`npm run build:cdn\`. Commit this directory together with its source before tagging a release. jsDelivr serves these files directly from GitHub; no npm installation or registry authentication is needed.\n\n- ES module: https://cdn.jsdelivr.net/gh/idy/peetty@v${version}/cdn/index.js\n- Classic script: https://cdn.jsdelivr.net/gh/idy/peetty@v${version}/cdn/peetty.global.js\n\nKeep \`chat/\` and \`chunks/\` adjacent to the entry points. Figure JSON lives in the sibling \`figures/\` directory at the repository root. Both browser entries retain their own CDN host and version when loading these resources. No separate CSS file is required. Preserve \`THIRD_PARTY_NOTICES.txt\` when redistributing these files; it contains the licenses and notices for bundled dependencies. Per-file license comments are also retained.\n\nThese URLs become available only after the corresponding GitHub tag is pushed. Do not edit generated files by hand.\n`);

async function list(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? list(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}
if (process.argv.includes('--check')) {
  const present = (await list(directory)).map(path => relative(directory, path).replaceAll('\\', '/')).sort();
  const expected = [...files.keys()].sort();
  let matches = JSON.stringify(present) === JSON.stringify(expected);
  for (const [name, text] of files) {
    if (await readFile(join(directory, name), 'utf8').catch(() => null) !== text) matches = false;
  }
  if (!matches) {
    console.error('CDN build is out of date. Run npm run build:cdn and commit cdn/.');
    process.exitCode = 1;
  } else console.log(`CDN build verified: v${version}, ${files.size} files`);
} else {
  await rm(directory, { recursive: true, force: true });
  for (const [name, text] of files) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  console.log(`CDN build generated: v${version}, ${files.size} files`);
}
