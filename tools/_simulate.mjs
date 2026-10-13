// Steps the brain without a display and sanity-checks the behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from '../src/behavior.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'assets/sprites/manifest.json'), 'utf-8')
);

const clips = {};
for (const [name, spec] of Object.entries(manifest.actions)) {
  clips[name] = {
    name,
    loop: spec.loop,
    fps: spec.fps,
    frames: spec.frames,
    seconds: spec.frames.length / spec.fps,
  };
}

// Deterministic RNG so a failure is reproducible.
let seed = 12345;
const rng = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// Derived the same way the renderer does it, so this does not drift when the art
// changes. Keep TARGET_SIT_HEIGHT and WALK_SPEED in step with src/renderer.js.
const TARGET_SIT_HEIGHT = 124;
const WALK_SPEED = 51;
const CAT = Math.round((TARGET_SIT_HEIGHT * manifest.canvas) / manifest.sitHeight);
const MIN_X = 0;
const MAX_X = 1536 - CAT; // a 1536px work area
const dt = 1 / 60;

console.log(`cat render box ${CAT}px (sit drawn ${manifest.sitHeight}/${manifest.canvas})`);

const brain = new Brain({
  clips,
  minX: MIN_X,
  maxX: MAX_X,
  walkSpeed: WALK_SPEED,
  rng,
});

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
  return ok;
};

// ---- a long unattended run ------------------------------------------------------------

const MINUTES = 60;
const steps = Math.round((MINUTES * 60) / dt);

const time = {};
const transitions = [];
let prev = brain.action;
let blinks = 0;
let lastBlinkAt = 0;
const blinkGaps = [];
let minX = Infinity;
let maxX = -Infinity;

for (let i = 0; i < steps; i += 1) {
  brain.update(dt);
  const t = i * dt;

  if (!clips[brain.action]) throw new Error(`unknown action at t=${t}: ${brain.action}`);
  if (brain.x < MIN_X - 1e-6 || brain.x > MAX_X + 1e-6) {
    throw new Error(`x out of bounds at t=${t.toFixed(1)}: ${brain.x}`);
  }
  if (brain.energy < -1e-9 || brain.energy > 1 + 1e-9) {
    throw new Error(`energy out of range at t=${t.toFixed(1)}: ${brain.energy}`);
  }
  // Nothing the cat does on its own should lift it off the floor.
  if (brain.y !== 0) {
    throw new Error(`left the floor unprompted at t=${t.toFixed(1)}: y=${brain.y}`);
  }

  time[brain.action] = (time[brain.action] ?? 0) + dt;
  minX = Math.min(minX, brain.x);
  maxX = Math.max(maxX, brain.x);

  if (brain.action !== prev) {
    transitions.push([prev, brain.action]);
    if (brain.action === 'blink') {
      blinks += 1;
      if (lastBlinkAt) blinkGaps.push(t - lastBlinkAt);
      lastBlinkAt = t;
    }
    prev = brain.action;
  }
}

console.log(`simulated ${MINUTES} min at ${Math.round(1 / dt)}Hz, no invalid state`);
console.log(`x spanned ${minX.toFixed(0)} .. ${maxX.toFixed(0)} (bounds ${MIN_X}..${MAX_X})`);
console.log(`final energy ${brain.energy.toFixed(3)}`);
console.log(`${transitions.length} action changes`);

const avgGap = blinkGaps.reduce((a, b) => a + b, 0) / (blinkGaps.length || 1);
console.log(
  `\nblinks: ${blinks}, mean gap ${avgGap.toFixed(1)}s ` +
    `(min ${Math.min(...blinkGaps).toFixed(1)}s, max ${Math.max(...blinkGaps).toFixed(1)}s)`
);

console.log('\ntime budget:');
const total = Object.values(time).reduce((a, b) => a + b, 0);
for (const [name, seconds] of Object.entries(time).sort((a, b) => b[1] - a[1])) {
  const pct = ((100 * seconds) / total).toFixed(1).padStart(5);
  console.log(`  ${name.padEnd(22)} ${pct}%  ${seconds.toFixed(0)}s`);
}

