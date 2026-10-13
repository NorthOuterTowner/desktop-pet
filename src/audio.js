/**
 * The cat's sounds.
 *
 * One `Audio` per clip, decoded up front, driven off the action the brain is playing.
 * `update(action)` is called once a frame with the current action and does the work
 * only on a *change* of action, so a looping clip is started once when the cat begins
 * walking or sleeping and stopped once when it stops -- never restarted every frame.
 *
 * There is no Web Audio graph here on purpose: a handful of short mp3s through plain
 * <audio> elements is all this needs, and it keeps the volume control a single
 * property to set.
 *
 * A note on autoplay: a WebView will not play sound until the page has seen a user
 * gesture. The ambient loops (walk, purr) therefore may stay silent until the first
 * click on the cat; the one-shots (the meows) are themselves triggered by actions the
 * user caused, so they are past that gate by the time they fire.
 */

const BASE = '../assets/audio/';

/**
 * clip -> { file, loop }. Keyed by what it is, not by the action, so the action
 * mapping below stays readable.
 */
const CLIPS = {
  meow: { file: 'meow.mp3', loop: false },
  meowAngry: { file: 'meow-angry.mp3', loop: false },
  walk: { file: 'walk.mp3', loop: true },
  purr: { file: 'purr-sleep.mp3', loop: true },
};

/**
 * Which clip, if any, each brain action sounds like. Only actions in here make a
 * noise; everything else is silent. The looping entries (walk, sleep) are held for
 * as long as that action plays and cut the moment it changes.
 */
const ACTION_SOUND = {
  head_tilt: 'meow',
  startle: 'meowAngry',
  walk_left: 'walk',
  walk_right: 'walk',
  sleep: 'purr',
};

export class Audio_ {
  constructor() {
    this.volume = 0.3;
    this.muted = false;
    this.lastAction = null;
    /** The looping clip currently playing, so it can be stopped on an action change. */
    this.loopingKey = null;

    this.clips = {};
    for (const [key, { file, loop }] of Object.entries(CLIPS)) {
      const audio = new Audio(BASE + file);
      audio.loop = loop;
      audio.preload = 'auto';
      this.clips[key] = audio;
    }
    this._applyVolume();
  }

  /** 0..1. Also unmutes implicitly -- a drag off zero is how you turn sound back on. */
  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, volume));
    this._applyVolume();
  }

  _applyVolume() {
    const level = this.muted ? 0 : this.volume;
    for (const audio of Object.values(this.clips)) audio.volume = level;
  }

  /**
   * Called every frame with the action the brain is playing. Fires a one-shot when
   * the cat enters an action that has one, and starts or stops the looping clips as
   * walking and sleeping begin and end.
   */
  update(action) {
    if (action === this.lastAction) return;
    this.lastAction = action;

    const key = ACTION_SOUND[action] ?? null;
    const loopingNow = key && CLIPS[key].loop ? key : null;

    // Stop a loop the cat has walked (or woken) out of.
    if (this.loopingKey && this.loopingKey !== loopingNow) {
      this._stop(this.loopingKey);
      this.loopingKey = null;
    }

    if (!key) return;

    if (CLIPS[key].loop) {
      // Starting a loop already running (e.g. walk_left -> walk_right) must not
      // restart it, or the footsteps would hitch on every turn.
      if (this.loopingKey !== key) {
        this.loopingKey = key;
        this._play(key);
      }
    } else {
      this._play(key, true);
    }
  }

  _play(key, fromStart = false) {
    if (this.volume <= 0 && !this.muted) return; // nothing to hear anyway
    const audio = this.clips[key];
    if (fromStart) audio.currentTime = 0;
    const played = audio.play();
    // Autoplay refusal before the first gesture rejects the promise; swallow it so a
    // silent first walk is not a console error every frame.
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }

  _stop(key) {
    const audio = this.clips[key];
    audio.pause();
    audio.currentTime = 0;
  }
}
