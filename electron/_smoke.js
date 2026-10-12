'use strict';

// Temporary diagnostic: boots the real window, forwards renderer console output,
// captures what it actually paints, then quits. Run with CAT_SMOKE=1.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'rsrc', '_check', 'electron');

function attach({ win, stageBounds, command, isGrabbingMouse }) {
  const log = [];

  win.webContents.on('console-message', (event) => {
    const line = `[renderer:${event.level}] ${event.message}`;
    log.push(line);
    console.log(line);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`DID-FAIL-LOAD ${code} ${desc} ${url}`);
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    console.log(`PRELOAD-ERROR ${file}: ${err}`);
  });

  win.webContents.once('did-finish-load', async () => {
    fs.mkdirSync(OUT, { recursive: true });
    console.log('stage bounds:', JSON.stringify(stageBounds()));

    const shots = [];
    const probe = async (label) => {
      const state = await win.webContents.executeJavaScript(
        `(() => {
           const el = document.getElementById('cat');
           const err = document.getElementById('error');
           const brain = window.__catDebug && window.__catDebug.brain;
           return JSON.stringify({
             action: brain ? brain.action : null,
             x: brain ? Math.round(brain.x) : null,
             y: brain ? Math.round(brain.y) : null,
             energy: brain ? +brain.energy.toFixed(3) : null,
             canvas: el.width + 'x' + el.height,
             bottom: el.style.bottom,
             transform: el.style.transform,
             hearts: document.querySelectorAll('.heart').length,
             error: err.hidden ? null : err.textContent,
           });
         })()`
      );
      console.log(`${label}: ${state}`);
      const image = await win.webContents.capturePage();
      shots.push(image);
    };

    try {
      await probe('t+0.5s');
      await new Promise((r) => setTimeout(r, 1200));
      await probe('t+1.7s');

      // ---- hit test, checked directly --------------------------------------------
      //
      // Not driven by synthetic mouse moves. The window runs with
      // `setIgnoreMouseEvents(true, { forward: true })`, so the renderer keeps
      // receiving the *real* cursor's moves; whichever mousemove lands last before the
      // frame loop samples it wins. Probing via the cursor therefore gives a different
      // answer depending on where the user's physical mouse happens to be, which makes
      // the result meaningless as a check. `overCatAt` is the exact lookup the frame
      // loop uses, so calling it straight tests the real thing deterministically.
      const box = JSON.parse(
        await win.webContents.executeJavaScript(
          `(() => {
             const r = document.getElementById('cat').getBoundingClientRect();
             return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
           })()`
        )
      );
      const hitAt = (x, y) =>
        win.webContents.executeJavaScript(
          `window.__catDebug.overCatAt(${x}, ${y})`
        );

      let target = null;
      for (const fy of [0.55, 0.65, 0.75, 0.45, 0.85, 0.35]) {
        const point = {
          x: Math.round(box.x + box.w / 2),
          y: Math.round(box.y + box.h * fy),
        };
        if (await hitAt(point.x, point.y)) {
          target = point;
          console.log(`hit test: opaque at y-offset ${fy} -> ${JSON.stringify(point)}`);
          break;
        }
      }
      console.log(`hit test: body centre found=${!!target} (want true)`);

      // Each corner of the canvas is transparent padding around the sprite. If these
      // registered, the hit test would effectively be the bounding box and the cat
      // would steal clicks from the desktop around itself.
      const corners = [
        ['top-left', box.x + 3, box.y + 3],
        ['top-right', box.x + box.w - 3, box.y + 3],
        ['bottom-left', box.x + 3, box.y + box.h - 3],
      ];
      for (const [label, cx, cy] of corners) {
        const hit = await hitAt(Math.round(cx), Math.round(cy));
        console.log(`hit test: ${label} corner=${hit} (want false)`);
      }
      // Outside the canvas entirely.
      console.log(
        `hit test: far left of window=${await hitAt(Math.round(box.x) - 200, Math.round(box.y + box.h / 2))} (want false)`
      );

      // ---- click path, driven through a real input event ---------------------------
      //
      // Deliberately not `brain.poke()`: the interesting part of a click is the
      // mousedown and mouseup listeners and the click-versus-drag split, which poke()
      // skips entirely.
      let clicked = false;
      if (target) {
        for (let attempt = 1; attempt <= 3 && !clicked; attempt += 1) {
          win.webContents.sendInputEvent({ type: 'mouseMove', ...target });
          await new Promise((r) => setTimeout(r, 120));

          const before = await win.webContents.executeJavaScript(
            `window.__catDebug.brain.action`
          );
          win.webContents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 200));
          const after = JSON.parse(
            await win.webContents.executeJavaScript(
              `JSON.stringify({
                 action: window.__catDebug.brain.action,
                 queued: window.__catDebug.brain.queue.map((s) => s.action),
                 hearts: document.querySelectorAll('.heart').length,
               })`
            )
          );
          const reacting =
            after.action === 'head_tilt' || after.queued.includes('head_tilt');
          if (reacting && after.hearts > 0) {
            clicked = true;
            console.log(
              `click: real mousedown on the cat (was '${before}') -> ` +
                `action='${after.action}' queued=[${after.queued}] hearts=${after.hearts}`
            );
          }
        }
        console.log(`click: head tilt + heart from a real click=${clicked} (want true)`);
      }

      await probe('after real click');
      await new Promise((r) => setTimeout(r, 400));
      await probe('click +0.65s');

      // The heart has to actually leave: it floats up and removes itself on
      // animationend. One that never cleared would pile up over a session. Move the
      // synthetic cursor off the cat first so a stray click cannot add more.
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(box.x) - 200,
        y: Math.round(box.y + box.h / 2),
      });
      await new Promise((r) => setTimeout(r, 1600));
      const hearts = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.heart').length`
      );
      console.log(`hearts remaining after float-up: ${hearts} (want 0)`);

      // ---- cross-fade must not make the cat translucent ---------------------------
      //
      // Regression guard. Cross-fading by drawing the outgoing frame at `1 - t` and
      // the incoming one at `t` is only alpha-correct over an opaque background; on
      // this transparent window it dipped the cat's peak alpha to ~0.75 for the length
      // of every fade, which showed up as the whole cat flickering against the desktop
      // every couple of seconds. Sampled across a forced action change: the peak alpha
      // on the canvas has to stay solid the whole way through.
      const peak = await win.webContents.executeJavaScript(
        `new Promise((resolve) => {
           const cat = document.getElementById('cat');
           const c = cat.getContext('2d');
           let lowest = 255;
           let frames = 0;
           window.__catDebug.brain.poke();  // forces an action change -> cross-fade
           const sample = () => {
             const d = c.getImageData(0, 0, cat.width, cat.height).data;
             let maxA = 0;
             for (let i = 3; i < d.length; i += 4) if (d[i] > maxA) maxA = d[i];
             if (maxA < lowest) lowest = maxA;
             frames += 1;
             if (frames < 24) requestAnimationFrame(sample);
             else resolve(lowest);
           };
           requestAnimationFrame(sample);
         })`
      );
      console.log(
        `cross-fade: lowest peak alpha during an action change = ${peak}/255 ` +
          `(want 255, the old blend bottomed out near 191)`
      );

      // Force a walk so the walking frames and movement get covered.
      command('walk');
      for (const t of [900, 900, 900, 900]) {
        await new Promise((r) => setTimeout(r, t));
        await probe('walking');
      }

      // ---- picked up, dropped, and landing ----------------------------------------
      //
      // Physics driven straight through the brain. The mousedown wiring is covered by
      // the click check above; what matters here is that a released cat actually
      // falls to the floor and lands, rather than sticking in mid-air.
      const lift = Math.round(box.h * 3);
      const fall = JSON.parse(
        await win.webContents.executeJavaScript(
          `(() => {
             const b = window.__catDebug.brain;
             b.grab();
             b.carryTo(b.x, ${lift});
             return JSON.stringify({ held: b.held, action: b.action, y: Math.round(b.y) });
           })()`
        )
      );
      console.log(
        `drag: grabbed and carried to y=${fall.y} -> held=${fall.held} ` +
          `action='${fall.action}' (want held=true action='held')`
      );
      await probe('held aloft');

      const landing = JSON.parse(
        await win.webContents.executeJavaScript(
          `new Promise((resolve) => {
             const b = window.__catDebug.brain;
             const seen = [];
             let heights = [];
             b.release();
             const watch = () => {
               heights.push(Math.round(b.y));
               if (seen[seen.length - 1] !== b.action) seen.push(b.action);
               if (b.falling || b.y > 0) return requestAnimationFrame(watch);
               resolve(JSON.stringify({
                 landedY: Math.round(b.y),
                 topHeight: Math.max.apply(null, heights),
                 samples: heights.length,
                 monotonic: heights.every((h, i) => i === 0 || h <= heights[i - 1]),
                 actions: seen,
                 after: b.action,
                 queued: b.queue.map((s) => s.action),
               }));
             };
             requestAnimationFrame(watch);
           })`
        )
      );
      console.log(
        `drop: fell from ${landing.topHeight}px to y=${landing.landedY} over ` +
          `${landing.samples} frames, descent monotonic=${landing.monotonic}`
      );
      console.log(
        `drop: landed into '${landing.after}' queued=[${landing.queued}] ` +
          `(want startle, then face_front_from_left -> sit_down -> sit)`
      );
      await probe('just landed');
      await new Promise((r) => setTimeout(r, 500));
      await probe('startling');

      // ---- the pet must not hold the mouse when it is not being touched -----------
      //
      // This window covers the whole work area, so a stuck "interactive" state would
      // swallow every click on the desktop. Asserted against the main process's own
      // view of the window, not the renderer's.
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(box.x) - 300,
        y: Math.round(box.y),
      });
      await new Promise((r) => setTimeout(r, 300));
      console.log(
        `click-through: main process holding mouse with cursor away from cat = ` +
          `${isGrabbingMouse()} (want false)`
      );

      // The preload bridge is the only path between the page and the main process, so
      // a missing method silently disables a whole feature. The right-click menu is a
      // native popup and cannot be driven from here, so this is the automated half of
      // that check; opening it has to be confirmed by hand.
      const bridge = JSON.parse(
        await win.webContents.executeJavaScript(
          `JSON.stringify(Object.fromEntries(
             ['stage','setInteractive','heartbeat','openMenu','onCommand','onResized']
               .map((k) => [k, typeof window.pet[k]])
           ))`
        )
      );
      const missing = Object.entries(bridge)
        .filter(([, type]) => type !== 'function')
        .map(([name]) => name);
      console.log(
        `bridge: ${missing.length ? 'MISSING ' + missing.join(', ') : 'all 6 methods present'}`
      );

      shots.forEach((img, i) => {
        fs.writeFileSync(path.join(OUT, `shot_${i}.png`), img.toPNG());
      });
      fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'), 'utf-8');
      console.log(`wrote ${shots.length} screenshots to ${OUT}`);
    } catch (err) {
      console.log('SMOKE FAILED:', err && err.stack ? err.stack : err);
    }
    app.quit();
  });
}

module.exports = { attach };
