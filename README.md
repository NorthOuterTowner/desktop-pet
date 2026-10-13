# desktop-cat

An Electron desktop pet. A cat sits along the bottom of your screen on top of the
taskbar, blinks, gets up for a walk, grooms itself and curls up for a nap when you
leave it alone. Click it and it tilts its head at you with a little heart. Pick it up
and drop it and it lands with its fur up.

## Run

```powershell
npm install
npm start
```

There is no main window and no taskbar entry. Everything is driven from the tray icon
or by right-clicking the cat.

## Interacting

| Action | Result |
| --- | --- |
| Left-click the cat | Head tilt, and a heart floats up beside it |
| Double-click the cat | A pleased wiggle |
| Drag the cat | Pick it up and carry it anywhere; it falls back to the floor when you let go |
| Right-click the cat | The menu below |
| Click the tray icon | Head tilt |
| Right-click the tray icon | The same menu |

The menu is: Come here, Go for a walk, Head tilt, Wave, Groom, Nap, Wake up, Pause,
Quit. "Come here" walks the cat over to wherever your mouse is. "Pause" freezes it
completely, down to the frame it is showing.

The cat is always drawn at the same size. There is deliberately no size setting; to
change it, move `TARGET_SIT_HEIGHT` in `src/renderer.js`.

## Staying out of the way

The window spans the whole work area so the cat can be carried anywhere, which makes
not interfering with other applications the main design constraint rather than an
afterthought.

- **Mouse input passes straight through.** The window runs with
  `setIgnoreMouseEvents(true, { forward: true })` and only takes input while the
  cursor is over an opaque pixel of the cat, tested per-pixel against the alpha
  channel of the frame currently showing. Everywhere else, clicks go to whatever is
  behind it.
- **The taskbar is never covered.** The stage is the *work area*, not the full
  display, so the taskbar sits outside the window entirely. The work area's bottom
  edge is the floor the cat stands and lands on.
- **It never takes focus.** The window is `focusable: false`, so it cannot steal
  keystrokes from what you are typing in, and it stays out of Alt-Tab and the
  taskbar.
- **A wedged pet lets go.** While the cat holds the mouse, the renderer sends the main
  process a heartbeat. If those stop arriving, or the render process dies, or the
  window goes unresponsive, the main process forces the window back to click-through.
  A frozen cat cannot swallow clicks across the screen.
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

## Layout

```
electron/main.js                window, tray and cat menu, app:// protocol, watchdog
electron/preload.js             the `pet` bridge exposed to the renderer
electron/_smoke.js              `--smoke` diagnostic: boots, probes, screenshots, quits
src/index.html                  the stage
src/styles.css                  heart float-up animation, drag cursor states
src/renderer.js                 canvas drawing, cross-fade, per-pixel hit test, dragging
src/behavior.js                 the brain: a step queue, an energy model and gravity
src/sprites.js                  manifest loading and frame lookup
tools/build_assets.py           sheet -> sprite pipeline
tools/build_icons.py            sprite -> the app icons the installers ship
tools/_simulate.mjs             steps the brain headless and checks it
assets/sprites/                 generated frames + manifest.json
icons/                          the heart the renderer floats on a click
rsrc/raw/                       source sheets
rsrc/_check/                    QA output
electron-builder.yml            installer targets, one block per platform
scripts/build-installers.mjs    the packaging entry point
scripts/build.ps1               the same from a PowerShell prompt
scripts/build.sh                the same from a shell
build/                          generated app icons + macOS entitlements
.github/workflows/release.yml   builds on three runners, publishes the release
```

### Why a custom `app://` scheme instead of `file://`

