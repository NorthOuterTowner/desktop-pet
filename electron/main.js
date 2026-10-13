'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
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

// How often the cursor is polled, and why there is a poll at all: during an OS file
// drag the drag source owns the mouse, so the forwarded mousemove events the renderer
// normally hit-tests against stop arriving entirely. Without a second channel the
// window's click-through state freezes mid-drag and the drop never lands on the cat.
// 30 Hz is enough to keep up with a hand and costs one GetCursorPos per tick.
const CURSOR_POLL_MS = 33;

let win = null;
let tray = null;
let watchdog = null;
let cursorPoll = null;
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

  // Dropping a file on a Chromium window navigates to it unless something stops it,
  // which would replace the pet with a picture of whatever was dropped. The renderer
  // calls preventDefault on every drop it sees; this is the backstop for the one it
  // misses, and it also shuts the door on popups.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== 'app://local/src/index.html') event.preventDefault();
  });
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.url !== 'app://local/src/index.html') event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Any way the renderer can die or wedge has to end with the mouse back in the
  // user's hands, not trapped by a full-work-area window.
  win.webContents.on('render-process-gone', () => releaseMouse('render process gone'));
  win.webContents.on('unresponsive', () => releaseMouse('renderer unresponsive'));
  win.on('unresponsive', () => releaseMouse('window unresponsive'));
  win.on('closed', () => {
    stopWatchdog();
    stopCursorPoll();
  });

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

// ---- cursor poll --------------------------------------------------------------------

/** Last point sent, so a still cursor costs no IPC at all. */
let lastCursor = { x: null, y: null };

function startCursorPoll() {
  stopCursorPoll();
  cursorPoll = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const point = screen.getCursorScreenPoint();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    if (x === lastCursor.x && y === lastCursor.y) return;
    lastCursor = { x, y };
    send('pet:cursor', { x, y });
  }, CURSOR_POLL_MS);
}

