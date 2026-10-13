/**
 * The cat's brain.
 *
 * No DOM, no Electron: it takes a time delta and decides which action is playing and
 * where the cat is. The view reads `action`, `elapsed`, `x`, `y` and `seq`.
 *
 * Behaviour is a queue of steps rather than a flat state enum, because almost
 * everything the cat does is a little sequence that has to play out in order:
 * standing up, turning, walking, turning back, sitting down. A step is
 * `{ action, hold?, vx?, goal? }`; when the queue empties the cat decides again.
 *
 * Three things sit outside the queue and override it: being held by the mouse,
 * falling, and being paused.
 */

export const SIT = 'sit';
export const SLEEP = 'sleep';
export const HELD = 'held';

// "Normal frequency" blinking. Real cats blink every few seconds.
const BLINK_MIN = 2.4;
const BLINK_MAX = 6.0;

// Energy drains while awake and refills while asleep, so naps happen on their own
// instead of at random.
const AWAKE_DRAIN_SECONDS = 420;
const SLEEP_REFILL_SECONDS = 150;
const TIRED = 0.16;
const RESTED = 0.9;

// Falling, in pixels per second squared. Tuned so a drop from the top of a typical
// screen takes a bit under a second: fast enough to read as gravity, slow enough to
// watch. Terminal speed keeps a drop from a tall screen from teleporting.
const GRAVITY = 2800;
const MAX_FALL_SPEED = 2600;
// Below this the cat is close enough to the floor to just be standing on it.
const FLOOR_EPSILON = 0.5;

// ---- being fed ----------------------------------------------------------------------

// How long the cat holds its mouth open for food that never arrives. Every way an
// offer can be left dangling -- a drag that ended outside the window, a confirmation
// dialog left open, a dragleave that never fired -- has to end with the cat giving up
// rather than sitting there gaping forever.
const OFFER_PATIENCE = 25;
// A treat that drifts further than this while the cat is already waiting is worth
// getting up and walking to again. Anything closer and the cat just keeps waiting,
// so a cursor jiggling over the cat does not restart the whole approach.
const OFFER_CHASE = 140;
// Close enough to food to eat it without bothering to walk.
const OFFER_REACH = 24;
// How far from the cat a fish from the menu lands. Sometimes inside OFFER_REACH, so
// the cat just leans over and eats; sometimes a step or two away.
const FISH_SPREAD = 70;
// Bites it takes to finish a fish. The view has one treat image per bite, so this is
// also how many times the fish visibly shrinks before it is gone.
const FISH_BITES = 3;
// The poses where the cat is waiting to be fed and an offer can still be cancelled.
const OPEN_MOUTHED = new Set(['feed_open', 'feed_wait']);

// Actions that leave the cat up on its feet; it has to sit back down before any of
// the front-facing sitting animations will read correctly.
const STANDING = new Set([
  'stand',
  'stand_up',
  'walk_left',
  'walk_right',
  'turn_left',
  'turn_right',
  'face_front_from_left',
  'face_front_from_right',
  'startle',
]);

export class Brain {
  constructor({ clips, minX, maxX, walkSpeed, rng = Math.random }) {
    this.clips = clips;
    this.rng = rng;
    this.minX = minX;
    this.maxX = maxX;
    this.walkSpeed = walkSpeed;

    this.x = (minX + maxX) / 2;
    // Height above the floor. 0 is standing on it; only dragging lifts the cat off.
    this.y = 0;
    this.vy = 0;

    this.action = SIT;
    this.elapsed = 0;
    this.hold = 2.5;
    this.vx = 0;
    this.energy = 1;
    this.queue = [];
    this.blinkIn = this._rand(BLINK_MIN, BLINK_MAX);

    this.held = false;
    this.falling = false;
    this.paused = false;
    // Set while walking to a specific spot ("come here"), so the walk ends on the
    // target instead of after a duration.
    this.goal = null;
    // Food on offer, as `{ x, auto }`, from the moment it is offered until it is
    // either in the cat's mouth or given up on. The view draws the treat from this,
    // so there is one source of truth for whether there is anything out there.
    this.offer = null;

    // Bumped on every action change so the view can trigger a cross-fade.
    this.seq = 0;
  }

  get asleep() {
    if (this.held || this.falling) return false;
    return this.action === SLEEP || this.action === 'lie_down';
  }

  get airborne() {
    return this.held || this.falling;
  }

