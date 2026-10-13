// First, so `window.pet` exists before anything below runs.
import './bridge.js';
import { loadSprites, frameAt } from './sprites.js';
import { Brain } from './behavior.js';
import { Audio_ } from './audio.js';
import { Settings } from './settings.js';

const SPRITE_BASE = '../assets/sprites/';
const HEART_ICON = '../icons/icons8-heart-48.png';
// The treat, one image per bite taken. All three are drawn on a common canvas at a
// common scale by tools/build_treat.py, so swapping between them makes the fish
// shrink in place instead of jumping about. Past the end of this list it is gone.
const TREAT_STAGES = [
  '../icons/fish.png',
  '../icons/fish_bitten.png',
  '../icons/fish_crumbs.png',
];

// Short cross-fade on every action change. The art comes from three separate
// generator runs, so handing over between families can pop; 90ms of blend hides it
// without feeling like a dissolve.
const FADE_SECONDS = 0.09;
// Alpha above which a pixel counts as "the cat" for mouse hit testing.
const HIT_ALPHA = 24;
// How tall the cat should stand on screen, in pixels.
//
// The render box is derived from this, not hardcoded. A sprite canvas is bigger than
// the cat inside it by whatever margin the asset pipeline's global scale happened to
// leave, and that margin moves every time a sheet is added or redrawn -- so a
// hardcoded box size silently resizes the cat. The manifest reports how tall the
// resting sit was actually drawn, which is what makes this stable.
const TARGET_SIT_HEIGHT = 124;
// Walk speed in screen pixels per second, a bit under half the cat's height.
const WALK_SPEED = 51;
// How far to the side of the cat's centre a heart pops, in screen pixels.
const HEART_OFFSET = 48;
// Treat *length* as a fraction of the cat's height -- the fish is long and thin, so
// sizing it by height would make a dried fish longer than the cat is tall.
const TREAT_SCALE = 0.45;
// How far to the side of the cat's centre the treat lands, as a fraction of the
// render box. Far enough out to clear the tail, which is the widest thing the cat
// has and otherwise sits right on top of its dinner.
const TREAT_OFFSET = 0.4;
// Where the fish comes to rest, measured down from the top of the cat's box as a
// fraction of its height: roughly the mouth of the open-mouthed sit. The fall now
// stops here rather than on the floor, so the fish lands at the cat's mouth.
const TREAT_MOUTH = 0.52;
// How far the mouse has to move with the button down before a click becomes a drag.
const DRAG_THRESHOLD = 4;
// Proof of life for the main process while the cat holds the mouse.
const HEARTBEAT_SECONDS = 0.4;
// A carried cat keeps the window grabbing the mouse, so a drag that never ends would
// lock the desktop out. The window covers the work area but not the taskbar, so a
// mouseup over the taskbar can go missing. If a drag goes completely idle this long,
// assume the button was let go somewhere we could not see and drop the cat.
const DRAG_IDLE_LIMIT_SECONDS = 5;

const catEl = document.getElementById('cat');
const ctx = catEl.getContext('2d');
const heartsEl = document.getElementById('hearts');
const treatEl = document.getElementById('treat');
const errorEl = document.getElementById('error');

let sprites = null;
let brain = null;
let audio = null;
let settings = null;
// catSize is a placeholder until the manifest loads; applyStage derives the real one.
let stage = { width: 0, height: 0, catSize: 0 };
let footOffset = 0;

let hitCtx = null;
let shownImage = null;
let fadeFrom = null;
let fadeT = 1;
let lastSeq = -1;

let lastMouse = null;
let interactive = false;
let beatIn = 0;

// Set on mousedown over the cat; becomes a drag once the mouse moves far enough.
let press = null;

// True between dropping a file and the native side coming back with the user's
// answer. A leave can follow a successful drop, and acting on it would snap the
// cat's mouth shut while the confirmation is still up.
let awaitingFeedAnswer = false;

// ---- layout ---------------------------------------------------------------------------

/**
 * Render box size that puts the drawn cat at TARGET_SIT_HEIGHT screen pixels, scaled
 * by the Settings "cat size" slider (1.0 until it loads, so boot is unaffected).
 */