function stopCursorPoll() {
  if (cursorPoll) clearInterval(cursorPoll);
  cursorPoll = null;
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
    // No position: the fish drops in next to the cat, wherever that is. The cursor is
    // over by the tray when this is clicked, which is the last place to put dinner.
    { label: 'Give a fish', click: () => command('feed') },
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

// ---- feeding ------------------------------------------------------------------------
//
// Two ways to feed the cat. A fish from the menu is make-believe and costs nothing.
// Dropping one of your own files on it is not: the file is deleted, for good, which is
// the whole joke and also the reason everything below leans towards saying no.

/**
 * How long "don't ask again" lasts, and deliberately only in memory: every launch
 * starts by asking again. A pet that silently deletes files is worse than one more
 * dialog.
 */
const SUPPRESS_MS = 5 * 60 * 1000;
let suppressUntil = 0;
// A second drop while the confirmation is still up would stack dialogs on a window
// that cannot take focus.
let askingAboutFood = false;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Is `target` inside `dir`? Used to keep the cat out of places it must not eat. */
function isInside(target, dir) {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Why the cat must not eat this, or null if it may.
 *
 * Eating is an unrecoverable delete, so this errs towards refusing. Folders are out
 * entirely -- "the cat ate my whole project" is not a feature -- along with anything
 * belonging to the operating system or to the app itself.
 */
async function refuseToEat(target) {
  const root = path.parse(target).root;
  if (target === root) return 'a whole drive';

  const own = [app.getAppPath(), path.dirname(process.execPath)];
  if (own.some((dir) => dir && (target === dir || isInside(target, dir)))) {
    return 'part of Desktop Cat itself';
  }

  // `isInside(home, target)` rather than the other way round: this is the check that
  // catches C:\Users and /Users, the folders that *contain* the home folder.
  const home = app.getPath('home');
  if (target === home || isInside(home, target)) return 'your home folder';

  const system =
    process.platform === 'win32'
      ? [
          process.env.SystemRoot,
          process.env.ProgramFiles,
          process.env['ProgramFiles(x86)'],
          process.env.ProgramData,
        ]
      : ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/Applications'];
  if (system.some((dir) => dir && (target === dir || isInside(target, dir)))) {
    return 'inside a system folder';
  }

  let stats;
  try {
    stats = await fs.promises.lstat(target);
  } catch {
    return 'not there any more';
  }
  if (stats.isDirectory()) return 'a folder, and the cat only eats one file at a time';
  return null;
}

/** Everything the confirmation needs to say about what is about to be eaten. */
async function describeMeal(files) {
  let total = 0;
  for (const file of files) {
    try {
      total += (await fs.promises.lstat(file)).size;
    } catch {
      /* counted as nothing; it is about to be deleted anyway */
    }
  }

  const shown = files.slice(0, 4).map((file) => `  ${file}`);
  if (files.length > shown.length) shown.push(`  …and ${files.length - shown.length} more`);

  return {
    message:
      files.length === 1
        ? `Feed “${path.basename(files[0])}” to the cat?`
        : `Feed ${files.length} files to the cat?`,
    detail: [
      shown.join('\n'),
      '',
      `${formatSize(total)} in total. The cat eats it for good: this deletes the ` +
        'file outright rather than moving it to the Recycle Bin, and there is ' +
        'nothing to undo afterwards.',
    ].join('\n'),
  };
}

/**
 * A file was dropped on the cat: ask, delete, then let the cat chew.
 *
 * The dialog is deliberately parentless. This window is `focusable: false` so the pet
 * can never steal focus from what you are typing in, and a modal attached to a window
 * that cannot take focus is a fine way to produce a dialog nobody can answer.
 */
async function feedFiles(paths) {
  if (askingAboutFood) return;

  const files = [
    ...new Set(
      (Array.isArray(paths) ? paths : [])
        .filter((p) => typeof p === 'string' && p.length > 0)
        .map((p) => path.resolve(p))
    ),
  ];
  if (files.length === 0) {
    command('cancelFeed');
    return;
  }

  const edible = [];
  const refused = [];
  for (const file of files) {
    const why = await refuseToEat(file);
    if (why) refused.push(`${path.basename(file)} is ${why}`);
    else edible.push(file);
  }

  if (edible.length === 0) {
    command('cancelFeed');
    askingAboutFood = true;
    await dialog.showMessageBox({
      type: 'info',
      noLink: true,
      title: 'Desktop Cat',
      message: 'The cat will not eat that.',
      detail: refused.join('\n'),
      buttons: ['Fair enough'],
    });
    askingAboutFood = false;
    return;
  }

  if (Date.now() >= suppressUntil) {
    const { message, detail } = await describeMeal(edible);
    askingAboutFood = true;
    const choice = await dialog.showMessageBox({
      type: 'warning',
      noLink: true,
      title: 'Desktop Cat',
      message,
      detail,
      // Cancel first and as the default: the safe answer should be the one you get
      // from hitting Enter or Escape by reflex.
      buttons: ['Cancel', 'Feed it to the cat', 'Feed it, and stop asking for 5 minutes'],
      defaultId: 0,
      cancelId: 0,
    });
    askingAboutFood = false;

    if (choice.response === 0) {
      command('cancelFeed');
      return;
    }
    if (choice.response === 2) suppressUntil = Date.now() + SUPPRESS_MS;
  }

  const eaten = [];
  const stuck = [];
  for (const file of edible) {
    try {
      await fs.promises.unlink(file);
      eaten.push(file);
    } catch (error) {
      stuck.push(`${path.basename(file)}: ${error.message}`);
    }
  }

  if (eaten.length > 0) {
    console.log(`cat: ate ${eaten.length} file(s)\n  ${eaten.join('\n  ')}`);
    command('eat');
  } else {
    command('cancelFeed');
  }

  if (stuck.length > 0) {
    askingAboutFood = true;
    await dialog.showMessageBox({
      type: 'error',
      noLink: true,
      title: 'Desktop Cat',
      message:
        eaten.length > 0
          ? 'Some of that would not go down.'
          : 'The cat could not eat that.',
      detail: stuck.join('\n'),
      buttons: ['OK'],
    });
    askingAboutFood = false;
  }
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
  const menu = buildMenu();

  // The window is `focusable: false` so the pet can never steal keystrokes -- but a
  // popup menu whose owner window cannot take focus is one Windows will not dismiss
  // when you click away from it. It stayed open until something was clicked on the
  // cat itself, which is a trap.
  //
  // So the window is lent focus for the life of the menu, which is what makes a click
  // anywhere else close it, and takes it straight back afterwards. The blur handler is
  // the belt to that braces: if the platform hands focus elsewhere without closing the
  // menu, close it here.
  const onBlur = () => menu.closePopup(win);
  const restore = () => {
    if (!win || win.isDestroyed()) return;
    win.removeListener('blur', onBlur);
    win.setFocusable(false);
    win.blur();
  };

  win.setFocusable(true);
  win.focus();
  win.once('blur', onBlur);
  menu.popup({ window: win, callback: restore });
});

ipcMain.handle('pet:stage', () => {
  const bounds = stageBounds();
  return { width: bounds.width, height: bounds.height, paused };
});

// Files dropped on the cat. The renderer never touches them; it only reports the
// paths, and every decision about deleting anything happens here.
ipcMain.on('pet:feed-files', (_event, paths) => {
  feedFiles(paths).catch((error) => {
    console.error('cat: feeding failed', error);
    command('cancelFeed');
  });
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
    startCursorPoll();

    if (process.env.CAT_SMOKE || process.argv.includes('--smoke')) {
      require('./_smoke').attach({
        win,
        stageBounds,
        command,
        // So the check can assert the window really did hand the mouse back, rather
        // than trusting the renderer's own view of it.
        isGrabbingMouse: () => grabbingMouse,
        // The checks drive the cat with synthetic mouse events, which the real
        // cursor's position would fight: the poll would immediately overwrite where
        // the test says the pointer is. Only the drag-and-drop path needs it, and
        // that cannot be driven synthetically anyway.
        setCursorPoll: (on) => (on ? startCursorPoll() : stopCursorPoll()),
        // The guard, not the whole feeding path: calling feedFiles would put a modal
        // confirmation on screen and wait for a human. This is the part worth
        // checking automatically anyway.
        refuseToEat,
      });
    }

    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
  });

  app.on('before-quit', () => {
    stopWatchdog();
    stopCursorPoll();
  });

  // The cat has no main window to close, so the tray drives the lifetime.
  app.on('window-all-closed', () => app.quit());
}
