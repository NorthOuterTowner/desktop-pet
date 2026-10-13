"""
Cut every raw cat sheet into per-action sprite folders for the Electron app.

The raw art arrives in three different shapes and this tool normalises all of it:

  * `rsrc/raw/*.png`      already cut out, real alpha, 4x4 grid, faint grey gridlines
  * `rsrc/raw/enw/*.png`  magenta screen, 2x4 grid, white gridlines
  * `rsrc/raw/new2/*.png` magenta screen, 2x4 grid, clean

Three things have to be true for the cat to read as one animal rather than a
flipbook of different cats:

  1. The magenta has to come off without leaving a halo. A distance-to-magenta
     matte reads a half-covered black outline as "not magenta" and leaves a purple
     fringe, so the matte is a chroma metric instead -- see `key_magenta`.
  2. Every sheet draws the cat at its own size, so a per-sheet scale is derived from
     a reference pose (a sit or a stand) measured against one anchor sheet. Without
     this the cat visibly changes size the moment it stands up.
  3. Every frame is bottom-aligned on a shared ground line, so the cat never hops
     vertically when one animation hands over to the next.

Run:
    python tools/build_assets.py           # build assets/sprites
    python tools/build_assets.py --probe   # dump numbered contact sheets only
"""

from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "sprites"
CHECK = ROOT / "rsrc" / "_check"

# ---- keying -------------------------------------------------------------------------

KEY_COLOR = np.array([255.0, 0.0, 255.0], dtype=np.float32)
A_BG = 0.25
A_LO, A_HI = 0.22, 0.90
EDGE_BAND_PX = 6.0
A_SPECK = 0.90
SPECK_DEPTH_PX = 2.0
MAX_SPECK_AREA = 400

# ---- slicing ------------------------------------------------------------------------

# 0.55 is deliberately high. `default_and_head_tilt.png` carries faint grey gridlines
# at alpha 59-123 (0.23-0.48) which form a lattice touching several cats, so they
# cannot be rejected as "thin and long" blobs -- they come through as one sheet-sized
# component. The cat bodies are alpha 250-255, so thresholding above the gridlines
# separates them outright. Soft fur edges are recovered afterwards by dilating the
# blob before cropping.
SOLID_ALPHA = 0.55  # alpha above which a pixel can seed a frame blob
MIN_BLOB_AREA = 400  # ignore blobs smaller than this
# Gridlines and sheet borders show up as blobs that run across most of the sheet while
# staying only a few pixels thick. Cats never do that: the widest pose covers about a
# third of a sheet.
LINE_SPAN = 0.55
LINE_THICKNESS = 16
# Two of the enw sheets have white gridlines drawn over the magenta. White passes the
# chroma matte as solid foreground and the lattice touches several cats, so it cannot
# be rejected as a thin blob later -- it has to come off before the matte is built.
# Scoped to near-white blobs that run across the sheet: the sheets with gridlines have
# ~10k near-white pixels, the clean ones only 200-900 (genuine bright fur highlights),
# and those stay.
GRIDLINE_WHITE = 235

# ---- output -------------------------------------------------------------------------

CANVAS = 256
MARGIN = 6
BASELINE = CANVAS - 4


@dataclass
class Sheet:
    key: str
    path: str
    rows: int
    cols: int
    source: str  # 'magenta' or 'alpha'
    family: str  # sheets from one generator run share a scale
    note: str = ""
    # Correction on top of the family scale, for a sheet that disagrees with its own
    # family. Should stay 1.0 unless there is a measurement saying otherwise; see the
    # `side` sheet below for the one case that needs it.
    scale: float = 1.0


# Scale is resolved per *family*, not per sheet. Sheets from one generator run already
# draw the cat at a consistent size, so rescaling them against each other would do
# harm: a standing profile is genuinely shorter than a front stand with the tail up,
# and height-matching those two would shrink the profile by ~6% for no reason.
# Across families the drawing size really does differ, so one reference pose per
# family -- a plain front sit, the one pose every family has -- ties them together.
FAMILY_REF: dict[str, tuple[str, int]] = {
    "enw": ("stand", 3),  # anchor family; everything else matches this sit
    "new2": ("front", 0),
    "tilt": ("tilt", 0),
    "feed": ("feed", 0),  # both feeding sheets open on a plain front sit
}
ANCHOR_FAMILY = "enw"

