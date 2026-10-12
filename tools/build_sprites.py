"""
Build desktop-cat sprite assets from the raw magenta-background sheets in rsrc/raw/new2.

Pipeline per sheet (1774x887, 2 rows x 4 cols):
  1. Key out the magenta background with a soft, despilled edge.
  2. Find connected foreground blobs and bucket them into the 2x4 grid by centroid,
     so a pose that overflows its cell is never cut in half.
  3. Trim each frame, scale every frame by ONE global factor (keeps relative pose
     sizes honest), then bottom-align on a shared ground line and centre horizontally.
  4. Write assets/sprites/<anim>/NNN.png plus assets/sprites/manifest.json.

Run:  python tools/build_sprites.py
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "rsrc" / "raw" / "new2"
OUT = ROOT / "assets" / "sprites"
CHECK = ROOT / "rsrc" / "_check" / "new2"

COLS, ROWS = 4, 2
KEY_COLOR = np.array([255.0, 0.0, 255.0], dtype=np.float32)

# Keying. The matte comes from a chroma metric, not an RGB distance: against a
# magenta screen (R=255, G=0, B=255) the coverage of a non-magenta subject is
#     alpha = 1 - (min(R, B) - G) / 255
# which stays accurate for the cat's dark outline, where an RGB distance to the key
# colour would read a half-covered black outline as "nowhere near magenta" and leave
# a purple halo behind.
# 0.25 rather than ~0.12: the sheets carry a 1-4px border strip of slightly-off
# screen colour (around R234 G3 B221, which reads as 0.15 coverage) and this clears it.
A_BG = 0.25  # estimated coverage below this => background
A_LO, A_HI = 0.22, 0.90  # contrast stretch applied to the edge gradient
EDGE_BAND_PX = 6.0  # width of the soft/despill band measured inward from the matte
MIN_BLOB_AREA = 400  # drop keying speckles smaller than this
# Interior screen specks: measured over all five sheets, genuine cat pixels deeper
# than 10px inside the matte never fall below 0.92 estimated coverage, while leftover
# screen pockets sit at 0.20-0.60. Anything under this, far enough from the real
# silhouette to not be an antialiased edge, small, and not touching the sheet border,
# is contamination and gets painted over.
A_SPECK = 0.90
SPECK_DEPTH_PX = 2.0
MAX_SPECK_AREA = 400

# Output canvas. Frames are rendered at 2x the app's nominal display size so the
# app can scale down cleanly on high-DPI screens.
CANVAS = 256
MARGIN = 6  # px of clear space kept above the tallest pose and at the sides
BASELINE = CANVAS - 4  # y of the ground line inside the canvas


# --------------------------------------------------------------------------------------
# Frame layout
# --------------------------------------------------------------------------------------
# Sheet frame indices are row-major: 0..3 = top row left->right, 4..7 = bottom row.

SHEETS = {
    "A": "Designer.png",
    "B": "Designer (1).png",
    "C": "Designer (2).png",
    "D": "Designer (3).png",
    "E": "Designer (4).png",
}


@dataclass
class Anim:
    """One playable animation: an ordered list of (sheet, frame_index) picks."""

    name: str
    picks: list[tuple[str, int]]
    fps: float = 8.0
    loop: bool = True
    mirror: bool = False  # horizontally flip every frame (cat is drawn facing left)
    tags: list[str] = field(default_factory=list)


ANIMS: list[Anim] = [
    # ---- front-facing idles -------------------------------------------------------
    Anim("idle_front", [("B", 0)], fps=1.0, tags=["idle", "front"]),
    Anim("blink", [("B", 0), ("B", 1), ("B", 2), ("B", 1), ("B", 0)],
         fps=11.0, loop=False, tags=["accent", "front"]),
    Anim("happy", [("B", 3), ("B", 2), ("B", 3), ("B", 2), ("B", 3)],
         fps=5.0, loop=False, tags=["reaction", "front"]),
    Anim("groom", [("B", 4), ("B", 5), ("B", 6), ("B", 6), ("B", 5), ("B", 4)],
         fps=6.0, loop=False, tags=["action", "front"]),
    Anim("wave", [("E", 4), ("E", 5), ("E", 6), ("E", 7)],
         fps=5.0, loop=False, tags=["reaction", "front"]),

    # ---- side sit -----------------------------------------------------------------
    Anim("idle_sit_side", [("D", 0), ("D", 1), ("D", 2), ("D", 1)],
         fps=3.0, tags=["idle", "side"]),
    Anim("look_at_you", [("D", 3)], fps=1.0, loop=False, tags=["reaction", "side"]),

    # ---- sleep --------------------------------------------------------------------
    Anim("lie_down", [("A", 0), ("A", 1), ("A", 2), ("A", 3)],
         fps=4.5, loop=False, tags=["transition", "side"]),
    Anim("sleep", [("A", 3), ("A", 4), ("A", 5), ("A", 6), ("A", 7), ("A", 6), ("A", 5), ("A", 4)],
         fps=2.2, tags=["idle", "side"]),

    # ---- stretch / yawn -----------------------------------------------------------
    Anim("stretch", [("C", 0), ("C", 1), ("C", 2), ("C", 2), ("C", 1), ("C", 3)],
         fps=4.0, loop=False, tags=["action", "side"]),

    # ---- startle ------------------------------------------------------------------
    Anim("startle", [("D", 4), ("D", 5), ("D", 6), ("D", 5), ("D", 7)],
         fps=7.0, loop=False, tags=["reaction", "side"]),

    # ---- locomotion (sheet E row 1 is a 4-frame cycle facing left) ----------------
    Anim("walk_left", [("E", 0), ("E", 1), ("E", 2), ("E", 3)],
         fps=8.0, tags=["move", "side"]),
    Anim("walk_right", [("E", 0), ("E", 1), ("E", 2), ("E", 3)],
         fps=8.0, mirror=True, tags=["move", "side"]),

    # ---- jump (mixed front/side source art -- rough, kept as a rare novelty) ------
    Anim("jump", [("C", 4), ("C", 5), ("C", 6), ("C", 7)],
         fps=7.0, loop=False, tags=["action", "rough"]),
]


# --------------------------------------------------------------------------------------
# Keying
# --------------------------------------------------------------------------------------

def key_magenta(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Return (rgb float32 HxWx3 despilled, alpha float32 HxW in 0..1)."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    # Estimated coverage. The cat's palette has no magenta-saturated colour -- even
    # its pink ears, nose and tongue keep G close to min(R, B) -- so this reads ~1
    # across the whole body and falls off only where the screen bleeds through.
    spill = np.clip(np.minimum(r, b) - g, 0.0, 255.0)
    a_est = 1.0 - spill / 255.0

    # Background is a plain global threshold, no border flood-fill: nothing in the
    # cat's palette gets anywhere near this saturated, so screen pockets fully
    # enclosed by fur (gaps between tail and flank, between the legs) are keyed out
    # too instead of surviving as opaque magenta specks.
    bg = a_est < A_BG

    # Drop keying speckles: tiny "foreground" islands floating in the background.
    fg_labels, fg_n = ndimage.label(~bg)
    if fg_n:
        areas = ndimage.sum(np.ones_like(fg_labels), fg_labels, range(1, fg_n + 1))
        tiny = {i + 1 for i, a in enumerate(areas) if a < MIN_BLOB_AREA}
        if tiny:
            bg |= np.isin(fg_labels, list(tiny))

    alpha = np.where(bg, 0.0, 1.0).astype(np.float32)

    # Soft, despilled edge: the estimated coverage is only trusted inside a band
    # hugging the matte boundary, so interior pinks (ears, nose, tongue) keep full
    # opacity no matter what the chroma metric says about them.
    inward = ndimage.distance_transform_edt(~bg)
    band = (inward > 0) & (inward <= EDGE_BAND_PX)
    soft = np.clip((a_est - A_LO) / (A_HI - A_LO), 0.0, 1.0)
    alpha[band] = np.minimum(alpha[band], soft[band])

    # Un-premultiply the key colour out of the partially transparent edge pixels, so
    # a half-covered whisker reads as cream rather than pink.
    out = rgb.copy()
    a = alpha[..., None]
    fix = band & (alpha > 0.02)
    unspilled = (rgb - (1.0 - a) * KEY_COLOR) / np.maximum(a, 1e-3)
    out[fix] = np.clip(unspilled[fix], 0.0, 255.0)

    # Residual despill for edge pixels the stretch pushed back to fully opaque:
    # subtract whatever magenta excess is left from the two key channels.
    resid = np.clip(np.minimum(out[..., 0], out[..., 2]) - out[..., 1] - 8.0, 0.0, 255.0)
    resid = np.where(band, resid, 0.0)
    out[..., 0] -= resid
    out[..., 2] -= resid
    out = np.clip(out, 0.0, 255.0)

    # Paint over screen pockets stranded deep inside the body (narrow gaps between
    # tail and flank, between the toes) by pulling colour from the nearest clean
    # pixel. Keying them transparent instead would punch pinholes in the cat.
    speck = (a_est < A_SPECK) & (inward > SPECK_DEPTH_PX)
    if speck.any():
        labels, n = ndimage.label(speck)
        h, w = a_est.shape
        areas = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        for i, box in enumerate(ndimage.find_objects(labels), start=1):
            ys, xs = box
            touches_border = (
                ys.start == 0 or xs.start == 0 or ys.stop >= h or xs.stop >= w
            )
            keep[i] = areas[i - 1] <= MAX_SPECK_AREA and not touches_border
        speck = keep[labels]

    if speck.any():
        speck = ndimage.binary_dilation(speck, iterations=2) & ~bg
        # Source colour must come from a pixel that is both clean and part of the cat.
        # Searching for "nearest non-speck pixel" would happily grab a background
        # pixel, which still holds pure key colour at this point, and smear magenta
        # into the body.
        valid = ~speck & ~bg
        _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        out[speck] = out[iy[speck], ix[speck]]
        alpha[speck] = 1.0

    out[alpha <= 0.02] = 0.0
    return out, alpha


# --------------------------------------------------------------------------------------
# Slicing
# --------------------------------------------------------------------------------------

@dataclass
class Frame:
    rgba: np.ndarray  # HxWx4 uint8, tightly trimmed
    width: int
    height: int


def slice_sheet(path: Path) -> list[Frame]:
    """Key a sheet and split it into 8 tightly-trimmed frames by blob centroid."""
    img = Image.open(path)
    rgb, alpha = key_magenta(img)
    h, w = alpha.shape

    solid = alpha > 0.25
    labels, n = ndimage.label(solid)
    if n == 0:
        raise RuntimeError(f"{path.name}: nothing survived the key")

    # Grid cell centres used to bucket blobs.
    centres = [
        ((c + 0.5) * w / COLS, (r + 0.5) * h / ROWS)
        for r in range(ROWS)
        for c in range(COLS)
    ]

    cell_mask = [np.zeros(alpha.shape, dtype=bool) for _ in centres]
    coms = ndimage.center_of_mass(solid, labels, range(1, n + 1))
    areas = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
    for idx, ((cy, cx), area) in enumerate(zip(coms, areas), start=1):
        if area < MIN_BLOB_AREA:
            continue
        best = min(range(len(centres)),
                   key=lambda k: (cx - centres[k][0]) ** 2 + (cy - centres[k][1]) ** 2)
        cell_mask[best] |= labels == idx

    frames: list[Frame] = []
    for i, mask in enumerate(cell_mask):
        if not mask.any():
            raise RuntimeError(f"{path.name}: frame {i} came out empty")
        ys, xs = np.nonzero(mask)
        y0, y1 = ys.min(), ys.max() + 1
        x0, x1 = xs.min(), xs.max() + 1

        # Keep every pixel of alpha inside the blob's bbox (including soft edges),
        # but suppress anything belonging to a neighbouring frame.
        sub_a = alpha[y0:y1, x0:x1].copy()
        keep = ndimage.binary_dilation(mask[y0:y1, x0:x1], iterations=3)
        sub_a[~keep] = 0.0
        sub_rgb = rgb[y0:y1, x0:x1]

        rgba = np.concatenate(
            [np.clip(sub_rgb, 0, 255), np.clip(sub_a[..., None] * 255.0, 0, 255)],
            axis=2,
        ).astype(np.uint8)

        # Re-trim after neighbour suppression.
        aa = rgba[..., 3]
        ys, xs = np.nonzero(aa > 2)
        rgba = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        frames.append(Frame(rgba, rgba.shape[1], rgba.shape[0]))

    return frames


# --------------------------------------------------------------------------------------
# Compose onto the shared canvas
# --------------------------------------------------------------------------------------

def place(frame: Frame, scale: float, mirror: bool) -> Image.Image:
    """Scale a trimmed frame and bottom/centre-align it on the shared canvas."""
    src = Image.fromarray(frame.rgba, "RGBA")
    if mirror:
        src = src.transpose(Image.FLIP_LEFT_RIGHT)

    tw = max(1, round(src.width * scale))
    th = max(1, round(src.height * scale))
    src = src.resize((tw, th), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    x = round((CANVAS - tw) / 2)
    y = BASELINE - th
    canvas.alpha_composite(src, (max(0, x), max(0, y)))
    return canvas


def main() -> None:
    if not RAW.is_dir():
        raise SystemExit(f"missing raw sheet folder: {RAW}")

    print(f"keying {len(SHEETS)} sheets from {RAW.relative_to(ROOT)}")
    sheets: dict[str, list[Frame]] = {}
    for key, fname in SHEETS.items():
        path = RAW / fname
        frames = slice_sheet(path)
        sheets[key] = frames
        dims = " ".join(f"{f.width}x{f.height}" for f in frames)
        print(f"  sheet {key}  {fname:<18} {dims}")

    # One global scale for every frame: the widest/tallest pose in the whole set
    # defines the factor, so the cat never changes size between animations.
    max_w = max(f.width for fs in sheets.values() for f in fs)
    max_h = max(f.height for fs in sheets.values() for f in fs)
    scale = min(
        (CANVAS - 2 * MARGIN) / max_w,
        (BASELINE - MARGIN) / max_h,
    )
    print(f"\nglobal scale {scale:.4f}  (largest raw pose {max_w}x{max_h} -> "
          f"{round(max_w * scale)}x{round(max_h * scale)} on a {CANVAS}px canvas)")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    manifest = {
        "canvas": CANVAS,
        "baseline": BASELINE,
        "source": "rsrc/raw/new2",
        "animations": {},
    }

    for anim in ANIMS:
        folder = OUT / anim.name
        folder.mkdir(parents=True, exist_ok=True)
        files = []
        for i, (sheet, idx) in enumerate(anim.picks):
            img = place(sheets[sheet][idx], scale, anim.mirror)
            rel = f"{anim.name}/{i:03d}.png"
            img.save(OUT / rel)
            files.append(rel)
        manifest["animations"][anim.name] = {
            "frames": files,
            "fps": anim.fps,
            "loop": anim.loop,
            "tags": anim.tags,
        }
        print(f"  {anim.name:<16} {len(files)} frames @ {anim.fps}fps"
              f"{'  loop' if anim.loop else ''}{'  mirrored' if anim.mirror else ''}")

    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    total = sum(len(v["frames"]) for v in manifest["animations"].values())
    print(f"\nwrote {total} frames across {len(ANIMS)} animations -> "
          f"{OUT.relative_to(ROOT)}")

    build_qa(sheets, scale)


# --------------------------------------------------------------------------------------
# QA artefacts
# --------------------------------------------------------------------------------------

def build_qa(sheets: dict[str, list[Frame]], scale: float) -> None:
    CHECK.mkdir(parents=True, exist_ok=True)

    checker = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 255))
    px = checker.load()
    for y in range(CANVAS):
        for x in range(CANVAS):
            if ((x // 8) + (y // 8)) % 2:
                px[x, y] = (205, 205, 215, 255)

    # Per-sheet contact sheet, aligned exactly as the app will see the frames.
    for key, frames in sheets.items():
        sheet_img = Image.new("RGBA", (CANVAS * 4, CANVAS * 2), (0, 0, 0, 0))
        for i, f in enumerate(frames):
            tile = checker.copy()
            tile.alpha_composite(place(f, scale, False))
            sheet_img.paste(tile, ((i % 4) * CANVAS, (i // 4) * CANVAS))
        sheet_img.convert("RGB").save(CHECK / f"sheet_{key}_aligned.png")

    # Animated GIF per animation, on a checker so edge fringe is obvious.
    for anim in ANIMS:
        if len(anim.picks) < 2:
            continue
        gif_frames = []
        for sheet, idx in anim.picks:
            tile = checker.copy()
            tile.alpha_composite(place(sheets[sheet][idx], scale, anim.mirror))
            gif_frames.append(tile.convert("P", palette=Image.ADAPTIVE))
        gif_frames[0].save(
            CHECK / f"anim_{anim.name}.gif",
            save_all=True,
            append_images=gif_frames[1:],
            duration=int(1000 / anim.fps),
            loop=0,
            disposal=2,
        )

    # Zoomed edge crop to eyeball magenta fringe on a dark backdrop.
    f = sheets["B"][0]
    head = Image.fromarray(f.rgba, "RGBA").crop((0, 0, f.width, f.height // 2))
    head = head.resize((head.width * 2, head.height * 2), Image.NEAREST)
    for name, bg in (("dark", (20, 20, 28, 255)), ("green", (0, 180, 60, 255))):
        plate = Image.new("RGBA", head.size, bg)
        plate.alpha_composite(head)
        plate.convert("RGB").save(CHECK / f"edge_check_{name}.png")

    print(f"QA artefacts -> {CHECK.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
