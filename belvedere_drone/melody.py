"""Constrained weighted random walk over a chamber's playable notes (SPEC §8).

Deliberately legible and hand-tunable rather than learned. The walk moves over
scale *positions*, never over semitones, because the instrument's scale is not
chromatic and a "step" means the next hole, not the next semitone.

Determinism is a requirement, not a nicety (acceptance criterion 5): everything
random here comes from the caller's `random.Random`, so a seed reproduces a
performance exactly.
"""


class Note:
    """One scheduled melody note, in seconds from the start of the breath."""

    def __init__(self, name, start_s, dur_s, velocity, is_grace=False):
        self.name = name
        self.start_s = start_s
        self.dur_s = dur_s
        self.velocity = velocity
        self.is_grace = is_grace

    def __repr__(self):
        kind = "grace" if self.is_grace else "note"
        return f"<{kind} {self.name} @{self.start_s:.2f}s {self.dur_s:.2f}s>"


GRACE_S = 0.06


def _biased_start(rng, count, register_bias):
    """Pick a starting scale position, biased low or high by the mood."""
    centre = (count - 1) * (0.5 + register_bias * 0.35)
    spread = max(count * 0.25, 1.0)
    pos = int(round(rng.gauss(centre, spread)))
    return max(0, min(count - 1, pos))


def _step(rng, pos, count):
    if pos == 0:
        return 1 if count > 1 else 0
    if pos == count - 1:
        return count - 2
    return pos + rng.choice((-1, 1))


def _leap(rng, pos, count):
    """A 3rd, 4th or 5th in scale positions, larger leaps weighted down."""
    size = rng.choices((2, 3, 4), weights=(0.55, 0.30, 0.15))[0]
    direction = rng.choice((-1, 1))
    target = pos + size * direction
    if target < 0 or target > count - 1:
        target = pos - size * direction
    return max(0, min(count - 1, target))


def schedule(rng, notes, mood, breath_len_s, root, layer_velocity):
    """Return the melody for one breath as a time-ordered list of Note.

    `notes` is the chamber's playable notes in ascending pitch order; `root` is
    the drone root, used for the cadence.
    """
    count = len(notes)
    if count == 0:
        raise ValueError("melody chamber has no playable notes")

    n = max(1, int(round(mood.notes_per_breath * rng.uniform(0.85, 1.15))))
    a, b = mood.phrase_shape
    times = sorted(rng.betavariate(a, b) * breath_len_s for _ in range(n))

    pos = _biased_start(rng, count, mood.register_bias)
    scheduled = []
    for i, t in enumerate(times):
        if rng.random() < mood.step_leap_ratio:
            pos = _step(rng, pos, count)
        else:
            pos = _leap(rng, pos, count)

        end = times[i + 1] if i + 1 < len(times) else breath_len_s
        dur = max(end - t, 0.08)

        # Dynamic sweep: an arch across the breath, depth set by the mood.
        phase = t / breath_len_s if breath_len_s else 0.0
        arch = 1.0 - mood.sweep_depth * abs(2.0 * phase - 1.0)
        velocity = max(1, min(127, int(round(layer_velocity * arch))))

        if rng.random() < mood.ornament_rate and t > GRACE_S:
            neighbour = _step(rng, pos, count)
            scheduled.append(Note(notes[neighbour], t - GRACE_S, GRACE_S,
                                  velocity, is_grace=True))
        scheduled.append(Note(notes[pos], t, dur, velocity))

    # Cadence: land the phrase on the drone root, if the chamber can sound it.
    if root in notes and rng.random() < mood.cadence_strength:
        last = scheduled[-1]
        last.name = root

    scheduled.sort(key=lambda x: x.start_s)
    return scheduled