// `held` and `startle` are reachable only by picking the cat up, so they must never
// show up in an unattended run. Everything else should.
const unused = Object.keys(clips).filter((name) => !(name in time));
console.log(`\nnever played unattended: ${unused.length ? unused.join(', ') : '(none)'}`);
check(
  !('held' in time) && !('startle' in time),
  'held/startle played without the cat being picked up'
);

// Actions that only exist as a response to something the user did: picking the cat
// up, or feeding it. None of them may turn up in an unattended run -- a cat that
// chews on its own has found food nobody gave it.
const FEEDING = ['feed_open', 'feed_wait', 'feed_close', 'chew', 'swallow'];
const PROMPTED_ONLY = new Set(['held', 'startle', 'head_tilt', ...FEEDING]);
const fedItself = FEEDING.filter((name) => name in time);
check(fedItself.length === 0, `the cat fed itself unattended: ${fedItself.join(', ')}`);
check(
  unused.every((name) => PROMPTED_ONLY.has(name)),
  `unreachable actions in the build: ${unused.filter((n) => !PROMPTED_ONLY.has(n)).join(', ')}`
);

// Check the sequences the requirements call for actually occur in order.
const chain = transitions.map(([, to]) => to).join(' ');
const expectations = {
  'sit -> blink': /blink/,
  'stand up then turn then walk': /stand_up stand (turn_left walk_left|turn_right walk_right)/,
  'turn around at a screen edge':
    /walk_left face_front_from_left turn_right walk_right|walk_right face_front_from_right turn_left walk_left/,
  'walk then face front then sit down':
    /(walk_left face_front_from_left|walk_right face_front_from_right) sit_down/,
  'lie down then sleep': /lie_down sleep/,
  'wake then stretch': /wake_up stretch/,
  'waves now and then': /wave/,
};
console.log('\nrequired sequences:');
for (const [label, re] of Object.entries(expectations)) {
  const ok = re.test(chain);
  check(ok, `sequence never occurred: ${label}`);
  console.log(`  ${ok ? 'yes' : 'NO '}  ${label}`);
}

// ---- commands -------------------------------------------------------------------------

const settle = (seconds) => {
  const seen = [];
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    brain.update(dt);
    if (seen[seen.length - 1] !== brain.action) seen.push(brain.action);
  }
  return seen;
};

brain.command('sleep');
settle(30);
console.log(`\nafter 'sleep' command + 30s: ${brain.action} (asleep=${brain.asleep})`);
check(brain.asleep, "'sleep' command did not put the cat to sleep");

brain.poke();
console.log(`poke while asleep -> ${settle(12).join(' -> ')}`);

// ---- picked up, carried, dropped ------------------------------------------------------

console.log('\n--- drag and drop ---');
brain.grab();
check(brain.held, 'grab() did not set held');
check(brain.action === 'held', `grab() played '${brain.action}' instead of 'held'`);

const LIFT = 480;
brain.carryTo(600, LIFT);
check(brain.y === LIFT, `carryTo did not lift the cat: y=${brain.y}`);
console.log(`grabbed and carried: action='${brain.action}' x=${brain.x} y=${brain.y}`);

// Carried out of bounds must be clamped, or the cat could be parked off-screen.
brain.carryTo(MAX_X + 500, LIFT);
check(brain.x === MAX_X, `carryTo past the right edge was not clamped: x=${brain.x}`);
brain.carryTo(-500, LIFT);
check(brain.x === MIN_X, `carryTo past the left edge was not clamped: x=${brain.x}`);
brain.carryTo(600, -80);
check(brain.y === 0, `carryTo below the floor was not clamped: y=${brain.y}`);

// Held means held: time passing must not move it.
brain.carryTo(600, LIFT);
const heldPos = { x: brain.x, y: brain.y };
settle(2);
check(
  brain.x === heldPos.x && brain.y === heldPos.y,
  `a held cat drifted: ${JSON.stringify({ x: brain.x, y: brain.y })}`
);
check(brain.action === 'held', `a held cat changed action to '${brain.action}'`);
console.log(`held for 2s without drifting or changing pose`);

