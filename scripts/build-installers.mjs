#!/usr/bin/env node
/**
 * Builds the installers. One entry point for every platform, used both by hand and by
 * .github/workflows/release.yml, so a local build and a release build go through
 * exactly the same code path.
 *
 *   node scripts/build-installers.mjs                    # this machine, this CPU
 *   node scripts/build-installers.mjs --win              # Windows NSIS setup .exe
 *   node scripts/build-installers.mjs --mac              # macOS .dmg
 *   node scripts/build-installers.mjs --win --arch x64 --arch arm64
 *   node scripts/build-installers.mjs --dir              # the app only, no installer
 *
 * The bundling itself is Tauri's, configured in src-tauri/tauri.conf.json. This script
 * does the parts a config file cannot: one `tauri build` per architecture, refusing
 * what the host cannot build before spending ten minutes finding out, and collecting
 * what came out into dist/ under stable names with checksums. The release workflow
 * depends on both the names and the checksum files.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(ROOT, 'src-tauri', 'target');

/** Rust target triple for each platform and CPU. */
const TRIPLES = {
  win: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  mac: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
};

/** Which Tauri bundle each platform ships, and what it is called in dist/. */
const BUNDLES = {
  win: {
    kind: 'nsis',
    ext: '.exe',
    name: (version, arch) => `desktop-cat-${version}-win-${arch}-setup.exe`,
  },
  mac: {
    kind: 'dmg',
    ext: '.dmg',
    name: (version, arch) => `desktop-cat-${version}-mac-${arch}.dmg`,
  },
};

const HOST = { win32: 'win', darwin: 'mac' }[process.platform];

/**
 * Files that must exist before building. All are generated, and every one of them
 * fails late or quietly when missing: no sprites builds an installer for an invisible
 * cat, and a missing icon only surfaces at the very end of a ten-minute release build.
 */
const REQUIRED = [
  ['assets/sprites/manifest.json', 'npm run assets'],
  ['icons/fish.png', 'npm run treat'],
  // Compiled into the binary as the tray icon.
  ['build/icons/32x32.png', 'npm run icons'],
  ['src-tauri/icons/icon.ico', 'npm run icons'],
  ['src-tauri/icons/icon.icns', 'npm run icons'],
  ['src-tauri/icons/128x128.png', 'npm run icons'],
];

const USAGE = `
Usage: node scripts/build-installers.mjs [options]

Platforms (default: whichever this machine is)
  --win                 Windows installer (NSIS setup .exe)
  --mac                 macOS disk image (.dmg)
  --all                 Both of the above (needs CI, see below)

Options
  --arch <a>            x64 or arm64. Repeatable. Defaults to this machine's CPU;
                        CI passes both. Each one needs its Rust target installed:
                        rustup target add <triple>.
  --dir                 The app binary only, no installer. For a quick look.
  -h, --help            This text.

An installer has to be built on its own operating system: a .dmg needs macOS, and
the Windows installer needs the MSVC toolchain. That is what the GitHub Actions
workflow is for -- it runs this same script once per runner and collects the
results. See the Installers section of README.md.
`;

