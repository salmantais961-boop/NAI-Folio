import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeDesktopNotices(root, dest) {
  await mkdir(dest, { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'public/fonts/misans/LICENSE.pdf', 'public/catalog-data/ffdkj-LICENSE.txt', 'public/catalog-data/cooccurrence/LICENSE.txt',
    'public/fonts/italiana-LICENSE.txt', 'public/fonts/instrument-LICENSE.txt', 'public/vendor/three-LICENSE.txt',
    'public/vendor/react-bits-LICENSE.txt', 'public/vendor/meshoptimizer-LICENSE.txt', 'public/vendor/draco/LICENSE.txt',
    'public/tokenizers/CLIP-LICENSE.txt', 'public/tokenizers/Qwen3.5-LICENSE.txt',
    'public/tokenizers/T5-LICENSE.txt', 'public/tokenizers/Python-LICENSE.txt']) {
    const target = path.join(dest, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version=1', '--locked',
    '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', 'src-tauri/Cargo.toml'],
  { cwd: root, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }));
  const licenses = new Map(), index = [];
  for (const pkg of metadata.packages.filter(pkg => pkg.source)) {
    const label = pkg.name + ' ' + pkg.version;
    index.push(label + ' · ' + (pkg.license || 'See source') + ' · https://crates.io/crates/' + pkg.name + '/' + pkg.version);
    const directory = path.dirname(pkg.manifest_path);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(licen[sc]e|copying|notice|copyright|unlicense)(?:[-.]|$)/i.test(entry.name))
      .map(entry => entry.name);
    if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
    for (const file of files) {
      const license = (await readFile(path.resolve(directory, file), 'utf8')).replaceAll('\r\n', '\n').trim();
      if (!licenses.has(license)) licenses.set(license, new Set());
      licenses.get(license).add(label);
    }
  }
  const sections = ['Folio Desktop · Rust dependencies', index.join('\n')];
  for (const [license, packages] of licenses) sections.push([...packages].join(', ') + '\n\n' + license);
  await writeFile(path.join(dest, 'Rust-Licenses.txt'), sections.join('\n\n────────\n\n') + '\n');
}
