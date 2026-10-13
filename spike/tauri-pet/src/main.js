// The renderer half of the spike. Stands in for src/renderer.js, and keeps the one
// piece of it that matters here: the per-pixel hit test and the decision to take the
// mouse. In the Electron app that decision runs off forwarded mousemove events; here
// the positions arrive from Rust's cursor poll instead, and every `set_interactive`
// is timed, because that round trip is the part Electron did not have.

const api = window.__TAURI__;
const invoke = api.core ? api.core.invoke : api.invoke;
const listen = api.event.listen;

const catEl = document.getElementById('cat');
const ctx = catEl.getContext('2d', { willReadFrequently: true });
const hudEl = document.getElementById('hud');

let stage = null;
let interactive = false;
let hit = false;
let clicks = 0;
let toggles = 0;
let events = 0;
let lastCursor = { x: 0, y: 0 };

// Round-trip samples for the `set_interactive` call, kept as a window so the p95
// reflects recent behaviour rather than the whole session.
const invokeSamples = [];
let eventWindowStart = performance.now();
let eventWindowCount = 0;
let rate = 0;

function drawCat() {
  const size = catEl.width;
  ctx.clearRect(0, 0, size, size);

  // A disc inset from the canvas edge: the corners stay fully transparent, which is
  // what makes a bounding-box hit test visibly wrong.
  const r = size * 0.375;
  const gradient = ctx.createRadialGradient(size / 2, size * 0.38, r * 0.2, size / 2, size / 2, r);
  gradient.addColorStop(0, '#f6d9a0');
  gradient.addColorStop(1, '#9d7b4f');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#2b2118';
  for (const dx of [-0.13, 0.13]) {
    ctx.beginPath();
    ctx.arc(size / 2 + size * dx, size * 0.46, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The same question `overCatAt` answers in the real renderer. */
function overCatAt(windowX, windowY) {
  if (!stage) return false;
  const x = Math.round(windowX - stage.catLeft);
  const y = Math.round(windowY - (stage.height - stage.cat));
  if (x < 0 || y < 0 || x >= catEl.width || y >= catEl.height) return false;
  return ctx.getImageData(x, y, 1, 1).data[3] > 10;
}

async function setInteractive(next) {
  const started = performance.now();
  await invoke('set_interactive', { interactive: next });
  const elapsed = performance.now() - started;
  invokeSamples.push(elapsed);
  if (invokeSamples.length > 120) invokeSamples.shift();
  toggles += 1;
  interactive = next;
  document.body.classList.toggle('over-cat', next);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function hud() {
  hudEl.textContent = [
    `cursor      ${lastCursor.x.toFixed(0)}, ${lastCursor.y.toFixed(0)}`,
    `over cat    ${hit}`,
    `interactive ${interactive}`,
    `events      ${events} (${rate.toFixed(0)}/s)`,
    `toggles     ${toggles}`,
    `invoke      avg ${average(invokeSamples).toFixed(1)} ms  p95 ${percentile(invokeSamples, 0.95).toFixed(1)} ms`,
    `clicks      ${clicks}`,
  ].join('\n');
}

async function main() {
  stage = await invoke('stage');
  catEl.style.left = `${stage.catLeft}px`;
  drawCat();
  await invoke('log', {
    line: `stage ${stage.width}x${stage.height} @${stage.scale}, cat ${stage.cat} at left ${stage.catLeft}`,
  });

  await listen('cursor', async (event) => {
    const { x, y } = event.payload;
    lastCursor = { x, y };
    events += 1;
    eventWindowCount += 1;

    const now = performance.now();
    if (now - eventWindowStart >= 1000) {
      rate = (eventWindowCount * 1000) / (now - eventWindowStart);
      eventWindowStart = now;
      eventWindowCount = 0;
    }

    const over = overCatAt(x, y);
    if (over !== hit) {
      hit = over;
      await setInteractive(over);
      await invoke('log', { line: `${over ? 'took' : 'released'} the mouse at ${x.toFixed(0)},${y.toFixed(0)}` });
    }
    hud();
  });

  // Proof that clicks land on the cat when the window has the mouse, and that they
  // do not when it does not: this counter only ever moves if the click reached us.
  document.addEventListener('mousedown', () => {
    clicks += 1;
    invoke('log', { line: `click reached the renderer (total ${clicks})` });
    hud();
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (overCatAt(event.clientX, event.clientY)) invoke('open_menu');
  });

  // The channel the Rust self-test reads. 10/s is enough for it and cheap enough to
  // leave running.
  setInterval(() => {
    invoke('report', {
      report: {
        hit,
        interactive,
        events,
        rate,
        invokeAvg: average(invokeSamples),
        invokeP95: percentile(invokeSamples, 0.95),
        toggles,
        clicks,
      },
    });
  }, 100);

  hud();
}

main().catch(async (error) => {
  hudEl.textContent = `renderer failed: ${error}`;
  try {
    await invoke('log', { line: `FAILED ${error}` });
  } catch {
    /* nothing left to report through */
  }
});