SHEETS: list[Sheet] = [
    Sheet("tilt", "rsrc/raw/default_and_head_tilt.png", 4, 4, "alpha", "tilt",
          "front sit: blink frames 0-7, head tilt frames 8-15"),
    Sheet("stand", "rsrc/raw/enw/Designer (1).png", 2, 4, "magenta", "enw",
          "crouched sit rising to a full stand (f0 lowest -> f7 standing)"),
    # Redrawn to hold its proportions through the rotation. The sheet it replaces,
    # rsrc/raw/enw/Designer.png, drew the head-on frame 7% taller than the profiles
    # with a visibly larger head, which read as the cat growing mid-turn. This one
    # also matches the walk sheet's scale outright (x0.997) where the old one was 2%
    # under. Filed under the enw family because that is the scale it matches, despite
    # living in the new3 folder.
    Sheet("turn", "rsrc/raw/new3/Designer (1).png", 2, 4, "magenta", "enw",
          "continuous turn: f0 right profile -> f4 front -> f7 left profile"),
    Sheet("walk", "rsrc/raw/enw/Designer (2).png", 2, 4, "magenta", "enw",
          "8-frame side walk cycle facing left"),
    Sheet("sleep", "rsrc/raw/new2/Designer.png", 2, 4, "magenta", "new2",
          "f0-f3 sit -> lie down -> curl, f4-f7 curled breathing"),
    Sheet("front", "rsrc/raw/new2/Designer (1).png", 2, 4, "magenta", "new2",
          "f0-f3 front sit blink, f4-f7 grooming"),
    Sheet("yawn", "rsrc/raw/new2/Designer (2).png", 2, 4, "magenta", "new2",
          "f0-f3 side stretch and yawn, f4-f7 rough jump row"),
    Sheet("run", "rsrc/raw/new2/Designer (4).png", 2, 4, "magenta", "new2",
          "f0-f3 run cycle facing left, f4-f7 front sit waving"),
    # Purpose-drawn startle, side on and facing left, at the enw family's scale: its
    # two neutral standing frames measure 334 and 335 against the walk sheet's 333,
    # so it needs no correction at all. It replaces rsrc/raw/new2/Designer (3).png,
    # whose standing cat was 8% small and in the slimmer new2 drawing style, so a
    # startle handing over to the enw turn looked like a different, growing cat.
    Sheet("startle", "rsrc/raw/new3/Designer.png", 2, 4, "magenta", "enw",
          "8-frame startle: f0 neutral stand -> f4/f5 arched and hissing -> f7 stand"),
    # The feeding pair, drawn in one run and therefore one family. Both sheets open on
    # a plain front sit, which is what ties them to the rest of the cat: f0 is the
    # frame the family scale is measured on *and* the pose the animations hand back
    # to, so a mouth opening can start from the resting sit without a jump.
    Sheet("feed", "rsrc/raw/new-10.13/Designer.png", 2, 4, "magenta", "feed",
          "front sit being offered food: f0 neutral -> f3 mouth wide open -> f7 neutral"),
    Sheet("chew", "rsrc/raw/new-10.13/Designer (1).png", 2, 4, "magenta", "feed",
          "front sit eating: f1 a mouthful -> f5 swallow -> f6 licks its muzzle -> f7 content"),
]


# =====================================================================================
# Keying
# =====================================================================================


def gridline_mask(rgb: np.ndarray) -> np.ndarray:
    """Near-white gridlines: near-white blobs whose bbox runs across the sheet."""
    h, w, _ = rgb.shape
    near_white = rgb.min(axis=2) >= GRIDLINE_WHITE
    found = np.zeros((h, w), dtype=bool)
    if not near_white.any():
        return found
    labels, n = ndimage.label(near_white)
    for i, box in enumerate(ndimage.find_objects(labels), start=1):
        ys, xs = box
        if (xs.stop - xs.start) > LINE_SPAN * w or (ys.stop - ys.start) > LINE_SPAN * h:
            found |= labels == i
    if found.any():
        # Take the antialiased shoulders of the line with it, or a faint ghost of the
        # line survives in the soft-edge band.
        found = ndimage.binary_dilation(found, iterations=2)
    return found