function catBoxSize() {
  const scale = settings ? settings.catScale : 1;
  return Math.round((TARGET_SIT_HEIGHT * scale * sprites.canvas) / sprites.sitHeight);
}

/** Re-apply the layout at the current size, after the cat-size slider moves. */
function relayoutForSize() {
  if (!sprites) return;
  const before = stage.catSize;
  applyStage(stage);
  // Keep the cat's left edge from drifting as it grows: nudge x so its centre holds.
  if (brain && before) {
    brain.x = Math.min(Math.max(brain.x + (before - stage.catSize) / 2, brain.minX), brain.maxX);
  }
}

function applyStage(info) {
  stage = { ...stage, ...info, catSize: catBoxSize() };
  const size = stage.catSize;

  catEl.width = size;
  catEl.height = size;
  catEl.style.width = `${size}px`;
  catEl.style.height = `${size}px`;

  // Frames are drawn on a 256px canvas whose ground line sits a few pixels above the
  // bottom edge. Pushing the canvas down by that gap puts the paws on the floor.
  footOffset = ((sprites.canvas - sprites.baseline) / sprites.canvas) * size;
  catEl.style.bottom = `${-footOffset}px`;

  hitCtx.canvas.width = size;
  hitCtx.canvas.height = size;
  shownImage = null; // force the hit mask to be redrawn at the new size

  if (brain) {
    brain.setBounds(0, Math.max(0, stage.width - size), WALK_SPEED);
  }
}

/** Top of the cat's canvas, in window pixels, when it is standing on the floor. */
function floorTop() {
  return window.innerHeight - stage.catSize + footOffset;
}

/** Top of the cat's canvas right now, accounting for how high it is off the floor. */
function catTop() {
  return floorTop() - brain.y;
}

// ---- drawing --------------------------------------------------------------------------

function draw(dt) {
  const clip = sprites.clips[brain.action];
  const image = frameAt(clip, brain.elapsed);

  if (brain.seq !== lastSeq) {
    fadeFrom = shownImage;
    fadeT = 0;
    lastSeq = brain.seq;
  }
  if (fadeFrom) {
    fadeT = Math.min(1, fadeT + dt / FADE_SECONDS);
    if (fadeT >= 1) fadeFrom = null;
  }

  const size = stage.catSize;
  ctx.clearRect(0, 0, size, size);
  if (fadeFrom) {
    // Hold the outgoing frame fully opaque and blend the incoming one over it.
    //
    // The obvious version -- outgoing at `1 - fadeT`, incoming at `fadeT` -- is only
    // correct on an opaque background. Here the canvas starts empty, so source-over
    // leaves a combined alpha of `fadeT + (1 - fadeT)^2`, which bottoms out at 0.75
    // halfway through. On a transparent window that means the whole cat went 25%
    // see-through for the length of every cross-fade, and since the brain changes
    // action roughly every couple of seconds it read as a constant flicker against
    // the desktop.
    ctx.drawImage(fadeFrom, 0, 0, size, size);
    ctx.globalAlpha = fadeT;
    ctx.drawImage(image, 0, 0, size, size);
    ctx.globalAlpha = 1;
  } else {
    ctx.drawImage(image, 0, 0, size, size);
  }

  if (image !== shownImage) {
    shownImage = image;
    hitCtx.clearRect(0, 0, size, size);
    hitCtx.drawImage(image, 0, 0, size, size);
  }

  catEl.style.transform = `translate(${Math.round(brain.x)}px, ${-Math.round(brain.y)}px)`;
}

// ---- mouse ----------------------------------------------------------------------------

/** Is this window-relative point on an opaque pixel of the cat as currently drawn? */
function overCatAt(clientX, clientY) {
  const x = Math.floor(clientX - Math.round(brain.x));
  const y = Math.floor(clientY - catTop());
  if (x < 0 || y < 0 || x >= stage.catSize || y >= stage.catSize) return false;
  return hitCtx.getImageData(x, y, 1, 1).data[3] > HIT_ALPHA;
}

