/**
 * The `pet` bridge: the one surface between this page and the native half.
 *
 * It used to be an Electron preload. Now it is a thin layer over Tauri's IPC, kept to
 * the same shape so the renderer reads exactly as it did. Every command here is a
 * `#[tauri::command]` in src-tauri/src/main.rs, and every handler hears one of its
 * `pet:*` events.
 *
 * Note what is *not* here: anything that touches a file. A dropped file never passes
 * through the page at all; the native side decides whether the cat may eat it, asks,
 * deletes, and only then tells the page 'eat' or 'cancelFeed'.
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** Fire-and-forget: none of these have a reply worth waiting for. */
const send = (cmd, args) => {
  invoke(cmd, args).catch((error) => console.error(`pet: ${cmd} failed`, error));
};

const on = (event, handler) => {
  listen(event, (message) => handler(message.payload));
};

window.pet = {
  /** Stage size in CSS pixels and settings: { width, height, paused }. */
  stage: () => invoke('stage'),

  /**
   * Whether the cursor is over the cat's own pixels. When it is not, the window goes
   * click-through so the desktop underneath stays usable.
   */
  setInteractive: (interactive) => send('set_interactive', { interactive }),

  /**
   * Proof of life, sent while the cat holds the mouse. If these stop arriving the
   * native side assumes the page wedged and hands the mouse back, so a frozen pet can
   * never swallow clicks across the whole screen.
   */
  heartbeat: () => send('heartbeat'),

  /** Right-clicked the cat: pop up the native menu. */
  openMenu: () => send('open_menu'),

  /**
   * Menu and tray commands, as `{ name, ...data }`. Names: 'come' (carries `x`),
   * 'walk', 'feed', 'tilt', 'wave', 'groom', 'sleep', 'wake', 'pause', 'resume', and
   * the answers to a dropped file, 'eat' and 'cancelFeed'.
   */
  onCommand: (handler) => on('pet:command', handler),

  /** Screen layout changed: { width, height }. */
  onResized: (handler) => on('stage:resized', handler),

  /**
   * The cursor, in window CSS pixels, polled natively. A click-through window hears
   * nothing of the mouse, so this is how the page knows when the pointer arrives on
   * the cat -- and therefore when to ask for the mouse back.
   */
  onCursor: (handler) => on('pet:cursor', handler),

  /**
   * A file drag over the cat: { kind: 'over' | 'drop' | 'leave', x, y }. Position only;
   * the paths stay native.
   */
  onDrag: (handler) => on('pet:drag', handler),
};
