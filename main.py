"""Entry point: python main.py"""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication, QMessageBox

from catpet.window import CatWindow

ASSETS = Path(__file__).resolve().parent / "assets" / "sprites"


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Desktop Cat")
    # The cat is the only window; closing it should not be the thing that quits,
    # the tray menu is.
    app.setQuitOnLastWindowClosed(False)

    try:
        cat = CatWindow(ASSETS)
    except FileNotFoundError as exc:
        QMessageBox.critical(None, "Desktop Cat", str(exc))
        return 1

    cat.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