  setBounds(minX, maxX, walkSpeed) {
    this.minX = minX;
    this.maxX = maxX;
    if (walkSpeed != null) this.walkSpeed = walkSpeed;
    this.x = Math.min(Math.max(this.x, minX), maxX);
  }

  // ---- main loop -------------------------------------------------------------------

  update(dt) {
    // Being carried: the pose is frozen and the position comes from the cursor.
    if (this.held) {
      this.elapsed += dt;
      return;
    }

    // Dropped: nothing else matters until the cat is back on the floor. Falling is
    // deliberately checked before `paused`, so a cat paused mid-drop still lands
    // instead of hanging in the air.
    if (this.falling) {
      this.elapsed += dt;
      this._fall(dt);
      return;
    }

    // A full freeze, down to the frame currently showing.
    if (this.paused) return;

    this.elapsed += dt;

    if (this.asleep) {
      this.energy = Math.min(1, this.energy + dt / SLEEP_REFILL_SECONDS);
    } else {
      this.energy = Math.max(0, this.energy - dt / AWAKE_DRAIN_SECONDS);
    }

    if (this.vx !== 0) this._walk(dt);

    // Blink only while settled in the default sit, so it never interrupts a sequence.
    if (this.action === SIT && this.queue.length === 0) {
      this.blinkIn -= dt;
      if (this.blinkIn <= 0) {
        this.blinkIn = this._rand(BLINK_MIN, BLINK_MAX);
        const left = Math.max(0.8, this.hold - this.elapsed);
        this._enqueue([{ action: 'blink' }, { action: SIT, hold: left }]);
        return;
      }
    }

    if (this.elapsed >= this.hold) this._advance();
  }

  _fall(dt) {
    this.vy = Math.min(MAX_FALL_SPEED, this.vy + GRAVITY * dt);
    this.y -= this.vy * dt;
    if (this.y <= FLOOR_EPSILON) {
      this.y = 0;
      this.vy = 0;
      this.falling = false;
      this._enqueue(this._landSteps());
    }
  }

  _walk(dt) {
    this.x += this.vx * dt;

    // Heading somewhere specific: stop on arrival rather than at a timeout.
    if (this.goal != null) {
      const arrived = this.vx < 0 ? this.x <= this.goal : this.x >= this.goal;
      if (arrived) {
        this.x = this.goal;
        this.goal = null;
        this.vx = 0;
        this._advance();
        return;
      }
    }

    if (this.x <= this.minX) {
      this.x = this.minX;
      if (this.goal == null) this._bounce('left');
    } else if (this.x >= this.maxX) {
      this.x = this.maxX;
      if (this.goal == null) this._bounce('right');
    }
  }

  /** Reached a screen edge: turn around and carry on the other way. */
  _bounce(edge) {
    const to = edge === 'left' ? 'right' : 'left';
    const left = Math.max(1.5, this.hold - this.elapsed);
    this.vx = 0;
    this._enqueue([
      { action: `face_front_from_${edge}` },
      { action: `turn_${to}` },
      { action: `walk_${to}`, hold: left, vx: this._speed(to) },
      ...this._settleSteps(to),
    ]);
  }

  // ---- being carried ---------------------------------------------------------------

  /** Picked up by the mouse. Pose freezes; the view drives the position. */
  grab() {
    this.held = true;
    this.falling = false;
    this.vy = 0;
    this.vx = 0;
    this.goal = null;
    // Picked up mid-meal: whatever was on offer is forgotten, and the view stops
    // drawing it.
    this.offer = null;
    this.queue = [];
    this.energy = Math.min(1, this.energy + 0.05);
    this._begin({ action: HELD, hold: Infinity });
  }

  /** Move the cat while it is being carried. */
  carryTo(x, y) {
    this.x = Math.min(Math.max(x, this.minX), this.maxX);
    this.y = Math.max(0, y);
  }

  /** Let go. Falls to the floor, then lands with a startle. */
  release() {
    if (!this.held) return;
    this.held = false;
    if (this.y > FLOOR_EPSILON) {
      this.falling = true;
      this.vy = 0;
    } else {
      this.y = 0;
      this._enqueue(this._landSteps());
    }
  }

  /** Fur up, arched back, a hiss, then back to a front sit. */
  _landSteps() {
    return [
      { action: 'startle' },
      // startle ends side on and standing, facing left.
      { action: 'face_front_from_left' },
      { action: 'sit_down' },
      { action: SIT, hold: this._rand(4, 9) },
    ];
  }