/**
 * Decide, every frame, whether the window should be taking mouse input, and tell the
 * main process. Checked on the frame loop rather than on mousemove alone, because the
 * cat walks out from under a stationary cursor and the window has to become
 * click-through again when it does.
 *
 * This window covers the whole work area, so "not over the cat" has to mean
 * click-through, or the pet would swallow every click on the desktop.
 */
function updateHit() {
  // The Settings panel is non-modal: the window only takes the mouse while the cursor
  // is over the panel (like the cat), so the rest of the desktop stays clickable.
  // A press that started on the panel (slider drag, title drag) keeps the mouse until
  // release, even if the cursor slides off the panel mid-drag.
  const overSettings =
    !!settings &&
    settings.open &&
    (settings.capturing || (!!lastMouse && settings.contains(lastMouse.x, lastMouse.y)));

  // While the cat is being carried the window has to keep taking input even when the
  // cursor runs ahead of the sprite, otherwise the drag drops the moment you move
  // faster than the cat follows.
  const over = brain.held || overSettings
    ? true
    : lastMouse
      ? overCatAt(lastMouse.x, lastMouse.y)
      : false;

  if (over !== interactive) {
    interactive = over;
    window.pet.setInteractive(over);
    document.body.classList.toggle('over-cat', over);
  }
  document.body.classList.toggle('carrying', brain.held);
}

// ---- the treat ------------------------------------------------------------------------

/**
 * Drawn size of the fish, keeping its own aspect.
 *
 * The fish has an *absolute* size, not scaled to the cat. Its length is a fraction of
 * the default cat height (TARGET_SIT_HEIGHT = 124px), so at 100% the fish is exactly
 * as long as a default-sized cat. Resizing the cat does NOT change the fish.
 * TREAT_SCALE is the default; the slider replaces it.
 */
function treatBox() {
  const scale = settings ? settings.fishScale : TREAT_SCALE;
  const width = Math.round(TARGET_SIT_HEIGHT * scale);
  const ratio =
    treatEl.naturalWidth && treatEl.naturalHeight
      ? treatEl.naturalHeight / treatEl.naturalWidth
      : 1;
  return { width, height: Math.max(1, Math.round(width * ratio)) };
}

/** Left edge the treat is currently placed at, so the DOM is only written on change. */
let treatLeft = null;

/**
 * Show the food wherever the brain says it is, or nothing at all.
 *
 * `brain.offer` is the single source of truth: it appears when a fish is offered, its
 * `bites` count picks the stage, and it is cleared once the cat swallows or gives up
 * -- so the treat cannot linger after the meal or outlive a cat picked up mid-bite.
 *
 * Only a fish is ever drawn. A dragged file deliberately has no sprite: putting a
 * fish on the floor for it would tell the user the cat ate a fish, when what actually
 * went down was their file.
 */
function placeTreat() {
  const offer = brain.offer;
  const bites = offer?.bites ?? 0;
  // Only a fish, and only once the cat has arrived and started opening its mouth
  // (`ready`). Before that the offer exists but the cat is still walking over, so
  // nothing should fall yet. A dragged file never has `auto`, so never a sprite:
  // putting a fish on the floor for it would say the cat ate a fish, not the file.
  const src = offer && offer.auto && offer.ready ? TREAT_STAGES[bites] : undefined;

  if (!src) {
    if (!treatEl.hidden) {
      treatEl.hidden = true;
      treatLeft = null;
    }
    return;
  }

  const { width, height } = treatBox();
  const centre = offer.x + stage.catSize / 2;
  // Beside the cat rather than behind it, flipped inwards when the cat is far enough
  // right that the fish would hang off the screen.
  const side = centre + stage.catSize * TREAT_OFFSET + width / 2 > stage.width ? -1 : 1;
  const left = Math.round(centre + side * stage.catSize * TREAT_OFFSET - width / 2);
  // Rest the fish at the cat's mouth, not on the floor: the top of the cat's box is
  // `catTop()` window pixels down, and the mouth is TREAT_MOUTH of the way into it.
  // `bottom` is measured up from the window's bottom edge.
  const mouthBottom = Math.round(
    window.innerHeight - (catTop() + stage.catSize * TREAT_MOUTH) - height / 2
  );

  if (treatEl.hidden) {
    treatEl.width = width;
    treatEl.height = height;
    treatEl.style.bottom = `${mouthBottom}px`;
    // How far up the fall starts, set per drop so the fish always comes in from off
    // the top of the screen rather than a fixed distance above where it lands.
    // Showing the element is what starts the drop animation, so set this first.
    treatEl.style.setProperty('--drop', `${-(window.innerHeight - mouthBottom)}px`);
    treatEl.hidden = false;
  }
  if (treatEl.getAttribute('src') !== src) treatEl.setAttribute('src', src);
  if (left !== treatLeft) {
    treatLeft = left;
    treatEl.style.left = `${left}px`;
  }
}

