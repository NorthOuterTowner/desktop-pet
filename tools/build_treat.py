"""Cut the raw fish drawing into the treat sprites the renderer puts on the floor.

The drawing holds four treats side by side: two whole fish, one with a bite taken out
of it, and a pile of crumbs. Three of those are the stages of one fish being eaten, so
this slices them out and -- the part that matters -- writes all three on a *common
canvas* at a *common scale*, bottom-aligned and centred. That is what lets the
renderer swap the image between bites and have the treat appear to shrink in place
rather than jump around and change size.

Treats are found by dilating the alpha before labelling, so the pile of crumbs is
grouped as one treat instead of a dozen specks. Like the app icons, the output is
committed: running the app never needs Python.

    python tools/build_treat.py

Reads:
    rsrc/raw/new-10.13/fish_source.png   the drawing as generated, four treats on it
Writes:
    icons/fish.png                       whole, before the first bite
    icons/fish_bitten.png                after a bite
    icons/fish_crumbs.png                the last of it
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
    from scipy import ndimage
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("Pillow, numpy and scipy are required: pip install -r requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "rsrc" / "raw" / "new-10.13" / "fish_source.png"
OUT_DIR = ROOT / "icons"

# Longest side of the whole fish, in pixels. The cat stands 124px tall on screen
# (TARGET_SIT_HEIGHT in src/renderer.js) and the fish is drawn at about half that
# long, so 128 stays sharp on a 2x display without shipping a megabyte.
TARGET = 128
# Alpha above which a pixel is part of a treat.
SOLID = 8
# How far apart two bits of treat can be and still count as the same treat. Sized for
# the crumbs, which are a dozen specks scattered over a few tens of pixels.
GAP = 18
# Stage order, as the renderer walks through it bite by bite.
STAGES = ("fish.png", "fish_bitten.png", "fish_crumbs.png")


def treats(image: Image.Image) -> list[tuple[int, int, int, int]]:
    """Bounding boxes of the separate treats, in reading order."""
    alpha = np.asarray(image)[..., 3] > SOLID
    merged = ndimage.binary_dilation(alpha, np.ones((3, 3), bool), iterations=GAP)
    labels, count = ndimage.label(merged)
    if count == 0:
        sys.exit(f"{SOURCE.relative_to(ROOT)} is fully transparent")

    found = []
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        rows, cols = box
        # Measure the real pixels, not the dilated ones.
        if int(alpha[box].sum()) < 200:
            continue
        found.append((cols.start, rows.start, cols.stop, rows.stop))

    # Reading order: top row left to right, then the bottom row. Rows are banded by
    # half the sheet so a treat sitting slightly higher than its neighbour does not
    # sort ahead of it.
    band = image.height // 2
    found.sort(key=lambda b: (b[1] // band, b[0]))
    return found


def main() -> int:
    if not SOURCE.is_file():
        sys.exit(f"missing {SOURCE.relative_to(ROOT)}")

    sheet = Image.open(SOURCE).convert("RGBA")
    boxes = treats(sheet)
    if len(boxes) < 4:
        sys.exit(f"expected 4 treats on the sheet, found {len(boxes)}")

    # Two whole fish were drawn; the first is as good as the second. The eaten stages
    # are the bottom row.
    chosen = [boxes[0], boxes[2], boxes[3]]

    whole = sheet.crop(chosen[0])
    scale = TARGET / max(whole.width, whole.height)

    # One scale for all three, so a bite makes the treat smaller rather than
    # redrawing it at a new size.
    crops = []
    for box in chosen:
        crop = sheet.crop(box)
        size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
        crops.append(crop.resize(size, Image.LANCZOS))

    canvas = (max(c.width for c in crops), max(c.height for c in crops))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for name, crop in zip(STAGES, crops):
        frame = Image.new("RGBA", canvas, (0, 0, 0, 0))
        # Centred and sitting on the bottom edge: the treat is on the floor, so the
        # floor is the one edge that must not move between stages.
        frame.paste(
            crop,
            ((canvas[0] - crop.width) // 2, canvas[1] - crop.height),
            crop,
        )
        target = OUT_DIR / name
        frame.save(target, format="PNG", optimize=True)
        print(
            f"wrote {target.relative_to(ROOT)} "
            f"({crop.width}x{crop.height} on a {canvas[0]}x{canvas[1]} canvas, "
            f"{target.stat().st_size / 1024:.0f} KB)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