// Drop it.
brain.release();
check(brain.falling, 'release() did not start a fall');
let fallTime = 0;
let lastY = brain.y;
let monotonic = true;
while ((brain.falling || brain.y > 0) && fallTime < 5) {
  brain.update(dt);
  fallTime += dt;
  if (brain.y > lastY + 1e-9) monotonic = false;
  lastY = brain.y;
}
console.log(
  `dropped from ${LIFT}px: landed in ${fallTime.toFixed(2)}s, y=${brain.y}, ` +
    `descent monotonic=${monotonic}`
);
check(brain.y === 0, `did not land on the floor: y=${brain.y}`);
check(!brain.falling, 'still falling after landing');
check(monotonic, 'the cat moved upwards while falling');
check(fallTime > 0.1 && fallTime < 2, `fall took an implausible ${fallTime.toFixed(2)}s`);

const afterLanding = settle(4);
console.log(`after landing -> ${afterLanding.join(' -> ')}`);
check(
  brain.action === 'startle' || afterLanding.includes('startle'),
  `no startle on landing, got ${afterLanding.join(' -> ')}`
);

// A drop from floor level should still startle, without a fall.
settle(6);
brain.grab();
brain.release();
check(!brain.falling, 'a drop from floor level started a fall');
const afterNudge = settle(3);
check(
  afterNudge.includes('startle') || brain.action === 'startle',
  `dropping from floor level did not startle: ${afterNudge.join(' -> ')}`
);
console.log(`dropped from floor level -> ${afterNudge.slice(0, 4).join(' -> ')}`);

// ---- come here ------------------------------------------------------------------------

console.log('\n--- come here ---');
settle(8);
for (const target of [120, 1200, 640]) {
  brain.command('come', { x: target });
  let waited = 0;
  while (waited < 30 && Math.abs(brain.x - target) > 1) {
    brain.update(dt);
    waited += dt;
  }
  const arrived = Math.abs(brain.x - target) <= 1;
  check(arrived, `come here never reached ${target}, stopped at ${brain.x.toFixed(0)}`);
  console.log(
    `  come to ${target}: ${arrived ? 'arrived' : 'STOPPED'} at ` +
      `${brain.x.toFixed(0)} after ${waited.toFixed(1)}s`
  );
  settle(4);
}

// ---- pause ----------------------------------------------------------------------------

console.log('\n--- pause ---');
brain.command('walk');
settle(2);
brain.command('pause');
const frozen = {
  action: brain.action,
  x: brain.x,
  elapsed: brain.elapsed,
  energy: brain.energy,
};
settle(5);
const stillFrozen =
  brain.action === frozen.action &&
  brain.x === frozen.x &&
  brain.elapsed === frozen.elapsed &&
  brain.energy === frozen.energy;
check(stillFrozen, 'paused cat kept changing');
console.log(`paused on '${frozen.action}': unchanged after 5s = ${stillFrozen}`);

// Paused must still not trap a cat in mid-air.
brain.grab();
brain.carryTo(brain.x, 300);
brain.release();
let pausedFall = 0;
while ((brain.falling || brain.y > 0) && pausedFall < 5) {
  brain.update(dt);
  pausedFall += dt;
}
check(brain.y === 0, `a cat dropped while paused hung in the air at y=${brain.y}`);
console.log(`dropped while paused: still landed, in ${pausedFall.toFixed(2)}s`);

brain.command('resume');
const resumed = settle(4);
check(resumed.length > 1, 'resume did not get the cat moving again');
console.log(`resumed -> ${resumed.slice(0, 5).join(' -> ')}`);

// ---- feeding --------------------------------------------------------------------------
//
// Two paths, and they differ in one way that matters: a fish from the menu is eaten
// on arrival, while a dragged file has to wait with the cat's mouth open for as long
// as it takes the user to answer the confirmation -- and must give up eventually if
// nobody ever does.

console.log('\n--- feeding ---');
settle(6);