The renderer hit-tests the cursor against the cat's alpha channel with
`getImageData`, which throws on a canvas tainted by `file://` images. Serving
everything from one privileged scheme gives the page a real origin, keeps the sprites
same-origin so the canvas stays clean, and lets `fetch` read the manifest.

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
npm run check:behavior   # brain only, 60 simulated minutes plus drag/drop/pause
npm run check:app        # boots the real window, probes it, then quits
```

`check:behavior` runs the brain headless and asserts it never reaches an invalid
state, never walks out of bounds, never leaves the floor on its own, and that the
required sequences occur in order: sit into a blink, stand up into a turn into a walk,
turning around at a screen edge, walking back to a sit, lying down to sleep, and
waking into a stretch. It then exercises carrying the cat (including clamping it
inside the screen), dropping it from a height and from floor level, "come here"
arriving on the exact spot, and pause freezing everything without trapping a dropped
cat in mid-air. It exits non-zero if any check fails.

`check:app` boots the real app and drives a click through synthetic input events, so
the per-pixel hit test and the mousedown path are genuinely exercised rather than
bypassed by calling the brain directly. It also checks that transparent corners of the
cat's canvas do *not* register as hits, that the cross-fade never dips the cat's
opacity, that a dropped cat falls monotonically to the floor and startles, and that
the main process is not holding the mouse once the cursor is away from the cat.
Screenshots land in `rsrc/_check/electron/`.

Two things the automated checks cannot cover: the right-click menu is a native popup,
and real click-through has to be felt rather than measured. Both need confirming by
hand. Note also that launching two instances back to back can collide on the Chromium
cache directory; the second will exit immediately, so leave a moment between runs.

## Installers

`npm run dist` builds an actual installer for whichever machine you run it on -- not a
folder of files to copy about.

| Platform | Artifact | What installing it does |
| --- | --- | --- |
| Windows | `desktop-cat-<v>-win-x64-setup.exe` | NSIS wizard: choose per-user or per-machine, choose the location, get Start menu and desktop shortcuts and an entry in Apps & features that uninstalls cleanly |
| macOS | `desktop-cat-<v>-mac-arm64.dmg` | Disk image you drag to Applications. Runs as a menu-bar accessory with no Dock tile |

Both are built for x64 and arm64, so there is an Apple-silicon and an Intel `.dmg`.
Everything lands in `dist/` next to a `SHA256SUMS-<platform>.txt`.

Linux is not packaged. The `.deb`, `.rpm` and `.AppImage` targets were the slowest
third of every release for the fewest downloads, so they were removed; `npm start`
still runs the cat from source on Linux.

```powershell
npm run dist                               # installers for this machine
npm run dist:win                           # or dist:mac
npm run pack                               # unpacked app only, for debugging
node scripts/build-installers.mjs --help
```

If you would rather not go through npm there are wrappers that take the same
arguments: `.\scripts\build.ps1` on Windows, `bash scripts/build.sh` elsewhere.

### One installer per operating system

`npm run dist:all` refuses on most machines, and that is the honest answer rather than
a gap to work around: a `.dmg` is assembled by `hdiutil`, which only exists on macOS.
The script checks the host before it starts and names the combinations that cannot
work, so you find out in a second instead of four minutes into a build.
`--allow-cross` overrides it if you have Wine or a container set up.

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

The builds are unsigned, so SmartScreen warns on a first Windows run and macOS wants
**right-click > Open** the first time (or
`xattr -dr com.apple.quarantine "/Applications/Desktop Cat.app"`). To sign for real,
add the usual electron-builder variables as repository secrets and pass them into the
build step:

- Windows: `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD`
- macOS: `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD`; to notarise as well,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, plus
  `mac.notarize: true` in `electron-builder.yml`

The build script sets `CSC_IDENTITY_AUTO_DISCOVERY=false` whenever none of those are
set. That is what keeps an unsigned macOS build from stopping to hunt through the
keychain for an identity it was never going to find.

### What ends up inside

An allow-list in `electron-builder.yml`: `electron/`, `src/`, `assets/sprites/`,
`icons/` and `package.json`. The Python pipeline, the raw art in `rsrc/` and the checks
are build-time only and stay out, which is most of the repository by size.

All of it goes into `app.asar` with nothing unpacked. That is the reason the tray icon
is read with `fs.readFileSync` and handed to `nativeImage.createFromBuffer` rather than
passing the path to `createFromPath`: only Node's `fs` is patched to see inside the
archive, so a native path loader comes back with an empty image and the tray silently
loses its icon. The `app://` handler already read through `fs`, so it needed no change.

The app icons in `build/` are generated from the resting sit sprite by `npm run icons`
(Python, Pillow) and are committed. That is deliberate -- packaging and CI never need
the Python toolchain. Re-run it after changing the art.

## Rebuilding the sprites

The frames in `assets/sprites/` are generated; don't edit them by hand.

The pipeline is Python and needs Pillow, numpy and scipy:

```powershell
pip install -r requirements.txt
npm run assets          # build assets/sprites
npm run assets:probe    # numbered contact sheets only, to identify frames
```

Nine source sheets are cut into 21 action folders (112 frames) plus a
`manifest.json`. All frames land on a shared 256px canvas, bottom-aligned on one
ground line, so a clip change never needs per-frame offsets and the cat never hops
vertically when one animation hands over to the next.

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

`held` and `startle` are reachable only by picking the cat up, and `head_tilt` only by
clicking it; the headless check asserts they never fire on their own.

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
and the old startle row in `rsrc/raw/new2/Designer (3).png`, and the original turn
sweep in `rsrc/raw/enw/Designer.png`.
