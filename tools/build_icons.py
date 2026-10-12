"""Generate the application icons the installers ship with.

The app already has exactly one canonical picture of itself -- the resting front sit
that the tray uses -- so the icons are derived from that rather than drawn separately.
Nothing here is needed to run the app; it is a build-time step whose output is
committed, so packaging (and CI) never needs Python.

    python tools/build_icons.py

Writes:
    build/icon.png          1024px master. electron-builder derives .icns from it.
    build/icon.ico          multi-resolution Windows icon, used by the NSIS installer.
    build/icons/<n>x<n>.png the hicolor sizes Linux .deb/.rpm install into the theme.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("Pillow is required: pip install -r requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "sprites" / "sit" / "000.png"
OUT_DIR = ROOT / "build"

MASTER = 1024

# The sprite sits on a 256px canvas with a lot of headroom above it and a ground line
# below. Icons are read at 16px in a taskbar, so the cat is cropped to its own pixels
# and then scaled to fill most of the square -- but not all of it, because macOS and
# most Linux themes expect a little breathing room inside the icon bounds.
FILL = 0.88

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
LINUX_SIZES = (16, 32, 48, 64, 128, 256, 512, 1024)


def square_master() -> Image.Image:
    """The cat, cropped to its own alpha and centred on a transparent square."""
    if not SOURCE.is_file():
        sys.exit(f"missing sprite {SOURCE}; run `npm run assets` first")

    sprite = Image.open(SOURCE).convert("RGBA")
    box = sprite.getbbox()
    if box is None:
        sys.exit(f"{SOURCE} is fully transparent")
    cat = sprite.crop(box)

    budget = int(MASTER * FILL)
    scale = min(budget / cat.width, budget / cat.height)
    size = (max(1, round(cat.width * scale)), max(1, round(cat.height * scale)))
    cat = cat.resize(size, Image.LANCZOS)

    canvas = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    canvas.paste(cat, ((MASTER - cat.width) // 2, (MASTER - cat.height) // 2), cat)
    return canvas


def main() -> int:
    master = square_master()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icon_png = OUT_DIR / "icon.png"
    master.save(icon_png, format="PNG")
    print(f"wrote {icon_png.relative_to(ROOT)} ({MASTER}x{MASTER})")

    # Pillow downsamples each embedded size from the master itself, which is sharper at
    # 16px than letting Windows scale one large frame down on the fly.
    icon_ico = OUT_DIR / "icon.ico"
    master.save(icon_ico, format="ICO", sizes=[(n, n) for n in ICO_SIZES])
    print(f"wrote {icon_ico.relative_to(ROOT)} ({', '.join(map(str, ICO_SIZES))})")

    icons_dir = OUT_DIR / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for n in LINUX_SIZES:
        target = icons_dir / f"{n}x{n}.png"
        frame = master if n == MASTER else master.resize((n, n), Image.LANCZOS)
        frame.save(target, format="PNG")
    print(
        f"wrote {icons_dir.relative_to(ROOT)}/ "
        f"({', '.join(f'{n}x{n}' for n in LINUX_SIZES)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
