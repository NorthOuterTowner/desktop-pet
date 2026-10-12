#!/usr/bin/env node
/**
 * electron-builder afterPack hook: deletes the parts of the Electron runtime this app
 * cannot reach, before the installer is assembled.
 *
 * Electron ships a whole browser and most of it is load-bearing -- but not all of it.
 * The renderer draws the cat onto a 2D canvas and never asks for a GPU device, so the
 * Direct3D shader toolchain is dead weight: ~26 MB in every Windows install for code
 * that only ever loads when a page uses WebGPU.
 *
 * Deliberately *not* deleted, to save the next person the experiment:
 *
 *   LICENSES.chromium.html   19 MB of licence text that Chromium's own terms expect to
 *                            travel with the binary. It is text, so it compresses to
 *                            about a tenth of that in the installer -- it costs disk
 *                            space, not download size.
 *   d3dcompiler_47.dll       ANGLE compiles its shaders with this, and the 2D canvas is
 *                            accelerated through ANGLE.
 *   vk_swiftshader.dll,      The software renderer. Only used where the GPU is
 *   vulkan-1.dll             unavailable or blacklisted -- VMs, remote desktops, old
 *                            drivers -- which is exactly where a transparent,
 *                            click-through window is already on thin ice.
 *   ffmpeg.dll               Electron links against it and will not start without it.
 *
 * The Chromium locale files are trimmed separately, by electronLanguages in
 * electron-builder.yml.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Runtime files that are safe to drop, keyed by Electron's platform name. */
const DROPPABLE = {
  // The DXC toolchain: compiles and signs HLSL for WebGPU/Dawn. Nothing else loads it.
  win32: ['dxcompiler.dll', 'dxil.dll'],
  // Those compilers are a Windows thing. Nothing in the mac or Linux runtime is
  // provably unreachable enough to be worth the risk of removing it.
  darwin: [],
  linux: [],
};

const MB = 1024 * 1024;

export default async function afterPack({ appOutDir, electronPlatformName }) {
  const candidates = DROPPABLE[electronPlatformName] ?? [];
  if (candidates.length === 0) return;

  const removed = [];
  const missing = [];
  let freed = 0;

  for (const name of candidates) {
    const file = path.join(appOutDir, name);
    let size;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      missing.push(name);
      continue;
    }
    await fs.rm(file, { force: true });
    removed.push(name);
    freed += size;
  }

  // Not fatal, but it means this list has gone stale against a newer Electron and the
  // build is quietly carrying weight again.
  if (missing.length > 0) {
    console.warn(`  • afterPack      nothing to remove, file is gone: ${missing.join(', ')}`);
  }
  if (removed.length > 0) {
    console.log(
      `  • afterPack      dropped ${removed.join(', ')}` +
        `  freed=${(freed / MB).toFixed(1)} MB`,
    );
  }
}
