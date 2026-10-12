"""The on-screen cat: a frameless, always-on-top, per-pixel-transparent window."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QElapsedTimer, QPoint, QSettings, Qt, QTimer
from PySide6.QtGui import QAction, QCursor, QGuiApplication, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget

from .behavior import Brain, Clip
from .sprites import SpriteLibrary

TICK_MS = 33  # ~30 Hz; the sprites themselves top out at 11 fps
DRAG_THRESHOLD = 4  # px of movement before a click becomes a drag
HIT_ALPHA = 24  # alpha above which a pixel counts as "the cat" for mouse hits

SIZES = {"Small": 112, "Medium": 160, "Large": 224}
DEFAULT_SIZE = 160


class CatWindow(QWidget):
    def __init__(self, assets: Path) -> None:
        super().__init__(
            None,
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setWindowTitle("Desktop Cat")

        self.settings = QSettings("desktop-cat", "catpet")
        self.sprites = SpriteLibrary(assets)

        self.brain = Brain(
            clips={
                name: Clip(name, clip.seconds, clip.loop)
                for name, clip in self.sprites.clips.items()
            },
            min_x=0.0,
            max_x=1.0,
        )

        self._dragging = False
        self._press_pos: QPoint | None = None
        self._grab_offset = QPoint()
        self._click_through = False
        self._paused = False
        self.tray: QSystemTrayIcon | None = None

        size = int(self.settings.value("size", DEFAULT_SIZE))
        self.apply_size(size if size in SIZES.values() else DEFAULT_SIZE)

        self.tray = self._build_tray()
        self.tray.show()

        # Measure real elapsed time per frame rather than trusting the timer
        # interval: Windows' default timer granularity turns a 33 ms QTimer into
        # roughly 47 ms, which would silently stretch every animation and slow the
        # walk by a third.
        self._clock = QElapsedTimer()
        self._clock.start()
        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.timer.timeout.connect(self._tick)
        self.timer.start(TICK_MS)

    # ---- layout ------------------------------------------------------------------

    def apply_size(self, size: int) -> None:
        self.sprites.rescale(size)
        self.brain.clips = {
            name: Clip(name, clip.seconds, clip.loop)
            for name, clip in self.sprites.clips.items()
        }
        self.setFixedSize(size, size)
        self.settings.setValue("size", size)
        self._refresh_bounds()
        self._reposition()

    def _floor(self) -> int:
        """Screen y of the surface the cat stands on: the top of the taskbar."""
        screen = self.screen() or QGuiApplication.primaryScreen()
        return screen.availableGeometry().bottom()

    def _refresh_bounds(self) -> None:
        screen = self.screen() or QGuiApplication.primaryScreen()
        area = screen.availableGeometry()
        half = self.width() / 2.0
        self.brain.set_bounds(area.left() + half, area.right() - half)

    def _reposition(self) -> None:
        # brain.x is the cat's centre; the sprite's ground line sits `foot_offset`
        # above the bottom of the window, so push the window down by that much to
        # land the paws exactly on the floor.
        x = round(self.brain.x - self.width() / 2.0)
        y = self._floor() - self.height() + self.sprites.foot_offset
        self.move(x, y)

    # ---- frame loop --------------------------------------------------------------

    def _tick(self) -> None:
        # Clamp the step so that waking from sleep or a stalled machine makes the
        # cat resume rather than teleport across the screen.
        dt = min(self._clock.restart() / 1000.0, 0.1)
        if not self._paused:
            self.brain.update(dt)
        if not self._dragging:
            self._reposition()
            self._update_click_through()
        self.update()

    def _update_click_through(self) -> None:
        """Let clicks reach the desktop everywhere except on the cat itself."""
        local = self.mapFromGlobal(QCursor.pos())
        over_cat = (
            self.rect().contains(local)
            and self.sprites.alpha_at(
                self.brain.clip, self.brain.elapsed, local.x(), local.y()
            )
            >= HIT_ALPHA
        )
        want = not over_cat
        if want != self._click_through:
            self._click_through = want
            self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, want)

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt naming)
        clip = self.sprites.clips[self.brain.clip]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        painter.drawPixmap(0, 0, clip.frame_at(self.brain.elapsed))

    # ---- mouse -------------------------------------------------------------------

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        self._press_pos = event.globalPosition().toPoint()
        self._grab_offset = self._press_pos - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._press_pos is None:
            return
        pos = event.globalPosition().toPoint()
        if not self._dragging:
            if (pos - self._press_pos).manhattanLength() < DRAG_THRESHOLD:
                return
            self._dragging = True
            self.brain.grab()
        self.move(pos - self._grab_offset)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        if self._dragging:
            self._dragging = False
            # Remember where we were dropped, then fall back to the floor.
            self.brain.x = self.x() + self.width() / 2.0
            self._refresh_bounds()
            self.brain.x = min(max(self.brain.x, self.brain.min_x), self.brain.max_x)
            self.brain.drop()
        elif self._press_pos is not None:
            if self.brain.asleep:
                self.brain.wake()
            else:
                self.brain.poke()
        self._press_pos = None

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self.brain.pet()

    def contextMenuEvent(self, event) -> None:  # noqa: N802
        self._menu().exec(event.globalPos())

    # ---- tray and menu -----------------------------------------------------------

    def _build_tray(self) -> QSystemTrayIcon:
        icon = QIcon(self.sprites.clips["idle_front"].frames[0])
        if icon.isNull():
            icon = QIcon(QPixmap(32, 32))
        tray = QSystemTrayIcon(icon, self)
        tray.setToolTip("Desktop Cat")
        tray.setContextMenu(self._menu())
        tray.activated.connect(self._on_tray_activated)
        return tray

    def _on_tray_activated(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.brain.come_to(QCursor.pos().x())

    def _menu(self) -> QMenu:
        menu = QMenu(self)

        come = QAction("Come here", menu)
        come.triggered.connect(lambda: self.brain.come_to(QCursor.pos().x()))
        menu.addAction(come)

        for label, clip_name in (
            ("Wave", "wave"),
            ("Groom", "groom"),
            ("Stretch", "stretch"),
        ):
            action = QAction(label, menu)
            action.triggered.connect(lambda _=False, c=clip_name: self.brain.do(c))
            menu.addAction(action)

        nap = QAction("Nap", menu)
        nap.triggered.connect(self.brain.put_to_sleep)
        menu.addAction(nap)

        wake = QAction("Wake up", menu)
        wake.triggered.connect(self.brain.wake)
        menu.addAction(wake)

        menu.addSeparator()

        size_menu = menu.addMenu("Size")
        for label, px in SIZES.items():
            action = QAction(label, size_menu)
            action.setCheckable(True)
            action.setChecked(px == self.width())
            action.triggered.connect(lambda _=False, p=px: self.apply_size(p))
            size_menu.addAction(action)

        pause = QAction("Pause", menu)
        pause.setCheckable(True)
        pause.setChecked(self._paused)
        pause.triggered.connect(self._set_paused)
        menu.addAction(pause)

        menu.addSeparator()

        quit_action = QAction("Quit", menu)
        quit_action.triggered.connect(QApplication.quit)
        menu.addAction(quit_action)

        return menu

    def _set_paused(self, paused: bool) -> None:
        self._paused = paused
        if self.tray is not None:
            self.tray.setContextMenu(self._menu())
