"""Sprite loading: reads assets/sprites/manifest.json into scaled, ready-to-draw clips."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QPixmap


@dataclass(frozen=True)
class Clip:
    """One playable animation at the current display scale."""

    name: str
    frames: tuple[QPixmap, ...]
    fps: float
    loop: bool
    tags: tuple[str, ...]

    @property
    def frame_seconds(self) -> float:
        return 1.0 / self.fps

    @property
    def seconds(self) -> float:
        return len(self.frames) / self.fps

    def frame_at(self, elapsed: float) -> QPixmap:
        i = int(elapsed * self.fps)
        if self.loop:
            i %= len(self.frames)
        else:
            i = min(i, len(self.frames) - 1)
        return self.frames[i]


class SpriteLibrary:
    """Loads the manifest once, then re-renders pixmaps whenever the scale changes.

    The source PNGs are all drawn on one 256px canvas with a shared ground line, so
    every clip can be blitted at the same window size with no per-frame bookkeeping.
    """

    def __init__(self, assets: Path) -> None:
        self.assets = assets
        manifest_path = assets / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(
                f"no sprite manifest at {manifest_path}\n"
                "run:  python tools/build_sprites.py"
            )
        data = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.canvas: int = data["canvas"]
        self.baseline: int = data["baseline"]
        self._spec: dict = data["animations"]
        self._sources: dict[str, list[QImage]] = {}
        for name, spec in self._spec.items():
            images = []
            for rel in spec["frames"]:
                img = QImage(str(assets / rel))
                if img.isNull():
                    raise FileNotFoundError(f"could not load sprite frame {rel}")
                images.append(img.convertToFormat(QImage.Format.Format_ARGB32))
            self._sources[name] = images

        self.size = self.canvas
        self.clips: dict[str, Clip] = {}
        self.rescale(self.canvas)

    def rescale(self, size: int) -> None:
        """Re-render every clip at a new square window size, in pixels."""
        self.size = size
        self.clips = {}
        for name, spec in self._spec.items():
            frames = tuple(
                QPixmap.fromImage(
                    img.scaled(
                        size,
                        size,
                        Qt.AspectRatioMode.IgnoreAspectRatio,
                        Qt.TransformationMode.SmoothTransformation,
                    )
                )
                for img in self._sources[name]
            )
            self.clips[name] = Clip(
                name=name,
                frames=frames,
                fps=float(spec["fps"]),
                loop=bool(spec["loop"]),
                tags=tuple(spec.get("tags", ())),
            )

    @property
    def foot_offset(self) -> int:
        """Pixels between the sprite's ground line and the bottom of the window."""
        return round((self.canvas - self.baseline) * self.size / self.canvas)

    def alpha_at(self, clip_name: str, elapsed: float, x: int, y: int) -> int:
        """Alpha of the currently shown pixel, for per-pixel mouse hit testing."""
        images = self._sources[clip_name]
        clip = self.clips[clip_name]
        i = int(elapsed * clip.fps)
        i = i % len(images) if clip.loop else min(i, len(images) - 1)
        img = images[i]
        sx = int(x * self.canvas / self.size)
        sy = int(y * self.canvas / self.size)
        if not (0 <= sx < img.width() and 0 <= sy < img.height()):
            return 0
        return img.pixelColor(sx, sy).alpha()
