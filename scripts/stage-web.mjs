#!/usr/bin/env node
/**
 * Stages the page for Tauri into .web/.
 *
 * Tauri embeds one directory as the app's front end (`build.frontendDist` in
 * src-tauri/tauri.conf.json), but the page is spread across four: src/ for the code,
 * assets/sprites/ for the frames, assets/audio/ for the sounds, icons/ for the heart
 * and the fish. Pointing Tauri at the repository root would embed everything -- the
 * 55 MB of raw art, node_modules, the Rust build output -- so these are copied side
 * by side instead, keeping the layout the page's relative URLs
 * (`../assets/sprites/`, `../assets/audio/`, `../icons/`) already expect.
 *
 * Runs as Tauri's beforeDevCommand and beforeBuildCommand, so `npm start` and every
 * build stage it automatically. Run it by hand only before a bare `cargo build`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.web');

/** [what to copy, and how to regenerate it if it is missing] */
const PARTS = [
  ['src', null],
  ['assets/sprites', 'npm run assets'],
  ['assets/audio', null],
  ['icons', 'npm run treat'],
];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// A page with no sprites boots into an invisible cat, which is a confusing way to
// find out the pipeline was never run. Fail loudly instead.
if (!(await exists(path.join(ROOT, 'assets', 'sprites', 'manifest.json')))) {
  console.error('stage-web: assets/sprites/manifest.json is missing -- run: npm run assets');
  process.exit(1);
}

await fs.rm(OUT, { recursive: true, force: true });

let files = 0;
for (const [part, hint] of PARTS) {
  const from = path.join(ROOT, part);
  if (!(await exists(from))) {
    console.error(`stage-web: ${part}/ is missing${hint ? ` -- run: ${hint}` : ''}`);
    process.exit(1);
  }
  await fs.cp(from, path.join(OUT, part), { recursive: true });
  const entries = await fs.readdir(from, { recursive: true, withFileTypes: true });
  files += entries.filter((entry) => entry.isFile()).length;
}

console.log(`stage-web: ${files} files -> ${path.relative(process.cwd(), OUT) || '.web'}`);
