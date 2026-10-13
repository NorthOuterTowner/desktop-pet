/**
 * The Settings panel: an in-page overlay with three sliders.
 *
 * It is part of the page, not a separate window, so the sliders feed the live cat
 * with no round trip -- drag the size and the cat resizes under your hand. The panel
 * is non-modal: the window stays click-through everywhere except over the panel (and
 * the cat). The renderer's hit test asks `contains()` / `capturing` each frame.
 *
 * The three values are the single source of truth for how big the cat and the fish
 * are drawn and how loud it is. The renderer reads `catScale`/`fishScale` every frame
 * and audio reads the volume; nothing here reaches into them.
 */

/** Each slider: the setting it drives, its range as shown, and how it reads out. */
const SLIDERS = [
  {
    key: 'volume',
    label: 'Volume',
    min: 0,
    max: 100,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
  },
  {
    key: 'catScale',
    label: 'Cat size',
    min: 60,
    max: 180,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
  },
  {
    // Shown as a share of the cat: 100 means "as big as the cat", which is the whole
    // joke -- wind it up and the cat is offered a fish its own size.
    key: 'fishScale',
    label: 'Fish size',
    min: 20,
    max: 100,
    step: 1,
    format: (v) => (v >= 100 ? 'as big as the cat!' : `${Math.round(v)}%`),
  },
];

/** Defaults, in the slider's own units (percent). */
const DEFAULTS = { volume: 30, catScale: 100, fishScale: 45 };

export class Settings {
  /**
   * @param {object} hooks
   * @param {(volume: number) => void} hooks.onVolume  0..1.
   */
  constructor({ onVolume }) {
    this.onVolume = onVolume;
    // True from a mousedown on the panel until the matching mouseup, so the renderer
    // keeps the window holding the mouse through a slider or title drag that slides
    // off the panel.
    this.capturing = false;
    // Set by the renderer: called when the cat-size slider moves, so the live cat is
    // re-laid-out under the user's hand. Fish size is read lazily, so needs no hook.
    this.onCatSize = null;
    this.values = { ...DEFAULTS };
    this.open = false;
    this._build();
    this._apply('volume');
  }

  /** Cat height as a multiple of its default. Read by the renderer every frame. */
  get catScale() {
    return this.values.catScale / 100;
  }

  /**
   * Fish length as a fraction of the cat's height. At the top of the range this is
   * 1.0 -- a fish as tall as the cat -- which is why the renderer sizes the fish off
   * the cat's current drawn height.
   */
  get fishScale() {
    return this.values.fishScale / 100;
  }

  /**
   * Show the panel next to the cat.
   * @param {number} catX - the cat's current left edge, in window pixels.
   * @param {number} catWidth - the cat's render width.
   * @param {number} catBottom - the cat's bottom edge from the window top.
   */
  show(catX, catWidth, catBottom) {
    if (this.open) return;
    this.open = true;
    this.root.hidden = false;
    // Position the panel to the right of the cat, flipping to the left side if the
    // cat is too close to the right edge of the screen. The panel sits above the cat
    // a bit, so it doesn't cover it.
    const PANEL_WIDTH = 300;
    const PANEL_HEIGHT = 240;
    const padding = 12;
    const under = window.innerWidth - (catX + catWidth + padding + PANEL_WIDTH);
    const flipLeft = under < 0;
    const left = flipLeft ? catX - PANEL_WIDTH - padding : catX + catWidth + padding;
    // Place it above the cat's feet, keeping it inside the window top.
    const top = Math.max(padding, catBottom - PANEL_HEIGHT - padding);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
    this.root.style.right = 'auto';
    this.root.style.bottom = 'auto';
    // No global mouse grab: the window stays click-through, only the panel's own
    // interactive elements (the sliders and Done button) receive events.
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    this.capturing = false;
    this.dragging = null;
  }

  /** Is this window-relative point on the panel? Used by the renderer's hit test. */
  contains(x, y) {
    if (!this.open) return false;
    const r = this.root.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  // ---- dragging --------------------------------------------------------------------

  _onDragStart(event) {
    if (event.button !== 0) return;
    // Any press on the panel holds the mouse until release (sliders included).
    this.capturing = true;
    // Only the title bar moves the panel; sliders and the button keep their own drag.
    if (!event.target.classList.contains('settings-title')) return;
    this.dragging = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: this.root.offsetLeft,
      startTop: this.root.offsetTop,
    };
    event.preventDefault();
  }

  _onDrag(event) {
    if (!this.dragging) return;
    // A missed mouseup (released outside the window) would leave the panel stuck.
    if (event.buttons === 0) {
      this._onDragEnd();
      return;
    }
    const dx = event.clientX - this.dragging.startX;
    const dy = event.clientY - this.dragging.startY;
    // Keep the title bar reachable: clamp the panel inside the window.
    const maxLeft = window.innerWidth - this.root.offsetWidth;
    const maxTop = window.innerHeight - this.root.offsetHeight;
    const left = Math.min(Math.max(0, this.dragging.startLeft + dx), Math.max(0, maxLeft));
    const top = Math.min(Math.max(0, this.dragging.startTop + dy), Math.max(0, maxTop));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  _onDragEnd() {
    this.dragging = null;
    this.capturing = false;
  }

  // ---- building the panel ---------------------------------------------------------

  _build() {
    this.dragging = null;
    this.root = document.createElement('div');
    this.root.id = 'settings';
    this.root.hidden = true;
    // Dragging the title moves the whole panel.
    this.root.addEventListener('mousedown', (e) => this._onDragStart(e));
    window.addEventListener('mousemove', (e) => this._onDrag(e));
    window.addEventListener('mouseup', () => this._onDragEnd());

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Settings';
    this.root.appendChild(title);

    this.readouts = {};
    for (const slider of SLIDERS) {
      const row = document.createElement('label');
      row.className = 'settings-row';

      const name = document.createElement('span');
      name.className = 'settings-label';
      name.textContent = slider.label;

      const value = document.createElement('span');
      value.className = 'settings-value';

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(slider.step);
      input.value = String(this.values[slider.key]);
      input.addEventListener('input', () => {
        this.values[slider.key] = Number(input.value);
        this._apply(slider.key);
      });

      row.append(name, input, value);
      this.root.appendChild(row);
      this.readouts[slider.key] = { value, format: slider.format };
      this._readout(slider.key);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'settings-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.hide());
    this.root.appendChild(close);

    document.body.appendChild(this.root);
  }

  _readout(key) {
    const { value, format } = this.readouts[key];
    value.textContent = format(this.values[key]);
  }

  _apply(key) {
    this._readout(key);
    if (key === 'volume') this.onVolume(this.values.volume / 100);
    // Cat size resizes the live cat now; fish size is read the next time a fish
    // appears, so it needs no push.
    if (key === 'catScale' && this.onCatSize) this.onCatSize();
  }
}