def key_magenta(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Pull a magenta screen off a sheet. Returns (rgb float32, alpha float32 0..1).

    The matte is a chroma metric rather than a distance to the key colour: against a
    magenta screen (R=255, G=0, B=255) the coverage of a non-magenta subject is

        alpha = 1 - (min(R, B) - G) / 255

    which is the algebraic inverse of compositing over the screen. It stays accurate
    on the cat's dark outline and on wispy fur, while the cat's own pinks (ears, nose,
    tongue) keep full opacity because none of them are magenta-saturated.
    """
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    spill = np.clip(np.minimum(r, b) - g, 0.0, 255.0)
    a_est = 1.0 - spill / 255.0

    # Plain global threshold, no border flood fill: nothing in the cat's palette gets
    # this saturated, so screen pockets fully enclosed by fur get keyed out too.
    bg = a_est < A_BG
    grid = gridline_mask(rgb)
    if grid.any():
        print(f"      removed {int(grid.sum())} px of white gridline")
        bg |= grid

    fg_labels, fg_n = ndimage.label(~bg)
    if fg_n:
        areas = ndimage.sum(np.ones_like(fg_labels), fg_labels, range(1, fg_n + 1))
        tiny = [i + 1 for i, area in enumerate(areas) if area < MIN_BLOB_AREA]
        if tiny:
            bg |= np.isin(fg_labels, tiny)

    alpha = np.where(bg, 0.0, 1.0).astype(np.float32)

    # Trust the coverage estimate only in a band hugging the matte, so interior pinks
    # keep full opacity whatever the chroma metric says about them.
    inward = ndimage.distance_transform_edt(~bg)
    band = (inward > 0) & (inward <= EDGE_BAND_PX)
    soft = np.clip((a_est - A_LO) / (A_HI - A_LO), 0.0, 1.0)
    alpha[band] = np.minimum(alpha[band], soft[band])

    # Un-premultiply the screen out of partially covered pixels, so a half-covered
    # whisker reads as cream rather than pink.
    out = rgb.copy()
    a = alpha[..., None]
    fix = band & (alpha > 0.02)
    unspilled = (rgb - (1.0 - a) * KEY_COLOR) / np.maximum(a, 1e-3)
    out[fix] = np.clip(unspilled[fix], 0.0, 255.0)

    # Residual despill for edge pixels the contrast stretch pushed back to opaque.
    resid = np.clip(np.minimum(out[..., 0], out[..., 2]) - out[..., 1] - 8.0, 0.0, 255.0)
    resid = np.where(band, resid, 0.0)
    out[..., 0] -= resid
    out[..., 2] -= resid
    out = np.clip(out, 0.0, 255.0)

    # Paint over screen pockets stranded deep inside the body (gaps between tail and
    # flank, between the toes). Keying them transparent would punch pinholes instead.
    speck = (a_est < A_SPECK) & (inward > SPECK_DEPTH_PX)
    if speck.any():
        labels, n = ndimage.label(speck)
        h, w = a_est.shape
        areas = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        for i, box in enumerate(ndimage.find_objects(labels), start=1):
            ys, xs = box
            on_border = ys.start == 0 or xs.start == 0 or ys.stop >= h or xs.stop >= w
            keep[i] = areas[i - 1] <= MAX_SPECK_AREA and not on_border
        speck = keep[labels]

    if speck.any():
        speck = ndimage.binary_dilation(speck, iterations=2) & ~bg
        # Source colour must be clean *and* part of the cat: "nearest non-speck pixel"
        # would happily grab a background pixel, which still holds pure key colour at
        # this point, and smear magenta into the body.
        valid = ~speck & ~bg
        _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        out[speck] = out[iy[speck], ix[speck]]
        alpha[speck] = 1.0

    out[alpha <= 0.02] = 0.0
    return out, alpha


def load_alpha_sheet(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Use a sheet's existing alpha channel as-is."""
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32)
    return rgba[..., :3], rgba[..., 3] / 255.0


# =====================================================================================
# Slicing
# =====================================================================================


@dataclass
class Frame:
    rgba: np.ndarray  # HxWx4 uint8, tightly trimmed
    sheet: str
    index: int

    @property
    def width(self) -> int:
        return self.rgba.shape[1]

    @property
    def height(self) -> int:
        return self.rgba.shape[0]


