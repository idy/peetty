import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// These npm tarballs omit their own MIT text. All four npm SLSA attestations
// identify v1.5.0 at this commit, whose root LICENSE applies to these packages:
// https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-ai@1.5.0
const piPackages = new Set([
  '@earendil-works/pi-agent-core@1.5.0', '@earendil-works/pi-ai@1.5.0',
  '@earendil-works/pi-schema@1.5.0', '@earendil-works/pi-telemetry@1.5.0',
]);
const piCommit = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const piLicenseFile = `licenses/pi-1.5.0-${piCommit}.LICENSE`;
const piLicenseSource = `https://raw.githubusercontent.com/earendil-works/pi/${piCommit}/LICENSE`;
const piLicenseHash = '0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48';

const legalName = /(?:^|[._-])(?:licen[cs]es?|notices?|copying|copyrights?)(?:$|[._-])/i;
const primaryName = /^(?:licen[cs]es?|copying)(?:$|[._-])/i;
const legalDirectory = /^(?:licen[cs]es?|notices?|copying|copyrights?)$/i;

async function licenseFiles(packageRoot) {
  const files = [];
  const ancestors = new Set();

  async function visit(directory, insideLegalDirectory = false) {
    const physical = await realpath(directory);
    if (ancestors.has(physical)) throw new Error(`Cyclic directory in ${directory}`);
    ancestors.add(physical);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      // Nested dependencies get their own notices only if they occur in the input graph.
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const filename = path.join(directory, entry.name);
      const info = entry.isSymbolicLink() ? await stat(filename) : entry;
      if (info.isDirectory()) {
        await visit(filename, insideLegalDirectory || legalDirectory.test(entry.name));
      } else if (info.isFile() && (insideLegalDirectory || legalName.test(entry.name))) {
        const text = await readFile(filename, 'utf8');
        if (!text.trim() || text.includes('\0') || text.includes('�')) {
          throw new Error(`Empty or non-text license/notice file: ${filename}`);
        }
        files.push({ name: path.relative(packageRoot, filename).split(path.sep).join('/'), text });
      }
    }
    ancestors.delete(physical);
  }

  await visit(packageRoot);
  return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function primaryLicenseFiles(files, license) {
  // A vendored license (e.g. LICENSES/typebox-LICENSE) is not the package's own license.
  return files.filter(file =>
    (!file.name.includes('/') && primaryName.test(file.name)) ||
    file.name.toLowerCase().replace(/\.(txt|md|markdown)$/i, '') === `licenses/${license.toLowerCase()}`);
}

function checkLicenseText(files, license, label) {
  const primary = primaryLicenseFiles(files, license);
  if (!primary.length) {
    throw new Error(`${label}: missing the package's own full license text (LICENSE/COPYING); license metadata alone is insufficient`);
  }
  const text = primary.map(file => file.text).join('\n').replace(/\s+/g, ' ').replace(/['‘’“”]/g, '"').toLowerCase();
  const required = license === 'MIT' ? [
    'copyright',
    'permission is hereby granted, free of charge',
    'the above copyright notice and this permission notice shall be included',
    'the software is provided "as is"',
    'or other dealings in the software',
  ] : license === 'Apache-2.0' ? [
    'apache license', 'version 2.0', '4. redistribution.', 'end of terms and conditions',
  ] : [];
  if (required.some(fragment => !text.includes(fragment))) {
    throw new Error(`${label}: incomplete ${license} license text or missing copyright notice`);
  }
}

/**
 * Collect notices from installed packages named by esbuild's actual input graphs.
 * Metafile input paths must be relative to root (the build's absWorkingDir), or absolute.
 * No lockfile lookup, network access, or license/copyright synthesis is performed.
 * Missing package metadata or license text rejects the build.
 * @param {readonly import('esbuild').Metafile[]} metafiles
 * @param {string} root Absolute build working directory.
 * @returns {Promise<string>} Deterministic THIRD_PARTY_NOTICES.txt content.
 */
export async function bundledLicenses(metafiles, root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('bundledLicenses requires an absolute build root');
  }
  if (!Array.isArray(metafiles)) throw new TypeError('Expected an array of esbuild metafiles');
  const packageRoots = new Set();
  for (const metafile of metafiles) {
    if (!metafile?.inputs || typeof metafile.inputs !== 'object' || Array.isArray(metafile.inputs)) {
      throw new TypeError('Each esbuild metafile must contain an inputs object');
    }
    for (const input of Object.keys(metafile.inputs)) {
      const parts = path.resolve(root, input).split(path.sep);
      const index = parts.lastIndexOf('node_modules');
      if (index === -1) continue;
      const name = parts[index + 1];
      const end = index + (name?.startsWith('@') ? 3 : 2);
      if (!name || end >= parts.length || !parts[end - 1]) {
        throw new Error(`Cannot identify the installed package for esbuild input: ${input}`);
      }
      // Use the last node_modules boundary, including both segments of a scoped name.
      packageRoots.add(parts.slice(0, end).join(path.sep));
    }
  }

  const installedRoots = new Set(await Promise.all([...packageRoots].map(directory => realpath(directory))));
  const sections = new Set();
  const errors = [];
  for (const packageRoot of [...installedRoots].sort()) {
    try {
      const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      const { name, version } = manifest;
      const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
      if (![name, version, license].every(value => typeof value === 'string' && value.trim())) {
        throw new Error(`${packageRoot}: package.json must contain a name, exact version and license identifier`);
      }
      const label = `${name}@${version}`;
      const files = await licenseFiles(packageRoot);
      if (!primaryLicenseFiles(files, license).length && license === 'MIT' && piPackages.has(label)) {
        const text = await readFile(path.join(root, piLicenseFile), 'utf8');
        if (createHash('sha256').update(text).digest('hex') !== piLicenseHash) {
          throw new Error(`${label}: pinned upstream license failed its SHA-256 check`);
        }
        files.unshift({ name: 'LICENSE.upstream', text, source: piLicenseSource });
      }
      checkLicenseText(files, license, label);
      sections.add([
        '='.repeat(80),
        `Package: ${label}`,
        `License: ${license}`,
        '',
        ...files.map(file => `--- ${file.name} ---\n${file.source ? `Source: ${file.source}\n\n` : ''}${file.text}${file.text.endsWith('\n') ? '' : '\n'}`),
      ].join('\n'));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, `Cannot generate bundled license notices:\n${errors.map(error => error.message).join('\n')}`);
  }
  return 'THIRD-PARTY NOTICES\n\n' + [...sections].sort().join('\n') + '\n';
}
