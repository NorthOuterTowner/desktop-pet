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

    const dest = Math.min(Math.max(x, this.minX), this.maxX);
    const distance = Math.abs(dest - this.x);
    const wake = this.asleep ? [{ action: 'wake_up' }, { action: 'stretch' }] : [];
    const standing = this.asleep ? true : STANDING.has(this.action);

    // Already there: just look up, no shuffling about.
    if (distance < 8) {
      this._enqueue([
        ...wake,
        ...(standing ? [{ action: 'sit_down' }] : this._returnToSitSteps()),
        { action: 'head_tilt' },
        { action: SIT, hold: this._rand(4, 9) },
      ]);
      return;
    }

    const dir = dest < this.x ? 'left' : 'right';
    this._enqueue([
      ...wake,
      ...(standing ? [] : [{ action: 'stand_up' }]),
      { action: `turn_${dir}` },
      {
        action: `walk_${dir}`,
        // Generous cap: `goal` ends the step on arrival, this is only a backstop in
        // case the cat is blocked from reaching it.
        hold: distance / this.walkSpeed + 2,
        vx: this._speed(dir),
        goal: dest,
      },
      { action: `face_front_from_${dir}` },
      { action: 'sit_down' },
      { action: 'head_tilt' },
      { action: SIT, hold: this._rand(4, 9) },
    ]);
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
