#!/usr/bin/env node
/**
 * Builds the installers. One entry point for every platform, used both by hand and by
 * .github/workflows/release.yml, so a local build and a release build go through
 * exactly the same code path.
 *
 *   node scripts/build-installers.mjs            # installers for this machine
 *   node scripts/build-installers.mjs --win      # Windows NSIS setup .exe
 *   node scripts/build-installers.mjs --mac      # macOS .dmg
 *   node scripts/build-installers.mjs --all      # both (needs CI, see below)
 *
 * Linux packaging was dropped: the deb/rpm/AppImage targets took the longest to build
 * for the fewest users. Running the app from source on Linux still works.
 *
 * The targets themselves live in electron-builder.yml. This script's job is the part
 * a config file cannot do: refuse the combinations that cannot work on the current
 * host, keep an unsigned build from stalling on a keychain prompt, and report what
 * actually came out with checksums.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** What counts as an installer, as opposed to a build by-product. */
const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.dmg', '.pkg']);

/**
 * Files that must exist before packaging starts. Both are generated and both fail
 * quietly if missing -- a build with no sprites produces an installer that installs an
 * invisible cat -- so they are checked up front instead.
 */
const REQUIRED = [
  ['build/icon.png', 'npm run icons'],
  ['build/icon.ico', 'npm run icons'],
  ['build/icons/512x512.png', 'npm run icons'],
  ['assets/sprites/manifest.json', 'npm run assets'],
];

const USAGE = `
Usage: node scripts/build-installers.mjs [options]

Platforms (default: whichever this machine is)
  --win                 Windows installer (NSIS setup .exe, x64 + arm64)
  --mac                 macOS disk image (.dmg, Intel + Apple silicon)
  --all                 Both of the above

Options
  --arch <a>            Override the architectures: x64, arm64, armv7l, universal.
                        Repeatable. Defaults to what electron-builder.yml declares.
  --dir                 Unpacked app only, no installers. For debugging a package.
  --publish <when>      Hand the artifacts to the configured publisher:
                        never (default), onTag, onTagOrDraft, always.
  --allow-cross         Attempt a cross-platform build the host cannot support.
  -h, --help            This text.

Cross-building, in short: an installer generally has to be built on its own operating
system -- a .dmg needs macOS. That is what the GitHub Actions workflow is for: it runs
this same script once per runner and collects the results. See the Packaging section
of README.md.
`;