def slice_sheet(sheet: Sheet) -> list[Frame]:
    """Key a sheet and split it into rows*cols tightly-trimmed frames.

    Frames are located by connected-component centroid rather than by cutting the
    sheet on a rigid grid, so a pose that overflows its cell is never sliced in half.
    """
    img = Image.open(ROOT / sheet.path)
    if sheet.source == "magenta":
        rgb, alpha = key_magenta(img)
    else:
        rgb, alpha = load_alpha_sheet(img)
    h, w = alpha.shape

    labels, n = ndimage.label(alpha > SOLID_ALPHA)
    if n == 0:
        raise RuntimeError(f"{sheet.path}: nothing survived the key")

    areas = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
    boxes = ndimage.find_objects(labels)
    centres = [
        ((c + 0.5) * w / sheet.cols, (r + 0.5) * h / sheet.rows)
        for r in range(sheet.rows)
        for c in range(sheet.cols)
    ]
    cell_mask = [np.zeros(alpha.shape, dtype=bool) for _ in centres]
    dropped = 0

    for i, (box, area) in enumerate(zip(boxes, areas), start=1):
        if area < MIN_BLOB_AREA:
            continue
        ys, xs = box
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        spans_wide = bw > LINE_SPAN * w and bh < LINE_THICKNESS
        spans_tall = bh > LINE_SPAN * h and bw < LINE_THICKNESS
        if spans_wide or spans_tall:
            dropped += 1  # gridline or sheet border, not a cat
            continue
        blob = labels == i
        cy, cx = ndimage.center_of_mass(blob)
        best = min(
            range(len(centres)),
            key=lambda k: (cx - centres[k][0]) ** 2 + (cy - centres[k][1]) ** 2,
        )
        cell_mask[best] |= blob

    frames: list[Frame] = []
    for i, mask in enumerate(cell_mask):
        if not mask.any():
            raise RuntimeError(f"{sheet.path}: frame {i} came out empty")
        ys, xs = np.nonzero(mask)
        y0, y1 = ys.min(), ys.max() + 1
        x0, x1 = xs.min(), xs.max() + 1

        # Keep the soft edges around the blob, but suppress any neighbouring frame
        # that happens to reach into this bounding box.
        sub_a = alpha[y0:y1, x0:x1].copy()
        keep = ndimage.binary_dilation(mask[y0:y1, x0:x1], iterations=3)
        sub_a[~keep] = 0.0
        sub_rgb = rgb[y0:y1, x0:x1]

        rgba = np.concatenate(
            [np.clip(sub_rgb, 0, 255), np.clip(sub_a[..., None] * 255.0, 0, 255)],
            axis=2,
        ).astype(np.uint8)

        aa = rgba[..., 3]
        ys, xs = np.nonzero(aa > 2)
        rgba = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        frames.append(Frame(rgba, sheet.key, i))

    if dropped:
        print(f"      dropped {dropped} gridline/border blob(s)")
    return frames


# =====================================================================================
# Scale normalisation and placement
# =====================================================================================


def reference_height(frames: list[Frame], which: tuple[int, ...]) -> float:
    return float(np.median([frames[i].height for i in which]))


