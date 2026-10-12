"""The cat's brain: picks what to do next and where to stand.

Deliberately Qt-free so the behaviour can be reasoned about (and stepped in a plain
loop) without a display. The window layer just reads `clip`, `elapsed` and `x` every
frame and draws accordingly.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

REST_FRONT = "idle_front"
REST_SIDE = "idle_sit_side"
SLEEP = "sleep"
LIE_DOWN = "lie_down"
WALK_LEFT = "walk_left"
WALK_RIGHT = "walk_right"
HELD = "look_at_you"

# Horizontal speed in screen pixels per second, for a cat drawn at 160px.
WALK_SPEED = 46.0

# Energy drains while awake and refills while asleep. Tuned so an untouched cat
# drifts off after roughly ten minutes and naps for about three.
DRAIN_PER_SEC = 1.0 / 600.0
REFILL_PER_SEC = 1.0 / 180.0
TIRED = 0.18
RESTED = 0.92


@dataclass
class Clip:
    """What the brain needs to know about an animation: how long it runs."""

    name: str
    seconds: float
    loop: bool


@dataclass
class Brain:
    clips: dict[str, Clip]
    min_x: float
    max_x: float
    rng: random.Random = field(default_factory=random.Random)

    def __post_init__(self) -> None:
        self.x = (self.min_x + self.max_x) / 2.0
        # The window hands over real screen bounds only after the sprites are sized,
        # so the first set_bounds() re-centres instead of clamping the placeholder.
        self.placed = False
        self.energy = 1.0
        self.clip = REST_FRONT
        self.elapsed = 0.0
        self.hold = 2.5
        self.plan: list[str] = []
        self.held = False
        self.walk_dir = -1
        self.target_x: float | None = None

    # ---- queries ---------------------------------------------------------------

    @property
    def asleep(self) -> bool:
        return self.clip in (SLEEP, LIE_DOWN)

    @property
    def walking(self) -> bool:
        return self.clip in (WALK_LEFT, WALK_RIGHT)

    # ---- external events -------------------------------------------------------

    def set_bounds(self, min_x: float, max_x: float) -> None:
        self.min_x, self.max_x = min_x, max_x
        if not self.placed:
            self.placed = True
            self.x = (min_x + max_x) / 2.0
        else:
            self.x = min(max(self.x, min_x), max_x)

    def grab(self) -> None:
        """Picked up by the mouse: freeze into a dangling pose."""
        self.held = True
        self.energy = min(1.0, self.energy + 0.05)
        self._begin(HELD)

    def drop(self) -> None:
        self.held = False
        self._queue(["startle", REST_FRONT])

    def pet(self) -> None:
        self.energy = min(1.0, self.energy + 0.15)
        self._queue(["happy", REST_FRONT])

    def poke(self) -> None:
        self.energy = min(1.0, self.energy + 0.25)
        self._queue(["startle", "look_at_you", REST_FRONT])

    def wake(self) -> None:
        if self.asleep:
            self.energy = max(self.energy, 0.45)
            self._queue(["stretch", REST_SIDE])

    def put_to_sleep(self) -> None:
        self.energy = min(self.energy, TIRED - 0.01)
        self._queue([LIE_DOWN, SLEEP])

    def come_to(self, x: float) -> None:
        """Walk over to a screen x, then sit and look at the user."""
        self.energy = min(1.0, self.energy + 0.1)
        self.held = False
        self.target_x = min(max(x, self.min_x), self.max_x)
        self.plan = []
        self._start_walk_toward(self.target_x)

    def do(self, clip_name: str) -> None:
        """Play one animation on demand, then settle."""
        if clip_name not in self.clips:
            return
        self.held = False
        self._queue([clip_name, REST_FRONT])

    # ---- main loop -------------------------------------------------------------

    def update(self, dt: float) -> None:
        if self.held:
            self.elapsed += dt
            return

        self.elapsed += dt
        if self.asleep:
            self.energy = min(1.0, self.energy + REFILL_PER_SEC * dt)
        else:
            self.energy = max(0.0, self.energy - DRAIN_PER_SEC * dt)

        if self.walking:
            self._advance_walk(dt)

        if self.elapsed >= self.hold:
            self._next()

    def _advance_walk(self, dt: float) -> None:
        self.x += self.walk_dir * WALK_SPEED * dt

        if self.target_x is not None:
            # Arrived (or overshot) the spot we were called to.
            if (self.walk_dir > 0 and self.x >= self.target_x) or (
                self.walk_dir < 0 and self.x <= self.target_x
            ):
                self.x = self.target_x
                self.target_x = None
                self._queue(["look_at_you", REST_FRONT])
                return

        # Turn around at the edges of the screen instead of walking off it.
        if self.x <= self.min_x:
            self.x = self.min_x
            self._turn(1)
        elif self.x >= self.max_x:
            self.x = self.max_x
            self._turn(-1)

    def _turn(self, direction: int) -> None:
        self.walk_dir = direction
        self.target_x = None
        remaining = max(0.6, self.hold - self.elapsed)
        self._begin(WALK_RIGHT if direction > 0 else WALK_LEFT, hold=remaining)

    # ---- scheduling ------------------------------------------------------------

    def _begin(self, clip_name: str, hold: float | None = None) -> None:
        clip = self.clips[clip_name]
        self.clip = clip_name
        self.elapsed = 0.0
        if hold is not None:
            self.hold = hold
        elif clip.loop:
            self.hold = self._loop_hold(clip_name)
        else:
            self.hold = clip.seconds

    def _loop_hold(self, clip_name: str) -> float:
        if clip_name == SLEEP:
            return self.rng.uniform(8.0, 16.0)
        return self.rng.uniform(2.0, 6.0)

    def _queue(self, plan: list[str]) -> None:
        self.plan = [c for c in plan if c in self.clips]
        self._next()

    def _next(self) -> None:
        if self.plan:
            self._begin(self.plan.pop(0))
            return
        self._decide()

    def _decide(self) -> None:
        # Sleeping: stay down until rested, then get up with a stretch.
        if self.clip == SLEEP:
            if self.energy < RESTED:
                self._begin(SLEEP)
            else:
                self._queue(["stretch", REST_SIDE])
            return

        if self.energy < TIRED:
            self._queue([LIE_DOWN, SLEEP])
            return

        plans: list[tuple[list[str], float]] = [
            (["blink"], 16.0),
            ([REST_FRONT], 10.0),
            ([REST_SIDE], 9.0),
            (["groom"], 6.0),
            (["look_at_you"], 4.0),
            (["stretch"], 4.0),
            (["wave"], 3.0),
            (["happy"], 2.0),
            (["__walk__"], 11.0),
            # Mixed front/side source art, so keep it a rare surprise.
            (["jump"], 1.0),
        ]
        # The sleepier the cat, the more a nap outweighs everything else.
        plans.append(([LIE_DOWN, SLEEP], 1.0 + 14.0 * max(0.0, 0.45 - self.energy)))

        options, weights = zip(*plans)
        plan = list(self.rng.choices(options, weights=weights, k=1)[0])

        if plan[0] == "__walk__":
            self._start_walk(self.rng.uniform(1.8, 5.0))
            return
        self._queue(plan)

    def _start_walk(self, seconds: float) -> None:
        self.target_x = None
        room_left = self.x - self.min_x
        room_right = self.max_x - self.x
        if room_left < 40.0:
            self.walk_dir = 1
        elif room_right < 40.0:
            self.walk_dir = -1
        else:
            self.walk_dir = self.rng.choice((-1, 1))
        self._begin(WALK_RIGHT if self.walk_dir > 0 else WALK_LEFT, hold=seconds)

    def _start_walk_toward(self, x: float) -> None:
        self.walk_dir = 1 if x > self.x else -1
        seconds = abs(x - self.x) / WALK_SPEED + 0.05
        self._begin(WALK_RIGHT if self.walk_dir > 0 else WALK_LEFT, hold=seconds)