function spawnHeart() {
  const size = stage.catSize;
  const heart = document.createElement('img');
  heart.className = 'heart';
  heart.src = HEART_ICON;

  // Just clear of the silhouette: beside the head rather than on top of it.
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = brain.x + size / 2 + side * HEART_OFFSET - 13 + (Math.random() - 0.5) * 8;
  const y = catTop() + size * 0.06;
  heart.style.left = `${Math.round(x)}px`;
  heart.style.top = `${Math.round(y)}px`;

  heart.addEventListener('animationend', () => heart.remove());
  heartsEl.appendChild(heart);
}

/** Give up any drag in progress and put the cat back on the floor. */
function endDrag() {
  if (press && press.dragging) brain.release();
  press = null;
}

/** Last time the cursor moved during a drag, for the idle bail-out above. */
let lastDragMove = 0;

function wireEvents() {
  document.addEventListener('mousemove', (event) => {
    lastMouse = { x: event.clientX, y: event.clientY };

    if (!press) return;
    lastDragMove = performance.now();

    // A missed mouseup (dragged over the taskbar and released, say) would otherwise
    // leave the cat stuck to the cursor forever.
    if (event.buttons === 0) {
      endDrag();
      return;
    }

    if (!press.dragging) {
      const moved =
        Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y);
      if (moved < DRAG_THRESHOLD) return;
      press.dragging = true;
      brain.grab();
    }

    brain.carryTo(
      event.clientX - press.offsetX,
      floorTop() - (event.clientY - press.offsetY)
    );
  });

  document.addEventListener('mousedown', (event) => {
    // Hit-tested against where the click actually landed rather than against the
    // hovering state, which is a frame old by now and may have been computed for a
    // different cursor position or a different animation frame. The window only
    // receives a mousedown at all while it has the mouse, so this is a precision
    // check on top of the OS-level gate, not a replacement for it.
    if (event.button !== 0 || !overCatAt(event.clientX, event.clientY)) return;
    // The panel sits above the cat; a press on it belongs to the panel.
    if (settings.open && settings.contains(event.clientX, event.clientY)) return;
    lastDragMove = performance.now();
    press = {
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - brain.x,
      offsetY: event.clientY - catTop(),
      dragging: false,
    };
  });

  document.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    if (!press) return;
    if (press.dragging) {
      brain.release();
    } else {
      brain.poke();
      spawnHeart();
    }
    press = null;
  });

  // Leaving the window mid-drag counts as letting go.
  //
  // `lastMouse` is deliberately left alone. The native cursor poll is what keeps it
  // current, and it only reports movement: the window flipping back to click-through
  // can fire a mouseleave under a cursor that then holds still, and forgetting where
  // the pointer is would leave the cat deaf to it until the mouse moved again.
  document.addEventListener('mouseleave', () => {
    endDrag();
  });

  document.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || !overCatAt(event.clientX, event.clientY)) return;
    brain.pet();
  });

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (overCatAt(event.clientX, event.clientY)) window.pet.openMenu();
  });

  // ---- being fed a file ----------------------------------------------------------
  //
  // The native side owns the drag: it only reaches this window while the window has
  // the mouse, which it only has while the cursor is on the cat's own pixels -- so a
  // drag that gets this far is a drag over the cat, and no extra hit test is needed.
  // The page is told where the drag is and never which files; whether anything gets
  // eaten is decided natively, after asking.
  window.pet.onDrag(({ kind, x }) => {
    switch (kind) {
      case 'over':
        // Offer it where the cursor is, converted to where the cat should stand.
        brain.offerFood(x - stage.catSize / 2);
        return;
      case 'drop':
        // The cat keeps its mouth open while the user answers the confirmation. The
        // native side replies with 'eat' or 'cancelFeed'.
        awaitingFeedAnswer = true;
        return;
      case 'leave':
        if (!awaitingFeedAnswer) brain.cancelOffer();
        return;
      default:
        return;
    }
  });

  window.pet.onCommand((payload) => {
    const { name, ...data } = payload ?? {};
    // Settings is a view concern, not a brain one: open the panel next to the cat.
    if (name === 'settings') {
      if (settings.open) {
        settings.hide();
      } else {
        // Pass the cat's current position: left edge, width, and bottom edge from the
        // window top. The panel will position itself beside the cat.
        settings.show(brain.x, stage.catSize, floorTop());
      }
      return;
    }
    if (name === 'eat' || name === 'cancelFeed') awaitingFeedAnswer = false;
    brain.command(name, data);
    if (name === 'tilt') spawnHeart();
    // A finished meal is worth being pleased about, visibly.
    if (name === 'eat') spawnHeart();
  });
  window.pet.onResized(applyStage);

  // Where the pointer is while the window is click-through, which is almost always.
  // A click-through window hears nothing of the mouse, so without this the hit test
  // would never see the pointer arrive on the cat and the window would never take
  // the mouse back. While the window does have the mouse, ordinary mousemove events
  // keep `lastMouse` current as well; the two agree, both being CSS pixels.
  window.pet.onCursor((point) => {
    lastMouse = point;
  });
}