  // ---- interaction -----------------------------------------------------------------

  /** Clicked. Head tilt, after sitting back down first if the cat was on its feet. */
  poke() {
    if (this.airborne) return;
    this.energy = Math.min(1, this.energy + 0.2);
    this.vx = 0;
    this.goal = null;
    const pre = this.asleep ? [{ action: 'wake_up' }] : this._returnToSitSteps();
    this._enqueue([
      ...pre,
      { action: 'head_tilt' },
      { action: SIT, hold: this._rand(4, 9) },
    ]);
  }

  /** Double-clicked: a pleased wiggle. */
  pet() {
    if (this.airborne) return;
    this.energy = Math.min(1, this.energy + 0.15);
    this.vx = 0;
    this.goal = null;
    const pre = this.asleep ? [{ action: 'wake_up' }] : this._returnToSitSteps();
    this._enqueue([
      ...pre,
      { action: 'happy' },
      { action: SIT, hold: this._rand(4, 9) },
    ]);
  }

  /** Walk over to a spot, then sit and look up. */
  comeTo(x) {
    if (this.airborne) return;
    this.energy = Math.min(1, this.energy + 0.1);
    this.vx = 0;
    this.goal = null;
    this._enqueue([
      ...this._approachSteps(x),
      { action: 'head_tilt' },
      { action: SIT, hold: this._rand(4, 9) },
    ]);
  }

  // ---- being fed -------------------------------------------------------------------

  /**
   * Something edible is being held out at window x: a treat from the menu, or a file
   * being dragged over the cat.
   *
   * The cat goes over and waits with its mouth open. An `auto` treat is eaten on
   * arrival; a dragged file waits for `eat()`, because the user still has a
   * confirmation to answer and may yet say no.
   */
  offerFood(x, { auto = false } = {}) {
    if (this.airborne) return;
    const at = Math.min(Math.max(x, this.minX), this.maxX);

    // Already waiting: a drag hovering over the cat fires this many times a second,
    // and restarting the approach on each one would leave the cat twitching. Only
    // food that has wandered a long way is worth getting up for again; anything
    // closer just buys the offer more patience.
    if (this.offer && this.action === 'feed_wait') {
      this.offer.x = at;
      if (Math.abs(at - this.x) < OFFER_CHASE) {
        this.elapsed = 0;
        return;
      }
    }

    this.energy = Math.min(1, this.energy + 0.05);
    this.vx = 0;
    this.goal = null;
    this.offer = { x: at, auto, bites: 0 };
    this._enqueue([
      ...this._approachSteps(at, { reach: OFFER_REACH }),
      { action: 'feed_open' },
      ...(auto
        ? [
            { action: 'feed_wait', hold: 0.5 },
            ...this._eatSteps({ bites: FISH_BITES }),
          ]
        : [
            { action: 'feed_wait', hold: OFFER_PATIENCE },
            // Patience ran out. _begin clears the offer when this starts.
            { action: 'feed_close' },
            { action: SIT, hold: this._rand(4, 9) },
          ]),
    ]);
  }

  /** The food goes in: chew, swallow, be pleased about it. */
  eat() {
    if (this.airborne) return;
    this.vx = 0;
    this.goal = null;
    this._enqueue([...this._returnToSitSteps(), ...this._eatSteps()]);
  }

  /** The food went away: the drag left the window, or the user said no. */
  cancelOffer() {
    this.offer = null;
    if (this.airborne) return;
    if (!OPEN_MOUTHED.has(this.action)) return;
    this._enqueue([{ action: 'feed_close' }, { action: SIT, hold: this._rand(4, 9) }]);
  }

  /**
   * Working through the food, a bite at a time.
   *
   * `bite` is the count the view keys the treat's picture off, so a fish visibly
   * goes whole -> bitten -> crumbs -> gone as the cat chews. A dropped file takes one
   * bite and has no picture: there is nothing to show it shrinking.
   */
  _eatSteps({ bites = 1 } = {}) {
    const steps = [];
    for (let bite = 1; bite <= bites; bite += 1) {
      // chew loops, so it needs an explicit hold; everything after it plays once.
      steps.push({ action: 'chew', hold: this._rand(0.8, 1.15), bite });
    }
    steps.push(
      { action: 'swallow' },
      { action: 'happy' },
      { action: SIT, hold: this._rand(4, 9) }
    );
    return steps;
  }

  setPaused(paused) {
    this.paused = paused;
  }

