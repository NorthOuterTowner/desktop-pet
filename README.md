# desktop-cat

A desktop pet. A cat sits along the bottom of your screen on top of the taskbar,
blinks, gets up for a walk, grooms itself and curls up for a nap when you leave it
alone. Click it and it tilts its head at you with a little heart. Pick it up and drop
it and it lands with its fur up.

It is a [Tauri 2](https://tauri.app) app: the page in `src/` runs in the system's own
WebView -- WebView2 on Windows, WKWebView on macOS -- and a small Rust process in
`src-tauri/` owns the window, the tray and anything that touches a file. That is why
the Windows installer is about 6 MB where the Electron build it replaced was 100 MB:
there is no copy of Chromium inside it.

## Run

You need Node.js 20+ and Rust ([rustup.rs](https://rustup.rs)). On Windows, Rust also
needs the MSVC build tools, which Visual Studio's "Desktop development with C++"
workload or the standalone Build Tools provide.

```powershell
npm install
npm start
```

The first `npm start` compiles a few hundred crates and takes a few minutes; after
that it is seconds. There is no main window and no taskbar entry. Everything is driven
from the tray icon or by right-clicking the cat.

## Interacting

| Action | Result |
| --- | --- |
| Left-click the cat | Head tilt, and a heart floats up beside it |
| Double-click the cat | A pleased wiggle |
| Drag the cat | Pick it up and carry it anywhere; it falls back to the floor when you let go |
| Right-click the cat | The menu below |
| Drag a file onto the cat | It opens its mouth. Drop it and the cat offers to eat the file -- see below |
| Click the tray icon | Head tilt |
| Right-click the tray icon | The same menu |

The menu is: Come here, Go for a walk, Give a fish, Head tilt, Wave, Groom, Nap, Wake
up, Pause, Quit. "Come here" walks the cat over to wherever your mouse is. "Give a
fish" drops a dried fish out of the sky next to the cat -- not under the cursor, which
is over by the tray when you click it -- close enough that the cat walks a step or two
at most. It then eats it in three bites, and the fish on the floor goes whole, bitten,
crumbs, gone as it does. "Pause" freezes everything, down to the frame it is showing.

The cat's own right-click menu borrows focus for as long as it is open. The window is
not focusable everywhere else, but a popup menu whose owner cannot take focus is
one Windows will not dismiss when you click away from it -- it used to sit there until
something was clicked on the cat itself.

### Feeding it your files

Dragging one of your own files onto the cat is the same gesture, with real
consequences: the cat eats the file, and eating means deleting it outright. No Recycle
Bin, no undo. So the file path is deliberately the slow one:

- Hovering a file over the cat only opens its mouth. Nothing is touched, and letting
  go anywhere else, or just waiting 25 seconds, closes it again. No fish appears: the
  cat is about to eat *your file*, and drawing a treat for it would say otherwise.
- Dropping asks first, with the file name, its size and what is about to happen.
  **Cancel** is both the default button and what Escape does.
- The third button, *feed it and stop asking for 5 minutes*, exists for clearing out
  a pile of junk. It is five minutes, it is per-run, and it is never written to disk:
  every launch starts by asking again.
- Some things are refused outright, before any dialog: folders, drive roots, your home
  folder, anything inside a system folder, and anything belonging to Desktop Cat
  itself. The cat eats one file at a time, not your projects.

The page never even sees the paths. It is told where a drag is, so the cat can open
its mouth in the right place, and then 'eat' or 'cancelFeed'; every decision and the
deletion itself happen in `src-tauri/src/feed.rs`, and the page's capability file
grants it no filesystem access at all.

The cat is always drawn at the same size. There is deliberately no size setting; to
change it, move `TARGET_SIT_HEIGHT` in `src/renderer.js`.

## Staying out of the way

The window spans the whole work area so the cat can be carried anywhere, which makes
not interfering with other applications the main design constraint rather than an
afterthought.

- **Mouse input passes straight through.** The window ignores the cursor
  (`set_ignore_cursor_events`) and only takes input while the cursor is over an
  opaque pixel of the cat, tested per-pixel against the alpha channel of the frame
  currently showing. Everywhere else, clicks go to whatever is behind it.
- **The cursor is polled, not forwarded.** A click-through window hears nothing of
  the mouse, so the Rust side reads the cursor position 60 times a second and hands it
  to the page, which runs the hit test and asks for the mouse back when the pointer is
  on the cat. It only sends anything when the cursor moves. (Electron could forward
  mouse moves to a click-through window; Tauri cannot, and this is the replacement.)
- **The taskbar is never covered.** The stage is the *work area*, not the full
  display, so the taskbar sits outside the window entirely. The work area's bottom
  edge is the floor the cat stands and lands on. It is re-checked every second, so a
  moved or resized taskbar, a new display or a scale change is followed.
- **It never takes focus.** The window is not focusable, so it cannot steal
  keystrokes from what you are typing in, and it stays out of Alt-Tab and the
  taskbar.
- **A wedged pet lets go.** While the cat holds the mouse, the page sends the native
  side a heartbeat. If those stop arriving for 1.5 seconds, the window is forced back
  to click-through. A frozen cat cannot swallow clicks across the screen.
- **A lost drag lets go.** A carried cat keeps the window grabbing the mouse, so a
  drag that never ends would lock the desktop out. Releasing the button outside the
  window, or a drag going completely idle for five seconds, both drop the cat.

## Behaviour

The default state is the crouched front sit, with a blink every 2.4-6s. Left to
itself the cat picks something to do each time it settles: sit, go for a walk, groom,
wave, a happy wiggle, or a nap.

An energy level drains while awake and refills while asleep, so naps happen on a
rhythm rather than at random. From fully rested it takes about six minutes to get
tired, and a nap then runs about two minutes before the cat stretches and gets back
up. The sleepier it gets, the more a nap outweighs everything else in the choice, so
it often drifts off sooner than that. Clicking it or sending it for a walk perks it
up. Over a simulated hour it spends roughly half its time sitting and a quarter
asleep.

Walking is always a full sequence rather than a pose swap: stand up, pause a beat on
its feet, turn to face the way it is going, walk, then turn back to front and sit
down. On reaching a screen edge it turns around and carries on the other way.

Picking the cat up overrides all of that. It freezes into a held pose while carried,
falls under gravity when released (a touch under a second from the top of a typical
screen), then startles on landing and settles back into a sit. Falling is checked
before the pause flag, so a cat dropped while paused still lands instead of hanging
in the air.

Food is the one other thing that interrupts the loop. An offer makes the cat walk
over to it, open its mouth and wait: a fish from the menu goes down on arrival, a
dragged file waits for your answer to the confirmation. Either way the meal is chew,
swallow, then a pleased wiggle. The waiting is on a 25-second fuse, because every way
a drag can end somewhere the window never hears about has to end with the cat closing
its mouth rather than gaping at the desktop forever.

`brain.offer` is the single source of truth for food: `{ x, auto, bites }`, created
when something is offered and cleared when it is swallowed or given up on. The view
draws the treat from it and nothing else, which is what makes the fish impossible to
leave on the floor after the meal or on a cat that was picked up mid-bite. The offer
deliberately outlives the first chew -- that is what keeps the fish on the floor,
shrinking a stage per bite, while the cat works through it.

## Layout

```
src-tauri/src/main.rs           window, tray and cat menu, cursor poll, watchdog
src-tauri/src/feed.rs           eating a dropped file: the guards, the dialog, the delete
src-tauri/tauri.conf.json       app identity, CSP, and the installer config
src-tauri/capabilities/         what the page is allowed to call (very little)
src-tauri/windows/hooks.nsh     removes an old Electron install during an upgrade
src-tauri/Info.plist            macOS: no Dock tile
src-tauri/icons/                bundle icons, generated by `npm run icons`
src/index.html                  the stage
src/bridge.js                   `window.pet`: the page's whole view of the native side
src/styles.css                  heart float-up animation, treat, drag cursor states
src/renderer.js                 canvas drawing, cross-fade, per-pixel hit test, dragging
src/behavior.js                 the brain: a step queue, an energy model and gravity
src/sprites.js                  manifest loading and frame lookup
tools/build_assets.py           sheet -> sprite pipeline
tools/build_icons.py            sprite -> the app icons
tools/build_treat.py            the raw fish drawing -> the treat sprites
tools/_simulate.mjs             steps the brain headless and checks it
assets/sprites/                 generated frames + manifest.json
icons/                          the heart floated on a click, the fish the cat is fed
rsrc/raw/                       source sheets
rsrc/_check/                    QA output
scripts/stage-web.mjs           copies the page into .web/ for Tauri to embed
scripts/build-installers.mjs    the packaging entry point
scripts/build.ps1               the same from a PowerShell prompt
scripts/build.sh                the same from a shell
build/                          generated app icons, including the tray icon
.github/workflows/release.yml   builds on two runners, publishes the release
```

### How the page is served

The renderer hit-tests the cursor against the cat's alpha channel with
`getImageData`, which throws on a canvas tainted by cross-origin images. Tauri serves
the whole page from its own origin, so the sprites are same-origin, the canvas stays
clean and `fetch` can read the manifest.

Tauri embeds a single directory, but the page is spread across `src/`,
`assets/sprites/` and `icons/`. `scripts/stage-web.mjs` copies those three side by
side into `.web/`, keeping the relative URLs the page already uses, and runs on its
own before every `npm start` and every build. Pointing Tauri at the repository root
instead would embed the raw art and the Rust build output along with it.

The Content-Security-Policy is in `tauri.conf.json` rather than a meta tag: it has to
name the IPC origins, which Tauri needs and which differ per platform.

### Cross-fading on a transparent window

Each action change blends over 90ms. The outgoing frame is held fully opaque and the
incoming one is drawn over it at rising alpha. The obvious version -- outgoing at
`1 - t`, incoming at `t` -- is only alpha-correct over an opaque background; on a
transparent window source-over leaves a combined alpha of `t + (1 - t)^2`, which
bottoms out at 0.75 halfway through. That dipped the whole cat to 75% opacity on every
fade, and since the brain changes action roughly every couple of seconds it read as a
constant flicker against the desktop.

## Checks

```powershell
npm run check:behavior   # brain only, 60 simulated minutes plus drag/drop/pause/feeding
```

`check:behavior` runs the brain headless and asserts it never reaches an invalid
state, never walks out of bounds, never leaves the floor on its own, and that the
required sequences occur in order: sit into a blink, stand up into a turn into a walk,
turning around at a screen edge, walking back to a sit, lying down to sleep, and
waking into a stretch. It then exercises carrying the cat (including clamping it
inside the screen), dropping it from a height and from floor level, "come here"
arriving on the exact spot, and pause freezing everything without trapping a dropped
cat in mid-air. It exits non-zero if any check fails.

Feeding gets its own section there, because the failure modes are all about state
that outlives the meal: that a fish makes the cat walk over, open its mouth, chew and
swallow *in that order*; that a hovering file holds the mouth open without the brain
advancing on its own; that forty dragover ticks in a row do not restart the approach;
that cancelling, or nobody ever answering, both close the mouth again; that being
picked up mid-offer forgets the food; and that nothing leaves the cat stuck in a
feeding pose afterwards.

There is no automated check of the running app any more. The Electron build had one
(`check:app`), but it drove Electron-only APIs -- running script in the page and
reading the result, screenshotting the window, synthesising input -- that Tauri does
not have, so it went with Electron. Until there is a replacement, these need trying
by hand after any change to `src-tauri/` or the hit test:

- Hovering the cat turns the cursor into a hand, clicking it tilts its head, and
  clicking a transparent corner of its box goes through to whatever is behind.
- Dragging the cat carries it; letting go drops it and it startles on landing.
- Right-click opens the menu, and clicking anywhere else closes it again.
- Give a fish: the fish drops in next to the cat and goes whole, bitten, crumbs.
- Dragging a scratch file onto the cat opens its mouth, dropping it asks first, and
  Cancel leaves the file alone.

A second launch exits straight away and makes the running cat tilt its head.

## Installers

`npm run dist` builds an actual installer for whichever machine you run it on -- not a
folder of files to copy about.

| Platform | Artifact | Size | What installing it does |
| --- | --- | --- | --- |
| Windows | `desktop-cat-<v>-win-x64-setup.exe` | ~6 MB | NSIS wizard for the current user: choose the location, get a Start menu shortcut and an entry in Apps & features that uninstalls cleanly |
| macOS | `desktop-cat-<v>-mac-arm64.dmg` | -- | Disk image you drag to Applications. Runs as a menu-bar accessory with no Dock tile |

Both are built for x64 and arm64, so there is an Apple-silicon and an Intel `.dmg`.
Everything lands in `dist/` next to a `SHA256SUMS-<platform>.txt`. Installed, the
Windows app is one ~8 MB executable with the page and every sprite embedded in it.

The Windows app runs on the system's WebView2. Windows 11 ships it and current
Windows 10 has it through Edge; on a machine without it the installer downloads it
first (Tauri's default `downloadBootstrapper` mode), which is why it is not inside
the installer.

Installing over an older version replaces it. That includes the 1.x Electron builds,
which were installed under a different uninstall key that this installer would not
otherwise know about: `src-tauri/windows/hooks.nsh` finds that key, runs the old
uninstaller silently and waits for it before copying anything, so an upgrade never
leaves two cats behind.

Linux is not supported: not packaged, not built in CI, and not buildable as things
stand, since the message-box crate is compiled without its Linux backends.

```powershell
npm run dist                               # installer for this machine and CPU
npm run dist:win                           # or dist:mac
npm run pack                               # the app binary only, no installer
node scripts/build-installers.mjs --win --arch x64 --arch arm64
node scripts/build-installers.mjs --help
```

Each architecture is a separate Rust build and needs its target installed, for
example `rustup target add aarch64-pc-windows-msvc`; the script names the missing one
rather than failing halfway through. A release build takes several minutes, most of
it link-time optimisation in favour of a smaller binary.

If you would rather not go through npm there are wrappers that take the same
arguments: `.\scripts\build.ps1` on Windows, `bash scripts/build.sh` elsewhere.

### One installer per operating system

`npm run dist:all` refuses on any single machine, and that is the honest answer
rather than a gap to work around: a `.dmg` is assembled by `hdiutil`, which only
exists on macOS, and the Windows build links against MSVC. The script checks the host
before it starts and names what cannot work, so you find out in a second instead of
ten minutes into a build.

Getting both in one go is what CI is for.

### Releasing

`.github/workflows/release.yml` runs the same script on `windows-latest` and
`macos-latest`, then gathers the installers into a single GitHub release. Cutting one
takes a push and nothing else:

```powershell
npm version patch     # minor / major too; writes package.json and commits
git push
```

On a push to `main` the workflow builds both platforms and then looks for a
release tagged `v<version in package.json>`. No such release means this push is a new
version, so it creates it and attaches every installer plus a combined
`SHA256SUMS.txt`. If the release already exists it leaves it alone -- the version bump
is what marks a push as a release, so ordinary pushes don't pile up duplicates.

Pushing a `v*` tag releases under that exact tag instead, and re-running a tag build
replaces its assets rather than failing on the release already being there. Pull
requests build both platforms and publish nothing. A manual run from the Actions tab
behaves like a push to `main` and has a switch to skip publishing.

The built-in `GITHUB_TOKEN` is the only credential involved; there are no secrets to
set up.

### Signing

The builds are not code signed, so SmartScreen warns on a first Windows run and macOS
wants **right-click > Open** the first time (or
`xattr -dr com.apple.quarantine "/Applications/Desktop Cat.app"`). The macOS app is
ad-hoc signed (`signingIdentity: "-"`), which is the minimum Apple silicon needs to
run it at all.

To sign for real, add Tauri's variables as repository secrets and pass them into the
build step:

- macOS: `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD` and
  `APPLE_SIGNING_IDENTITY`; to notarise as well, `APPLE_ID`, `APPLE_PASSWORD` (an
  app-specific password) and `APPLE_TEAM_ID`
- Windows: a certificate in the runner's store referenced by
  `bundle > windows > certificateThumbprint` in `tauri.conf.json`, or a
  `signCommand` for a cloud signing service

### What ends up inside

`src/`, `assets/sprites/` and `icons/`, staged into `.web/` and compiled into the
executable itself, plus the bundle icons. The Python pipeline, the raw art in `rsrc/`
and the checks are build-time only and stay out, which is most of the repository by
size. The tray icon is compiled in too (`build/icons/32x32.png`), so a missing file can
never leave the tray blank.

The app icons in `build/` and `src-tauri/icons/` are generated from the resting sit
sprite by `npm run icons` (Python with Pillow, then `tauri icon`) and are committed.
That is deliberate -- packaging and CI never need the Python toolchain. Re-run it
after changing the art.

## Rebuilding the sprites

The frames in `assets/sprites/` are generated; don't edit them by hand.

The pipeline is Python and needs Pillow, numpy and scipy:

```powershell
pip install -r requirements.txt
npm run assets          # build assets/sprites
npm run assets:probe    # numbered contact sheets only, to identify frames
npm run treat           # the fish sprite, from the raw drawing
```

Eleven source sheets are cut into 26 action folders (134 frames) plus a
`manifest.json`. All frames land on a shared 256px canvas, bottom-aligned on one
ground line, so a clip change never needs per-frame offsets and the cat never hops
vertically when one animation hands over to the next.

`npm run treat` is separate because the fish is not a cat. The raw drawing holds four
treats side by side -- two whole fish, one bitten, a pile of crumbs -- and three of
those are the stages of one fish being eaten, so the tool cuts them out and writes
`icons/fish.png`, `fish_bitten.png` and `fish_crumbs.png` *on a common canvas at a
common scale*, bottom-aligned and centred. That is the part that matters: it is what
lets the renderer swap the image between bites and have the fish shrink in place
rather than jump about and change size. Treats are found by dilating the alpha before
labelling, so the pile of crumbs groups as one treat instead of a dozen specks.

### Keeping the cat one size

This is the fiddly part, and it is worth understanding before touching the art.

Scale is resolved per sheet *family* -- sheets from a single generator run -- against
a reference front sit, the one pose every family has. One global factor then goes on
top, derived from the largest pose across *every* frame of *every* sheet. Because that
measurement does not care which actions are defined, adding an action cannot resize
the existing frames.

A family is assumed to be internally consistent. When that assumption fails a sheet
can carry a `scale=` correction, but it should not be reached for without a
measurement: the first sheet that needed one was drawing its four-legged cat 8% small
and in a slimmer style, which looked like the cat growing 20% as a startle handed over
to a turn. It was replaced with purpose-drawn art instead, and nothing carries a
correction now.

Two things catch this class of fault:

- **The build prints a continuity table** of the exact frames that hand over between
  sheets, and warns if any standing pose is shorter than a sitting one or if the
  handover poses disagree by more than 8%. Those are the two symptoms the bad sheet
  had.
- **The manifest records `sitHeight`**, how tall the resting sit was actually drawn.
  The renderer sizes its box from that and `TARGET_SIT_HEIGHT`, so the cat lands on a
  fixed number of screen pixels no matter what the global scale did. Nothing
  hardcodes a box size, which it used to -- and that silently resized the cat every
  time a sheet changed.

So: redraw a sheet, run `npm run assets`, and read the continuity table. If it warns,
the new art does not match the scale it was supposed to.

### How the cut-out works

Most sheets are rendered on a magenta screen, so the matte comes from a chroma metric
rather than a distance to the key colour:

```
alpha = 1 - (min(R, B) - G) / 255
```

An RGB distance to magenta reads a half-covered *black outline* as "nowhere near
magenta" and leaves a purple halo around the whole cat. The chroma metric is the
algebraic inverse of compositing over the screen, so it is accurate on the dark
outline and on wispy fur, while the cat's own pinks (ears, nose, tongue) keep full
opacity. Edge pixels are then un-premultiplied to pull the screen colour back out.

Frames are located by connected-component centroid rather than by cutting the sheet
into a rigid grid, so a pose that overflows its cell is never sliced in half.

### Actions

Resting and reactions: `sit`, `blink`, `head_tilt`, `groom`, `happy`, `wave`.
Standing: `stand_up`, `stand`, `sit_down`.
Turning: `turn_left`, `turn_right`, `face_front_from_left`, `face_front_from_right`.
Moving: `walk_left`, `walk_right`.
Sleeping: `lie_down`, `sleep`, `wake_up`, `stretch`.
Being handled: `held`, `startle`.
Being fed: `feed_open`, `feed_wait`, `feed_close`, `chew`, `swallow`.

`held` and `startle` are reachable only by picking the cat up, `head_tilt` only by
clicking it, and the feeding clips only by offering it food; the headless check
asserts none of them fire on their own -- a cat that chews unprompted has found food
nobody gave it.

The two feeding sheets are one family and both open on a plain front sit, which is
what ties them to the rest of the cat: frame 0 is the pose the family scale is
measured against *and* the frame the clips hand back to, so `feed_open` starts from
the resting sit and `swallow` ends on it. `feed_wait` is the only one that loops,
because it has to hold for as long as a file is hovering, so it alternates a wide
mouth with a narrower one and an occasional lick instead of freezing on one gape.

The source walk cycle faces left, so `walk_right` is mirrored. The turn sheet is one
continuous sweep from right profile through front to left profile, so a right turn is
the first half played backwards from the front pose, and the face-front clips are the
turns reversed. `startle` ends side-on and standing, which is why it hands over to
`face_front_from_left` before sitting down.

`stand_up` and `sit_down` stop at the stand sheet's frame 3, not frame 0. Frame 3 is
what the family scale was calibrated on and measures exactly the same height as the
resting sit, so the cat settles straight into its idle pose. The deeper crouches below
it are lower than the cat ever rests, and ending there made it sink below the sit and
pop back up on every single sit-down.

Still unused in the raw art: a run cycle, a rough jump row, the side-sit tail variants
and the old startle row in `rsrc/raw/new2/Designer (3).png`, the original turn sweep
in `rsrc/raw/enw/Designer.png`, and the bitten fish and crumbs on
`rsrc/raw/new-10.13/fish_source.png`.