function fail(message, hint) {
  console.error(`\nerror  ${message}`);
  if (hint) console.error(`       ${hint}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    platforms: new Set(),
    archs: [],
    dirOnly: false,
    publish: 'never',
    allowCross: false,
    help: false,
  };

  const publishModes = ['never', 'onTag', 'onTagOrDraft', 'always'];

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
      case '--allow-cross':
        options.allowCross = true;
        break;
      case '--arch': {
        const value = argv[(i += 1)];
        if (!value) fail('--arch needs a value', 'x64, arm64, armv7l or universal');
        options.archs.push(value);
        break;
      }
      case '--publish': {
        const value = argv[(i += 1)];
        if (!publishModes.includes(value)) {
          fail(
            `--publish expects one of ${publishModes.join(', ')}`,
            `got ${value ?? '(nothing)'}`,
          );
        }
        options.publish = value;
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
    const host = { win32: 'win', darwin: 'mac' }[process.platform];
    if (!host) {
      fail(
        `nothing to build on ${process.platform}`,
        process.platform === 'linux'
          ? 'Linux packaging was removed. Run the app from source with `npm start`, ' +
              'or pass --win / --mac on a host that can build them.'
          : 'pass --win or --mac',
      );
    }
    options.platforms.add(host);
  }

  return options;
}

/**
 * Stop early on the host/target pairs that cannot work, rather than letting
 * electron-builder fail several minutes in with a tool-specific error.
 */
function checkHostSupport({ platforms, allowCross }) {
  const host = process.platform;
  const problems = [];
  const warnings = [];

  if (platforms.has('mac') && host !== 'darwin') {
    problems.push(
      'Building a macOS .dmg requires macOS: the disk image is assembled with ' +
        "hdiutil, and code signing needs Apple's tooling.",
    );
  }
  if (platforms.has('win') && host !== 'win32') {
    warnings.push(
      'Building the Windows installer off Windows needs Wine on PATH, and the ' +
        'result cannot be code signed.',
    );
  }

  for (const warning of warnings) console.warn(`warn   ${warning}`);

  if (problems.length === 0) return;
  if (allowCross) {
    for (const problem of problems) console.warn(`warn   ${problem} (--allow-cross)`);
    return;
  }
  fail(
    `cannot build these installers on ${host}:\n       - ${problems.join(
      '\n       - ',
    )}`,
    'Push a tag and let .github/workflows/release.yml build both, or pass ' +
      '--allow-cross to try anyway.',
  );
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
    fail(
      `missing files the installers need:\n       - ${missing.join('\n       - ')}`,
    );
  }
}

/**
 * Without this, a machine with no signing certificate still gets searched for one.
 * On macOS that means electron-builder rummaging through the keychain and failing on
 * an identity it cannot use; in CI it is just a slow way to reach the same place. Set
 * CSC_LINK (or CSC_NAME) to sign for real and this gets out of the way.
 */
function configureSigning() {
  const hasCertificate = Boolean(
    process.env.CSC_LINK || process.env.CSC_NAME || process.env.WIN_CSC_LINK,
  );
  if (hasCertificate || process.env.CSC_IDENTITY_AUTO_DISCOVERY) return false;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return true;
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

async function describe(artifacts) {
  const installers = artifacts
    .filter((file) => INSTALLER_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();

  return Promise.all(
    installers.map(async (file) => ({
      name: path.basename(file),
      bytes: (await fs.stat(file)).size,
      sha256: await sha256(file),
    })),
  );
}

/**
 * A checksum file per platform, not one shared file: the CI jobs run on separate
 * machines and their outputs are only ever brought together afterwards, so a single
 * name would just overwrite itself.
 */
async function writeManifest(version, files) {
  const suffix = { win32: 'windows', darwin: 'macos' }[process.platform];

  const manifest = path.join(DIST, `installers-${suffix}.json`);
  await fs.writeFile(
    manifest,
    `${JSON.stringify(
      { product: 'desktop-cat', version, builtOn: suffix, files },
      null,
      2,
    )}\n`,
  );

  const sums = path.join(DIST, `SHA256SUMS-${suffix}.txt`);
  await fs.writeFile(
    sums,
    files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n',
  );

  return [manifest, sums];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE.trim());
    return;
  }

  const { version } = JSON.parse(
    await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'),
  );

  checkHostSupport(options);
  await checkRequiredFiles();
  if (configureSigning()) {
    console.log('note   no signing certificate configured; building unsigned');
  }

  let electronBuilder;
  try {
    electronBuilder = await import('electron-builder');
  } catch {
    fail('electron-builder is not installed', 'run: npm install');
  }
  const { build, Platform, Arch } = electronBuilder;

  const archs = options.archs.map((name) => {
    const arch = Arch[name];
    if (arch === undefined) {
      fail(`unknown architecture ${name}`, `expected one of ${Object.keys(Arch)
        .filter((key) => Number.isNaN(Number(key)))
        .join(', ')}`);
    }
    return arch;
  });

  const platformKeys = { win: Platform.WINDOWS, mac: Platform.MAC };
  // An empty arch map means "whatever electron-builder.yml says", which is the case
  // we want by default. Only an explicit --arch narrows it.
  const targets = new Map();
  for (const key of options.platforms) {
    const platform = platformKeys[key];
    const target = platform.createTarget(
      options.dirOnly ? 'dir' : null,
      ...(archs.length > 0 ? archs : []),
    );
    for (const [resolved, archToType] of target) targets.set(resolved, archToType);
  }

  console.log(
    `\nbuilding desktop-cat ${version} for ${[...options.platforms].join(', ')}` +
      ` on ${process.platform}${options.dirOnly ? ' (unpacked only)' : ''}\n`,
  );

  const artifacts = await build({
    targets,
    publish: options.publish,
    projectDir: ROOT,
  });

  if (options.dirOnly) {
    console.log('\nunpacked app written to dist/ -- no installers were built.');
    return;
  }

  const files = await describe(artifacts);
  if (files.length === 0) {
    fail(
      'the build finished but produced no installers',
      'check the electron-builder output above for skipped targets',
    );
  }

  const written = await writeManifest(version, files);
  const width = Math.max(...files.map((file) => file.name.length));

  console.log(`\ninstallers in ${path.relative(process.cwd(), DIST) || 'dist'}/\n`);
  for (const file of files) {
    console.log(
      `  ${file.name.padEnd(width)}  ${formatSize(file.bytes).padStart(9)}` +
        `  sha256:${file.sha256.slice(0, 12)}`,
    );
  }
  console.log(
    `\n${files.length} installer${files.length === 1 ? '' : 's'}; checksums in ` +
      written.map((file) => path.basename(file)).join(' and '),
  );
}

main().catch((error) => {
  console.error(`\n${error?.stack || error}`);
  process.exit(1);
});