  command(name, data = {}) {
    switch (name) {
      case 'tilt':
        this.poke();
        return;
      case 'come':
        this.comeTo(data.x ?? this.x);
        return;
      case 'pause':
        this.setPaused(true);
        return;
      case 'resume':
        this.setPaused(false);
        return;
      // A fish from the menu. It lands near the cat rather than under the cursor --
      // the cursor is over by the tray when the menu is used, and a fish thrown
      // across the room is a chore rather than a treat. Close enough that the cat
      // walks a step or two at most, sometimes not at all.
      case 'feed':
        this.offerFood(
          data.x ?? this.x + this._rand(-FISH_SPREAD, FISH_SPREAD),
          { auto: true }
        );
        return;
      // A file being dragged over the cat, and then the user's answer to the
      // confirmation. Separate commands because the file is only eaten once the
      // main process says the deletion was agreed to.
      case 'offer':
        this.offerFood(data.x ?? this.x);
        return;
      case 'eat':
        this.eat();
        return;
      case 'cancelFeed':
        this.cancelOffer();
        return;
      default:
        break;
    }

    if (this.airborne) return;

    switch (name) {
      case 'walk':
        this.energy = Math.min(1, this.energy + 0.2);
        this.vx = 0;
        this.goal = null;
        this._enqueue(
          this.asleep
            ? [
                { action: 'wake_up' },
                { action: 'stretch' },
                // stretch ends on its feet, so no stand_up.
                ...this._outingSteps({ standing: true }),
              ]
            : this._outingSteps()
        );
        return;
      case 'groom':
      case 'wave':
        this.vx = 0;
        this.goal = null;
        this._enqueue([
          ...this._returnToSitSteps(),
          { action: name },
          { action: SIT, hold: this._rand(4, 9) },
        ]);
        return;
      case 'sleep':
        this.energy = Math.min(this.energy, TIRED - 0.01);
        this.vx = 0;
        this.goal = null;
        this._enqueue([...this._returnToSitSteps(), ...this._sleepSteps()]);
        return;
      case 'wake':
        if (!this.asleep) return;
        this.energy = Math.max(this.energy, 0.5);
        this._enqueue([
          { action: 'wake_up' },
          { action: 'stretch' },
          { action: SIT, hold: this._rand(5, 10) },
        ]);
        return;
      default:
        return;
    }
  }

  // ---- sequences -------------------------------------------------------------------

  /**
   * Steps that take the cat from wherever it is to `dest`, facing front and sitting.
   * Shared by "come here" and by going over to food.
   *
   * `reach` is how close counts as already being there: tight for "come here", where
   * the point is to come to a spot, looser for food, where shuffling two inches
   * sideways before eating looks silly.
   */
  _approachSteps(dest, { reach = 8 } = {}) {
    const at = Math.min(Math.max(dest, this.minX), this.maxX);
    const distance = Math.abs(at - this.x);
    const wake = this.asleep ? [{ action: 'wake_up' }, { action: 'stretch' }] : [];
    const standing = this.asleep ? true : STANDING.has(this.action);

    // Already there: no shuffling about.
    if (distance < reach) {
      return [
        ...wake,
        ...(standing ? [{ action: 'sit_down' }] : this._returnToSitSteps()),
      ];
    }

    const dir = at < this.x ? 'left' : 'right';
    return [
      ...wake,
      ...(standing ? [] : [{ action: 'stand_up' }]),
      { action: `turn_${dir}` },
      {
        action: `walk_${dir}`,
        // Generous cap: `goal` ends the step on arrival, this is only a backstop in
        // case the cat is blocked from reaching it.
        hold: distance / this.walkSpeed + 2,
        vx: this._speed(dir),
        goal: at,
      },
      { action: `face_front_from_${dir}` },
      { action: 'sit_down' },
    ];
  }

  /** Steps needed to get from whatever is playing now back to a front-facing sit. */
  _returnToSitSteps() {
    const a = this.action;
    if (a === 'walk_left' || a === 'turn_left') {
      return [{ action: 'face_front_from_left' }, { action: 'sit_down' }];
    }
    if (a === 'walk_right' || a === 'turn_right') {
      return [{ action: 'face_front_from_right' }, { action: 'sit_down' }];
    }
    if (a === 'startle') {
      return [{ action: 'face_front_from_left' }, { action: 'sit_down' }];
    }
    if (STANDING.has(a)) return [{ action: 'sit_down' }];
    return [];
  }