// A fish from the menu, dropped well away from the cat.
const TREAT_AT = 300;
brain.command('come', { x: 900 });
settle(14);
brain.command('feed', { x: TREAT_AT });
check(brain.offer !== null, "'feed' did not create an offer");
const meal = settle(26);
console.log(`  fish at ${TREAT_AT}: ${meal.join(' -> ')}`);
check(meal.includes('feed_open'), `the cat never opened its mouth: ${meal.join(' -> ')}`);
check(meal.includes('chew'), `the cat never chewed: ${meal.join(' -> ')}`);
check(meal.includes('swallow'), `the cat never swallowed: ${meal.join(' -> ')}`);
check(
  meal.indexOf('feed_open') < meal.indexOf('chew') &&
    meal.indexOf('chew') < meal.indexOf('swallow'),
  `the meal played out of order: ${meal.join(' -> ')}`
);
check(
  Math.abs(brain.x - TREAT_AT) < 40,
  `the cat ate from ${brain.x.toFixed(0)} instead of walking to ${TREAT_AT}`
);
check(brain.offer === null, 'the offer outlived the meal');
check(brain.action === 'sit' || brain.queue.length > 0, `stuck on '${brain.action}'`);

// A file hovering over the cat: mouth open, and it stays open.
settle(5);
brain.command('offer', { x: brain.x });
settle(1.2);
check(brain.action === 'feed_wait', `hovering a file gave '${brain.action}'`);
const waited = settle(8);
check(
  waited.length === 1 && waited[0] === 'feed_wait',
  `the cat did not hold its mouth open: ${waited.join(' -> ')}`
);
console.log(`  hovering a file: held 'feed_wait' for 8s`);

// The drag jiggling about must not restart the approach.
const beforeJiggle = brain.seq;
for (let i = 0; i < 40; i += 1) {
  brain.command('offer', { x: brain.x + (i % 5) - 2 });
  settle(0.05);
}
check(
  brain.seq === beforeJiggle && brain.action === 'feed_wait',
  `a jiggling drag restarted the chain ${brain.seq - beforeJiggle} time(s)`
);
console.log('  40 dragover ticks: no restart, still waiting');

// Confirmed: the file goes down.
brain.command('eat');
const swallowed = settle(12);
console.log(`  confirmed -> ${swallowed.join(' -> ')}`);
check(swallowed.includes('chew'), `'eat' did not chew: ${swallowed.join(' -> ')}`);
check(brain.offer === null, "'eat' left an offer behind");

// Cancelled: the mouth closes again and the cat gets on with its life.
settle(5);
brain.command('offer', { x: brain.x });
settle(1.5);
brain.command('cancelFeed');
const refused = settle(3);
console.log(`  cancelled -> ${refused.join(' -> ')}`);
check(refused.includes('feed_close'), `cancelling did not close up: ${refused.join(' -> ')}`);
check(brain.offer === null, 'cancelling left an offer behind');

// Nobody ever answers. The cat must not sit there gaping forever: this is the
// backstop for a drag that ended somewhere the window never heard about.
settle(5);
brain.command('offer', { x: brain.x });
const abandoned = settle(34);
console.log(`  abandoned offer -> ${abandoned.join(' -> ')}`);
check(
  abandoned.includes('feed_close'),
  `an abandoned offer never timed out: ${abandoned.join(' -> ')}`
);
check(brain.action !== 'feed_wait', `still waiting after 34s: '${brain.action}'`);
check(brain.offer === null, 'an abandoned offer was never cleared');

// Picked up mid-offer: the food is forgotten, not eaten later.
settle(5);
brain.command('offer', { x: brain.x });
settle(1.5);
brain.grab();
check(brain.offer === null, 'being picked up left the offer behind');
brain.release();
settle(6);
console.log('  picked up mid-offer: offer dropped');

// Being fed must not break the ordinary loop afterwards.
const afterMeals = settle(90);
check(afterMeals.length > 3, `the cat stopped doing anything: ${afterMeals.join(' -> ')}`);
check(
  !FEEDING.includes(brain.action),
  `left stuck in a feeding pose: '${brain.action}'`
);
console.log(`  90s later: back to ${afterMeals.length} ordinary action changes`);

// ---- verdict --------------------------------------------------------------------------

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nall behaviour checks passed');
}
