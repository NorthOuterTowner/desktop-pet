'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  protocol,
  screen,
} = require('electron');

const ROOT = path.join(__dirname, '..');

// The cat is drawn at a fixed size and there is deliberately no size setting. How big
// that is lives in the renderer, which derives it from the sprite manifest -- see
// TARGET_SIT_HEIGHT in src/renderer.js. Nothing here needs to know.

// If the renderer stops reporting while it has the window grabbed for input, assume
// something is wrong and hand the mouse back to the desktop. This window spans the
// whole work area, so a renderer that froze mid-interaction would otherwise swallow
// every click on the machine.
const HEARTBEAT_TIMEOUT_MS = 1500;
const WATCHDOG_INTERVAL_MS = 500;

let win = null;
let tray = null;
let watchdog = null;
let paused = false;

// Mirrors the window's current mouse state so the watchdog knows whether a stall is
// dangerous (cat grabbed the mouse) or harmless (already click-through).
let grabbingMouse = false;
let lastHeartbeat = 0;

// Everything is served from a custom scheme rather than file://. Two reasons: it
// gives the page a real origin so `fetch` can read the sprite manifest, and it keeps
// sprite images same-origin so the renderer's canvas stays untainted -- the per-pixel
// hit test needs getImageData, which throws on a canvas tainted by file:// images.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(ROOT, rel);
    // Refuse anything that escapes the project directory.
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const body = await fs.promises.readFile(target);
      return new Response(body, {
        headers: {
          'content-type':
            MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// ---- window -------------------------------------------------------------------------

/**
 * The stage is the whole work area, so the cat can be dragged anywhere on screen.
 *
 * Deliberately the work area and not the full display: the work area excludes the
 * taskbar, so the taskbar is never covered by this window at all and stays completely
 * usable. Its bottom edge doubles as the floor the cat stands and lands on.
 */
function stageBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

function createWindow() {
  const bounds = stageBounds();
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // The pet must never steal focus from whatever the user is typing in. This also
    // keeps it out of Alt-Tab.
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The window is never focused (focusable: false), so Chromium would be free to
      // throttle requestAnimationFrame and freeze the cat.
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  releaseMouse();
  win.loadURL('app://local/src/index.html');

  // Any way the renderer can die or wedge has to end with the mouse back in the
  // user's hands, not trapped by a full-work-area window.
  win.webContents.on('render-process-gone', () => releaseMouse('render process gone'));
  win.webContents.on('unresponsive', () => releaseMouse('renderer unresponsive'));
  win.on('unresponsive', () => releaseMouse('window unresponsive'));
  win.on('closed', stopWatchdog);

  return win;
}

/** Hand all mouse input back to whatever is behind the window. */
function releaseMouse(reason) {
  if (!win || win.isDestroyed()) return;
  // `forward: true` keeps delivering mouse-move events to the renderer so it can still
  // tell when the cursor is over the cat.
  win.setIgnoreMouseEvents(true, { forward: true });
  grabbingMouse = false;
  if (reason) console.error(`cat: released mouse (${reason})`);
}

/** Take mouse input, only ever while the cursor is on the cat's own pixels. */
function grabMouse() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(false);
  grabbingMouse = true;
}

function startWatchdog() {
  stopWatchdog();
  lastHeartbeat = Date.now();
  watchdog = setInterval(() => {
    if (!grabbingMouse) return;
    if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      releaseMouse('renderer stopped reporting');
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

function relayout() {
  if (!win || win.isDestroyed()) return;
  const bounds = stageBounds();
  win.setBounds(bounds);
  win.webContents.send('stage:resized', {
    width: bounds.width,
    height: bounds.height,
  });
}

// ---- menu ---------------------------------------------------------------------------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function command(name, data) {
  send('pet:command', { name, ...data });
}

/** Cursor position in window-relative pixels, for "come here". */
function cursorStageX() {
  const bounds = stageBounds();
  return screen.getCursorScreenPoint().x - bounds.x;
}

/** One definition, shared by the tray icon and right-clicking the cat itself. */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Come here', click: () => command('come', { x: cursorStageX() }) },
    { label: 'Go for a walk', click: () => command('walk') },
    { type: 'separator' },
    { label: 'Head tilt', click: () => command('tilt') },
    { label: 'Wave', click: () => command('wave') },
    { label: 'Groom', click: () => command('groom') },
    { type: 'separator' },
    { label: 'Nap', click: () => command('sleep') },
    { label: 'Wake up', click: () => command('wake') },
    { type: 'separator' },
    {
      label: 'Pause',
      type: 'checkbox',
      checked: paused,
      click: () => {
        paused = !paused;
        command(paused ? 'pause' : 'resume');
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

function trayIcon() {
  const source = path.join(ROOT, 'assets', 'sprites', 'sit', '000.png');
  // Read the bytes ourselves rather than handing the path to createFromPath. In a
  // packaged build ROOT is inside app.asar, and only Node's fs is patched to see
  // through the archive -- native path loaders get a file that isn't there.
  let image;
  try {
    image = nativeImage.createFromBuffer(fs.readFileSync(source));
  } catch {
    return nativeImage.createEmpty();
  }
  if (image.isEmpty()) return nativeImage.createEmpty();
  return image.resize({ width: 24, height: 24, quality: 'best' });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Desktop Cat');
  refreshTrayMenu();
  tray.on('click', () => command('tilt'));
}

// ---- ipc ----------------------------------------------------------------------------

ipcMain.on('pet:interactive', (_event, interactive) => {
  lastHeartbeat = Date.now();
  if (interactive) grabMouse();
  else releaseMouse();
});

// Proof of life while the cat holds the mouse. See HEARTBEAT_TIMEOUT_MS.
ipcMain.on('pet:heartbeat', () => {
  lastHeartbeat = Date.now();
});

ipcMain.on('pet:menu', () => {
  if (!win || win.isDestroyed()) return;
  buildMenu().popup({ window: win });
});

ipcMain.handle('pet:stage', () => {
  const bounds = stageBounds();
  return { width: bounds.width, height: bounds.height, paused };
});

// ---- lifecycle ----------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    // The pet lives in the tray and has no window to switch to, so on macOS it is an
    // accessory app. The packaged build declares LSUIElement in its Info.plist; this
    // makes `npm start` behave the same way.
    if (process.platform === 'darwin') app.dock?.hide();

    registerProtocol();
    createWindow();
    createTray();
    startWatchdog();

    if (process.env.CAT_SMOKE || process.argv.includes('--smoke')) {
      require('./_smoke').attach({
        win,
        stageBounds,
        command,
        // So the check can assert the window really did hand the mouse back, rather
        // than trusting the renderer's own view of it.
        isGrabbingMouse: () => grabbingMouse,
      });
    }

    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
  });

  app.on('before-quit', stopWatchdog);

  // The cat has no main window to close, so the tray drives the lifetime.
  app.on('window-all-closed', () => app.quit());
}