  /**
   * Stand up, turn, walk a while, come back to front and sit down.
   *
   * `standing` has to be passable because these steps are sometimes appended after
   * a wake-and-stretch, which already leaves the cat on its feet — inferring it from
   * the action playing right now would insert a second stand_up.
   */
  _outingSteps({ standing = STANDING.has(this.action) } = {}) {
    const roomLeft = this.x - this.minX;
    const roomRight = this.maxX - this.x;
    let dir;
    if (roomLeft < 60) dir = 'right';
    else if (roomRight < 60) dir = 'left';
    else dir = this.rng() < 0.5 ? 'left' : 'right';

    return [
      // A beat on its feet before turning, so standing up and turning read as two
      // deliberate movements rather than one scramble.
      ...(standing
        ? []
        : [{ action: 'stand_up' }, { action: 'stand', hold: this._rand(0.4, 1.1) }]),
      { action: `turn_${dir}` },
      { action: `walk_${dir}`, hold: this._rand(2.5, 6.5), vx: this._speed(dir) },
      ...this._settleSteps(dir),
    ];
  }

  /** Turn back to face front, sit down, then idle. */
  _settleSteps(dir) {
    return [
      { action: `face_front_from_${dir}` },
      { action: 'sit_down' },
      { action: SIT, hold: this._rand(5, 12) },
    ];
  }

  _sleepSteps() {
    return [{ action: 'lie_down' }, { action: SLEEP, hold: this._rand(14, 28) }];
  }

  // ---- scheduling ------------------------------------------------------------------

  _speed(dir) {
    return dir === 'left' ? -this.walkSpeed : this.walkSpeed;
  }

  _rand(lo, hi) {
    return lo + this.rng() * (hi - lo);
  }

  _enqueue(steps) {
    this.queue = steps.filter((step) => this.clips[step.action]);
    this._advance();
  }

  _begin(step) {
    const clip = this.clips[step.action];
    // Each chew takes a bite out of what is on the floor, which is what the view
    // draws from.
    if (step.bite != null && this.offer) this.offer.bites = step.bite;
    // The offer stops existing once it has gone down, or the cat has closed up and
    // given up on it. Deliberately not at the first chew: a fish has to stay on the
    // floor, getting smaller, for as long as the cat is working through it.
    if (step.action === 'swallow' || step.action === 'feed_close') this.offer = null;
    this.action = step.action;
    this.elapsed = 0;
    this.vx = step.vx ?? 0;
    this.goal = step.goal ?? null;
    if (step.hold != null) this.hold = step.hold;
    else if (clip && clip.loop) this.hold = this._rand(3, 7);
    else this.hold = clip ? clip.seconds : 1;
    this.seq += 1;
  }

  _advance() {
    const next = this.queue.shift();
    if (next) {
      this._begin(next);
      return;
    }
    this._decide();
  }

  _decide() {
    if (this.action === SLEEP) {
      // Stay down until actually rested, then get up with a stretch.
      if (this.energy < RESTED) {
        this._begin({ action: SLEEP, hold: this._rand(8, 16) });
      } else {
        this._enqueue([
          { action: 'wake_up' },
          { action: 'stretch' },
          { action: SIT, hold: this._rand(5, 10) },
        ]);
      }
      return;
    }

    if (this.energy < TIRED) {
      this._enqueue([...this._returnToSitSteps(), ...this._sleepSteps()]);
      return;
    }

    const pick = this._weighted([
      [SIT, 30],
      ['walk', 32],
      ['groom', 12],
      ['wave', 5],
      ['happy', 5],
      // The sleepier the cat, the more a nap outweighs everything else.
      ['sleep', 5 + 45 * Math.max(0, 0.4 - this.energy)],
    ]);

    switch (pick) {
      case 'walk':
        this._enqueue(this._outingSteps());
        return;
      case 'sleep':
        this._enqueue([...this._returnToSitSteps(), ...this._sleepSteps()]);
        return;
      case 'groom':
      case 'wave':
      case 'happy':
        this._enqueue([
          ...this._returnToSitSteps(),
          { action: pick },
          { action: SIT, hold: this._rand(4, 9) },
        ]);
        return;
      default:
        this._enqueue([
          ...this._returnToSitSteps(),
          { action: SIT, hold: this._rand(5, 12) },
        ]);
    }
  }

  _weighted(pairs) {
    const total = pairs.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.rng() * total;
    for (const [value, weight] of pairs) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return pairs[pairs.length - 1][0];
  }
}
