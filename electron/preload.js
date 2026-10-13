'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  /**
   * Stage size and settings: { width, height, paused }. The cat's own size is not in
   * here; the renderer derives it from the sprite manifest.
   */
  stage: () => ipcRenderer.invoke('pet:stage'),

  /**
   * Tell the main process whether the cursor is over the cat's own pixels. When it
   * is not, the window goes click-through so the desktop underneath stays usable.
   */
  setInteractive: (interactive) => ipcRenderer.send('pet:interactive', interactive),

  /**
   * Proof of life, sent while the cat holds the mouse. If these stop arriving the
   * main process assumes the renderer wedged and hands the mouse back, so a frozen
   * pet can never swallow clicks across the whole screen.
   */
  heartbeat: () => ipcRenderer.send('pet:heartbeat'),

  /** Right-clicked the cat: ask the main process to pop up the native menu. */
  openMenu: () => ipcRenderer.send('pet:menu'),

  /**
   * Menu and tray commands, as `{ name, ...data }`. Names: 'come' (carries `x`),
   * 'walk', 'tilt', 'wave', 'groom', 'sleep', 'wake', 'pause', 'resume'.
   */
  onCommand: (handler) => ipcRenderer.on('pet:command', (_e, payload) => handler(payload)),

  /** Screen layout changed; { width, height }. */
  onResized: (handler) => ipcRenderer.on('stage:resized', (_e, info) => handler(info)),

  /**
   * The real filesystem path behind a dropped File.
   *
   * `File.path` was removed from Electron and the renderer has no Node access, so
   * this is the only way for a drop to name an actual file. It hands back a string
   * and nothing else: no handle, no read, no write.
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /**
   * Dropped files, for the cat to eat. The main process is the only thing that may
   * act on them, and it asks the user first -- eating a file deletes it for good.
   */
  feedFiles: (paths) => ipcRenderer.send('pet:feed-files', paths),

  /**
   * Polled cursor position in window pixels. The forwarded mousemove stream goes
   * silent for the length of an OS file drag, so this is what keeps the hit test
   * (and therefore the window's ability to be a drop target) alive.
   */
  onCursor: (handler) => ipcRenderer.on('pet:cursor', (_e, point) => handler(point)),
});
