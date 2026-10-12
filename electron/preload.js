'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
});