function fail(message, hint) {
  console.error(`\nerror  ${message}`);
  if (hint) console.error(`       ${hint}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { platforms: new Set(), archs: [], dirOnly: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--win':
      case '--windows':
        options.platforms.add('win');
        break;
      case '--mac':
      case '--macos':
      case '--osx':
        options.platforms.add('mac');
        break;
      case '--all':
        options.platforms.add('win').add('mac');
        break;
      case '--dir':
        options.dirOnly = true;
        break;
      case '--arch': {
        const value = argv[(i += 1)];
        if (value !== 'x64' && value !== 'arm64') {
          fail('--arch expects x64 or arm64', `got ${value ?? '(nothing)'}`);
        }
        if (!options.archs.includes(value)) options.archs.push(value);
        break;
      }
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        fail(`unknown argument ${arg}`, 'run with --help for the supported options');
    }
  }

  if (options.platforms.size === 0) {
    if (!HOST) {
      fail(
        `nothing to build on ${process.platform}`,
        'Desktop Cat ships for Windows and macOS. Run it from source with `npm start`.',
      );
    }
    options.platforms.add(HOST);
  }
  if (options.archs.length === 0) {
    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      fail(`no default architecture for a ${process.arch} host`, 'pass --arch x64 or --arch arm64');
    }
    options.archs.push(process.arch);
  }

  return options;
}

/** Stop early on what cannot work here, instead of ten minutes into a build. */
function checkHost({ platforms }) {
  const problems = [];
  if (platforms.has('mac') && process.platform !== 'darwin') {
    problems.push('Building a macOS .dmg requires macOS: the disk image is made with hdiutil.');
  }
  if (platforms.has('win') && process.platform !== 'win32') {
    problems.push(
      'Building the Windows installer requires Windows: the app links against the ' +
        'MSVC toolchain and the Windows SDK.',
    );
  }
  if (problems.length > 0) {
    fail(
      `cannot build these installers on ${process.platform}:\n       - ${problems.join('\n       - ')}`,
      'Push to main and let .github/workflows/release.yml build both.',
    );
  }
}

async function checkRequiredFiles() {
  const missing = [];
  for (const [relative, hint] of REQUIRED) {
    try {
      await fs.access(path.join(ROOT, relative));
    } catch {
      missing.push(`${relative}  (regenerate with: ${hint})`);
    }
  }
  if (missing.length > 0) {
    fail(`missing files the build needs:\n       - ${missing.join('\n       - ')}`);
  }
}

/** Rust present, and every requested target installed. */
function checkToolchain(triples) {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (cargo.error || cargo.status !== 0) {
    fail(
      'cargo is not on PATH',
      'Install Rust from https://rustup.rs, then open a new terminal so PATH is picked up.',
    );
  }

  const installed = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  // Without rustup there is no way to ask; let cargo report a missing target itself.
  if (installed.error || installed.status !== 0) return;
  const have = new Set(installed.stdout.split(/\r?\n/).map((line) => line.trim()));
  const missing = triples.filter((triple) => !have.has(triple));
  if (missing.length > 0) {
    fail(
      `Rust target${missing.length === 1 ? '' : 's'} not installed: ${missing.join(', ')}`,
      `run: rustup target add ${missing.join(' ')}`,
    );
  }
}

function tauriCli() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@tauri-apps/cli/tauri.js');
  } catch {
    return fail('the Tauri CLI is not installed', 'run: npm install');
  }
}

function formatSize(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The installer Tauri just wrote for this build, picked out by version so a stale
 * bundle from an earlier version in the same folder can never be shipped by mistake.
 */
async function findBundle(triple, bundle, version) {
  const dir = path.join(TARGET, triple, 'release', 'bundle', bundle.kind);
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const matches = entries.filter(
    (name) => name.endsWith(bundle.ext) && name.includes(`_${version}_`),
  );
  if (matches.length === 0) return null;

  const stamped = await Promise.all(
    matches.map(async (name) => {
      const file = path.join(dir, name);
      return { file, mtime: (await fs.stat(file)).mtimeMs };
    }),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped[0].file;
}

/** Clears out only what this script itself puts in dist/, for this platform. */
async function cleanDist(platform, suffix) {
  await fs.mkdir(DIST, { recursive: true });
  const bundle = BUNDLES[platform];
  const ours = (name) =>
    (name.startsWith('desktop-cat-') && name.endsWith(bundle.ext)) ||
    name === `SHA256SUMS-${suffix}.txt` ||
    name === `installers-${suffix}.json`;
  for (const name of await fs.readdir(DIST)) {
    if (ours(name)) await fs.rm(path.join(DIST, name), { force: true });
  }
}

/**
 * A checksum file per platform, not one shared file: the CI jobs run on separate
 * machines and their outputs are only ever brought together afterwards, so a single
 * name would just overwrite itself.
 */
async function writeManifest(version, suffix, files) {
  const manifest = path.join(DIST, `installers-${suffix}.json`);
  await fs.writeFile(
    manifest,
    `${JSON.stringify({ product: 'desktop-cat', version, builtOn: suffix, files }, null, 2)}\n`,
  );

  const sums = path.join(DIST, `SHA256SUMS-${suffix}.txt`);
  await fs.writeFile(sums, files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n');

  return [manifest, sums];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE.trim());
    return;
  }

  const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

  checkHost(options);
  await checkRequiredFiles();

  const jobs = [];
  for (const platform of options.platforms) {
    for (const arch of options.archs) {
      jobs.push({ platform, arch, triple: TRIPLES[platform][arch] });
    }
  }
  checkToolchain(jobs.map((job) => job.triple));
  const cli = tauriCli();

  console.log(
    `\nbuilding desktop-cat ${version}: ` +
      jobs.map((job) => `${job.platform}-${job.arch}`).join(', ') +
      (options.dirOnly ? ' (app only, no installer)' : ''),
  );

  const files = [];
  for (const job of jobs) {
    const bundle = BUNDLES[job.platform];
    console.log(`\n---- ${job.platform} ${job.arch} (${job.triple}) ----\n`);

    // Run the CLI's own script with this Node rather than through npx, so there is no
    // shell in the way on Windows and no second copy of the CLI gets fetched.
    const args = [cli, 'build', '--target', job.triple];
    args.push(...(options.dirOnly ? ['--no-bundle'] : ['--bundles', bundle.kind]));
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (result.error) fail(`could not start the Tauri CLI: ${result.error.message}`);
    if (result.status !== 0) fail(`tauri build failed for ${job.triple} (exit ${result.status})`);

    if (options.dirOnly) continue;

    const built = await findBundle(job.triple, bundle, version);
    if (!built) {
      fail(
        `the build finished but no ${bundle.kind} installer for ${version} turned up`,
        `looked in ${path.relative(ROOT, path.join(TARGET, job.triple, 'release', 'bundle', bundle.kind))}`,
      );
    }
    files.push({ platform: job.platform, built, name: bundle.name(version, job.arch) });
  }

  if (options.dirOnly) {
    console.log('\napp built under src-tauri/target/<triple>/release/ -- no installers were made.');
    return;
  }

  const suffix = { win32: 'windows', darwin: 'macos' }[process.platform];
  for (const platform of options.platforms) await cleanDist(platform, suffix);

  const described = [];
  for (const file of files) {
    const target = path.join(DIST, file.name);
    await fs.copyFile(file.built, target);
    described.push({
      name: file.name,
      bytes: (await fs.stat(target)).size,
      sha256: await sha256(target),
    });
  }
  described.sort((a, b) => a.name.localeCompare(b.name));

  const written = await writeManifest(version, suffix, described);
  const width = Math.max(...described.map((file) => file.name.length));

  console.log(`\ninstallers in ${path.relative(process.cwd(), DIST) || 'dist'}/\n`);
  for (const file of described) {
    console.log(
      `  ${file.name.padEnd(width)}  ${formatSize(file.bytes).padStart(9)}` +
        `  sha256:${file.sha256.slice(0, 12)}`,
    );
  }
  console.log(
    `\n${described.length} installer${described.length === 1 ? '' : 's'}; checksums in ` +
      written.map((file) => path.basename(file)).join(' and '),
  );
}

main().catch((error) => {
  console.error(`\n${error?.stack || error}`);
  process.exit(1);
});