def place(frame: Frame, scale: float, mirror: bool) -> Image.Image:
    """Scale a trimmed frame and bottom/centre-align it on the shared canvas."""
    src = Image.fromarray(frame.rgba, "RGBA")
    if mirror:
        src = src.transpose(Image.FLIP_LEFT_RIGHT)
    tw = max(1, round(src.width * scale))
    th = max(1, round(src.height * scale))
    src = src.resize((tw, th), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(src, (max(0, round((CANVAS - tw) / 2)), max(0, BASELINE - th)))
    return canvas


# =====================================================================================
# Probe mode
# =====================================================================================


def probe(sheets: dict[str, list[Frame]]) -> None:
    """Dump numbered contact sheets so frame contents can be confirmed by eye."""
    out = CHECK / "frames"
    out.mkdir(parents=True, exist_ok=True)
    cell = 240
    for sheet in SHEETS:
        frames = sheets[sheet.key]
        cols = sheet.cols
        rows = (len(frames) + cols - 1) // cols
        img = Image.new("RGB", (cell * cols, cell * rows), (210, 210, 220))
        draw = ImageDraw.Draw(img)
        for i, frame in enumerate(frames):
            src = Image.fromarray(frame.rgba, "RGBA")
            fit = min((cell - 26) / src.width, (cell - 26) / src.height)
            src = src.resize(
                (max(1, round(src.width * fit)), max(1, round(src.height * fit))),
                Image.LANCZOS,
            )
            cx = (i % cols) * cell
            cy = (i // cols) * cell
            for yy in range(0, cell, 10):
                for xx in range(0, cell, 10):
                    shade = 240 if ((xx // 10) + (yy // 10)) % 2 else 215
                    draw.rectangle(
                        [cx + xx, cy + yy, cx + xx + 9, cy + yy + 9],
                        fill=(shade, shade, 225),
                    )
            img.paste(src, (cx + (cell - src.width) // 2, cy + cell - 18 - src.height), src)
            draw.rectangle([cx, cy, cx + cell - 1, cy + cell - 1], outline=(90, 90, 110))
            draw.text((cx + 6, cy + 4), f"{i}  {frame.width}x{frame.height}",
                      fill=(20, 20, 30))
        path = out / f"{sheet.key}.png"
        img.save(path)
        print(f"  {sheet.key:<7} {len(frames):2d} frames -> {path.relative_to(ROOT)}"
              f"   ({sheet.note})")


# =====================================================================================
# Actions
# =====================================================================================


@dataclass
class Action:
    name: str
    picks: list[tuple[str, int]]
    fps: float = 8.0
    loop: bool = True
    mirror: bool = False
    tags: list[str] = field(default_factory=list)


ACTIONS: list[Action] = [
    # ---- default resting state ----------------------------------------------------
    # The crouched front sit. This is where the cat lives by default.
    Action("sit", [("tilt", 0)], fps=1.0, loop=True, tags=["idle", "front"]),
    Action("blink", [("tilt", 0), ("tilt", 1), ("tilt", 2), ("tilt", 3),
                     ("tilt", 2), ("tilt", 1), ("tilt", 0)],
           fps=12.0, loop=False, tags=["accent", "front"]),

    # ---- click reaction: head tilt -------------------------------------------------
    Action("head_tilt", [("tilt", 0), ("tilt", 9), ("tilt", 10), ("tilt", 12),
                         ("tilt", 12), ("tilt", 12), ("tilt", 10), ("tilt", 9),
                         ("tilt", 0)],
           fps=9.0, loop=False, tags=["reaction", "front"]),

    # ---- standing up and sitting back down ----------------------------------------
    # Both of these stop at stand f3, not f2. f3 is the frame the family scale was
    # calibrated on, and it measures exactly the same height as the resting sit from
    # the tilt sheet (179px). f2 is a deeper crouch than the cat ever rests in, so
    # ending there made it sink 5% below the sit and then pop back up the instant the
    # resting pose took over -- on every single sit-down and stand-up.
    Action("stand_up", [("stand", 3), ("stand", 4), ("stand", 5), ("stand", 6),
                        ("stand", 7)],
           fps=7.0, loop=False, tags=["transition", "front"]),
    Action("sit_down", [("stand", 7), ("stand", 6), ("stand", 5), ("stand", 4),
                        ("stand", 3)],
           fps=7.0, loop=False, tags=["transition", "front"]),
    Action("stand", [("stand", 7)], fps=1.0, loop=True, tags=["idle", "front"]),

    # ---- turning. The turn sheet is one continuous sweep, so a right turn is just
    # the first half played backwards from the front pose.
    Action("turn_left", [("turn", 4), ("turn", 5), ("turn", 6), ("turn", 7)],
           fps=8.0, loop=False, tags=["transition"]),
    Action("turn_right", [("turn", 4), ("turn", 3), ("turn", 2), ("turn", 1),
                          ("turn", 0)],
           fps=8.0, loop=False, tags=["transition"]),
    Action("face_front_from_left", [("turn", 7), ("turn", 6), ("turn", 5), ("turn", 4)],
           fps=8.0, loop=False, tags=["transition"]),
    Action("face_front_from_right", [("turn", 0), ("turn", 1), ("turn", 2),
                                     ("turn", 3), ("turn", 4)],
           fps=8.0, loop=False, tags=["transition"]),

    # ---- walking. Source art faces left, so the right cycle is mirrored. ----------
    Action("walk_left", [("walk", i) for i in range(8)],
           fps=9.0, loop=True, tags=["move", "left"]),
    Action("walk_right", [("walk", i) for i in range(8)],
           fps=9.0, loop=True, mirror=True, tags=["move", "right"]),

    # ---- sleeping ------------------------------------------------------------------
    Action("lie_down", [("sleep", 0), ("sleep", 1), ("sleep", 2), ("sleep", 3)],
           fps=4.0, loop=False, tags=["transition", "side"]),
    Action("sleep", [("sleep", 3), ("sleep", 4), ("sleep", 5), ("sleep", 6),
                     ("sleep", 7), ("sleep", 6), ("sleep", 5), ("sleep", 4)],
           fps=2.0, loop=True, tags=["idle", "side"]),
    Action("wake_up", [("sleep", 3), ("sleep", 2), ("sleep", 1), ("sleep", 0)],
           fps=4.0, loop=False, tags=["transition", "side"]),

    # ---- flavour -------------------------------------------------------------------
    Action("groom", [("front", 4), ("front", 5), ("front", 6), ("front", 6),
                     ("front", 5), ("front", 4)],
           fps=6.0, loop=False, tags=["action", "front"]),
    Action("stretch", [("yawn", 0), ("yawn", 1), ("yawn", 2), ("yawn", 2),
                       ("yawn", 1), ("yawn", 3)],
           fps=4.0, loop=False, tags=["action", "side"]),
    Action("happy", [("front", 3), ("front", 2), ("front", 3), ("front", 2),
                     ("front", 3)],
           fps=5.0, loop=False, tags=["reaction", "front"]),
    # Waving a paw from the front sit: neutral, up, down, up, down, neutral.
    Action("wave", [("run", 7), ("run", 4), ("run", 5), ("run", 6), ("run", 5),
                    ("run", 7)],
           fps=7.0, loop=False, tags=["action", "front"]),

    # ---- being fed -----------------------------------------------------------------
    #
    # Four clips out of two sheets. Both sheets' f0 is the plain front sit, so
    # feed_open can start from the resting pose and swallow can hand back to it
    # without a visible cut. feed_wait is the one that loops: it has to hold for as
    # long as the user keeps dragging a file around, so it alternates a wide-open
    # mouth with a narrower one and an occasional lick rather than freezing on a
    # single gaping frame.
    Action("feed_open", [("feed", 0), ("feed", 1), ("feed", 2), ("feed", 3)],
           fps=8.0, loop=False, tags=["transition", "front"]),
    Action("feed_wait", [("feed", 3), ("feed", 4), ("feed", 3), ("feed", 5)],
           fps=3.0, loop=True, tags=["idle", "front"]),
    # Nothing arrived, or the user cancelled: close up and go back to sitting.
    Action("feed_close", [("feed", 2), ("feed", 6), ("feed", 7)],
           fps=7.0, loop=False, tags=["transition", "front"]),
    # Jaw working on a mouthful, with the content half-closed eyes between chews.
    Action("chew", [("chew", 1), ("chew", 2), ("chew", 3), ("chew", 2),
                    ("chew", 4), ("chew", 2)],
           fps=7.0, loop=True, tags=["action", "front"]),
    # Head up to get it down, a lick of the muzzle, then back to neutral so `sit`
    # can take over.
    Action("swallow", [("chew", 5), ("chew", 6), ("chew", 7), ("chew", 7),
                       ("chew", 0)],
           fps=4.0, loop=False, tags=["reaction", "front"]),

    # ---- being picked up and dropped -----------------------------------------------
    # Held is a single frame kept up for as long as the drag lasts: the strongest tilt
    # on the sheet, which reads as the cat craning to look at whoever has hold of it.
    Action("held", [("tilt", 12)], fps=1.0, loop=True, tags=["held", "front"]),
    # Landing after a drop: tense, fur up and back arched, a hiss held for a beat,
    # then deflating back to a neutral stand. Starts and ends on the sheet's two
    # neutral standing frames, which are the handover points -- f7 leaves the cat side
    # on and standing, facing left, for face_front_from_left to pick up.
    Action("startle", [("startle", 0), ("startle", 1), ("startle", 2), ("startle", 3),
                       ("startle", 4), ("startle", 5), ("startle", 4), ("startle", 3),
                       ("startle", 6), ("startle", 7)],
           fps=11.0, loop=False, tags=["reaction", "side"]),
]


def load_actions() -> list[Action]:
    return ACTIONS


def main() -> None:
    probe_only = "--probe" in sys.argv

    print(f"slicing {len(SHEETS)} sheets")
    sheets: dict[str, list[Frame]] = {}
    for sheet in SHEETS:
        print(f"  {sheet.key:<7} {sheet.path}")
        sheets[sheet.key] = slice_sheet(sheet)

    if probe_only:
        print("\nprobe mode: contact sheets only")
        probe(sheets)
        return

    # ---- per-family scale, so a sit is a sit no matter which sheet drew it ---------
    ref_sheet, ref_frame = FAMILY_REF[ANCHOR_FAMILY]
    target_sit = sheets[ref_sheet][ref_frame].height
    print(f"\nanchor family '{ANCHOR_FAMILY}': front sit measures {target_sit}px tall")

    family_scale: dict[str, float] = {}
    for family, (fsheet, fframe) in FAMILY_REF.items():
        own = sheets[fsheet][fframe].height
        family_scale[family] = target_sit / own
        print(f"  family {family:<5} sit ref {fsheet}[{fframe}] {own:4d}px "
              f"-> x{family_scale[family]:.3f}")

    rel = {sheet.key: family_scale[sheet.family] * sheet.scale for sheet in SHEETS}
    for sheet in SHEETS:
        if sheet.scale != 1.0:
            print(f"  sheet {sheet.key:<6} corrected within its family -> x{sheet.scale:.3f}")

    # ---- one global scale on top, so nothing clips the canvas ---------------------
    worst_w = max(f.width * rel[k] for k, fs in sheets.items() for f in fs)
    worst_h = max(f.height * rel[k] for k, fs in sheets.items() for f in fs)
    global_scale = min((CANVAS - 2 * MARGIN) / worst_w, (BASELINE - MARGIN) / worst_h)
    print(f"\nglobal scale {global_scale:.4f} "
          f"(largest normalised pose {worst_w:.0f}x{worst_h:.0f})")

    actions = load_actions()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    manifest = {
        "canvas": CANVAS,
        "baseline": BASELINE,
        "actions": {},
    }

    drawn_height: dict[str, list[int]] = {}

    for action in actions:
        folder = OUT / action.name
        folder.mkdir(parents=True, exist_ok=True)
        files = []
        heights = []
        for i, (sheet_key, idx) in enumerate(action.picks):
            frame = sheets[sheet_key][idx]
            img = place(frame, rel[sheet_key] * global_scale, action.mirror)
            rel_path = f"{action.name}/{i:03d}.png"
            img.save(OUT / rel_path)
            files.append(rel_path)
            rows = np.nonzero(np.asarray(img)[..., 3] > 24)[0]
            heights.append(int(rows.max() - rows.min() + 1) if len(rows) else 0)
        drawn_height[action.name] = heights
        manifest["actions"][action.name] = {
            "frames": files,
            "fps": action.fps,
            "loop": action.loop,
            "tags": action.tags,
        }
        flags = "".join(
            [" loop" if action.loop else "", " mirrored" if action.mirror else ""]
        )
        print(f"  {action.name:<16} {len(files):2d} frames @ {action.fps:>4}fps"
              f"  h{min(heights)}-{max(heights)}{flags}")

    # How tall the resting sit is actually drawn, so the app can size its render box
    # to put the cat at a chosen number of screen pixels. Without this the renderer
    # has to hardcode a box size that silently goes wrong whenever the global scale
    # moves -- which it does whenever a sheet is added or redrawn.
    manifest["sitHeight"] = max(drawn_height["sit"])

    report_scale_continuity(drawn_height)

    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    total = sum(len(a["frames"]) for a in manifest["actions"].values())
    print(f"\nwrote {total} frames across {len(actions)} actions "
          f"-> {OUT.relative_to(ROOT)}")

    build_qa(sheets, rel, global_scale, actions)


# The exact frames that hand over from one animation to the next, where a scale
# disagreement between sheets is visible as the cat changing size. Each entry is
# (action, frame index, what the pose is). Checked by frame rather than by taking an
# action's shortest frame: a startle's shortest frame is the tense one with its tail
# down, which is not the frame it hands over on.
HANDOVER_FRAMES = [
    ("stand", 0, "front stand (stand sheet)"),
    ("turn_left", 0, "front stand (turn sheet)"),
    ("face_front_from_left", 0, "left profile stand"),
    ("walk_left", 0, "walking side-on"),
    ("startle", 0, "startle entry stand"),
    ("startle", -1, "startle exit stand"),
]


def report_scale_continuity(drawn_height: dict[str, list[int]]) -> None:
    """Flag scale drift between sheets, the way the old startle sheet drifted.

    Checks the two things that gave that bug away: a standing cat must not be shorter
    than a sitting one, and the poses that hand over to each other must agree.
    """
    print("\nscale continuity, at the frames that hand over:")
    sit_h = max(drawn_height.get("sit", [0]))

    measured = []
    for name, idx, label in HANDOVER_FRAMES:
        heights = drawn_height.get(name)
        if not heights:
            continue
        measured.append((f"{name}[{idx}]", heights[idx], label))

    if not measured:
        return

    for key, h, label in sorted(measured, key=lambda m: m[1]):
        print(f"  {key:<26} {h:3d}px  {label}")
    print(f"  {'sit[0]':<26} {sit_h:3d}px  sitting (the resting pose)")

    lo = min(measured, key=lambda m: m[1])
    hi = max(measured, key=lambda m: m[1])
    spread = hi[1] / max(1, lo[1]) - 1

    problems = []
    if lo[1] <= sit_h:
        problems.append(
            f"{lo[0]} stands {lo[1]}px tall but a sitting cat is {sit_h}px -- a "
            f"standing cat cannot be shorter than a sitting one, so that sheet's "
            f"scale is wrong"
        )
    if spread > 0.08:
        problems.append(
            f"handover poses disagree by {spread * 100:.0f}% "
            f"({lo[0]} {lo[1]}px vs {hi[0]} {hi[1]}px); the cat will look like it "
            f"changes size between them"
        )

    if problems:
        print("\n  WARNING: sheet scales look inconsistent")
        for p in problems:
            print(f"    - {p}")
        print("    fix with a `scale=` correction on the offending Sheet")
    else:
        print(f"  ok: handover poses agree within {spread * 100:.0f}%, "
              f"all taller than a sit")


def build_qa(
    sheets: dict[str, list[Frame]],
    rel: dict[str, float],
    global_scale: float,
    actions: list[Action],
) -> None:
    out = CHECK / "actions"
    out.mkdir(parents=True, exist_ok=True)

    checker = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 255))
    px = checker.load()
    for y in range(CANVAS):
        for x in range(CANVAS):
            if ((x // 8) + (y // 8)) % 2:
                px[x, y] = (205, 205, 215, 255)

    for action in actions:
        tiles = []
        for sheet_key, idx in action.picks:
            tile = checker.copy()
            tile.alpha_composite(
                place(sheets[sheet_key][idx], rel[sheet_key] * global_scale, action.mirror)
            )
            tiles.append(tile)

        strip = Image.new("RGB", (CANVAS * len(tiles), CANVAS))
        for i, tile in enumerate(tiles):
            strip.paste(tile.convert("RGB"), (i * CANVAS, 0))
        strip.save(out / f"{action.name}_strip.png")

        if len(tiles) > 1:
            gif = [t.convert("P", palette=Image.ADAPTIVE) for t in tiles]
            gif[0].save(
                out / f"{action.name}.gif",
                save_all=True,
                append_images=gif[1:],
                duration=int(1000 / action.fps),
                loop=0,
                disposal=2,
            )
    # The handover frames, side by side. If the cat changes size or hops vertically
    # between actions, it shows up here and nowhere else.
    handover = [
        ("sit", 0), ("blink", 3), ("head_tilt", 3),
        ("stand_up", 0), ("stand_up", -1), ("stand", 0),
        ("turn_left", -1), ("walk_left", 0), ("walk_left", 4),
        ("turn_right", -1), ("walk_right", 0),
        ("lie_down", -1), ("sleep", 0), ("stretch", 1),
    ]
    by_name = {a.name: a for a in actions}
    strip = Image.new("RGB", (CANVAS * len(handover), CANVAS + 16), (250, 250, 252))
    draw = ImageDraw.Draw(strip)
    for i, (name, idx) in enumerate(handover):
        action = by_name[name]
        sheet_key, frame_idx = action.picks[idx]
        tile = checker.copy()
        tile.alpha_composite(
            place(sheets[sheet_key][frame_idx], rel[sheet_key] * global_scale,
                  action.mirror)
        )
        strip.paste(tile.convert("RGB"), (i * CANVAS, 0))
        # Mark the shared ground line so drift is obvious.
        draw.line([(i * CANVAS, BASELINE), (i * CANVAS + CANVAS, BASELINE)],
                  fill=(220, 40, 40), width=1)
        draw.text((i * CANVAS + 4, CANVAS + 3), f"{name}[{idx}]", fill=(20, 20, 30))
    strip.save(CHECK / "continuity.png")

    print(f"QA strips and gifs -> {out.relative_to(ROOT)}")
    print(f"continuity check   -> {(CHECK / 'continuity.png').relative_to(ROOT)}")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