// ---- boot -----------------------------------------------------------------------------

function fail(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
  // Never leave a broken pet holding the mouse.
  window.pet.setInteractive(false);
  console.error(message);
}

async function main() {
  const hit = document.createElement('canvas');
  hitCtx = hit.getContext('2d', { willReadFrequently: true });

  sprites = await loadSprites(SPRITE_BASE);
  // Decode every stage of the treat up front. The swaps happen mid-chew, and a blank
  // frame while the next one loads would read as the fish vanishing a bite early.
  for (const src of TREAT_STAGES) {
    const preload = new Image();
    preload.src = src;
  }
  const info = await window.pet.stage();
  applyStage(info);

  brain = new Brain({
    clips: sprites.clips,
    minX: 0,
    maxX: Math.max(0, stage.width - stage.catSize),
    walkSpeed: WALK_SPEED,
  });
  if (info.paused) brain.setPaused(true);

  audio = new Audio_();

  settings = new Settings({
    onVolume: (level) => audio.setVolume(level),
  });
  // The cat-size slider resizes the live cat; the fish-size one is read when a fish
  // next appears, so it needs no callback.
  settings.onCatSize = () => relayoutForSize();

  wireEvents();

  // Handle for poking at behaviour from the WebView's devtools in a debug build.
  // `overCatAt` is the same lookup the frame loop uses, exposed so the hit test can be
  // checked without depending on where the real cursor happens to be.
  window.__catDebug = {
    brain,
    spawnHeart,
    sprites,
    overCatAt,
    floorTop,
    catTop,
    treatEl,
    audio,
  };

  let last = performance.now();
  const tick = (now) => {
    // Measured delta, never a fixed step: a dropped or throttled frame must not
    // stretch the animation or slow the walk.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    // Self-heal a drag whose mouseup never arrived, before it can lock the desktop.
    if (press && now - lastDragMove > DRAG_IDLE_LIMIT_SECONDS * 1000) {
      console.warn('cat: drag went idle, letting go');
      endDrag();
    }

    brain.update(dt);
    draw(dt);
    placeTreat();
    audio.update(brain.action);
    updateHit();

    if (interactive) {
      beatIn -= dt;
      if (beatIn <= 0) {
        beatIn = HEARTBEAT_SECONDS;
        window.pet.heartbeat();
      }
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((err) => fail(String(err && err.message ? err.message : err)));
