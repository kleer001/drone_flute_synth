"""Melody as motif and phrase, not as a random walk (SPEC §8).

The first version drew each breath fresh: a new random start, a drunkard's walk
over scale positions, and onsets drawn from a Beta distribution. It had variety
and no unity, so nothing was ever restated, nothing was recognisable, and the
line meandered. It also had no rhythmic spine -- every onset was an independent
real number, so there was no pulse to lean on.

This version follows the melodic grammar in the sibling repos:

* **A motif, repeated and varied.** A 3-5 note cell is stated, restated, and
  transformed (sequence, inversion, retrograde, augmentation, fragmentation).
  Unity comes from the repetition and variety from the transformation, rather
  than from fresh randomness each time.
* **A meter.** The profile carries a tempo and a bar length, and every breath
  resolves to a bar line (SPEC section 5). Onsets fall on eighth-note positions
  and durations are conventional values -- eighth, quarter, dotted quarter,
  half, dotted half, whole -- so the line can be written down and read back.
  Accent follows the bar: downbeats are strongest, other beats next, offbeats
  weakest.
* **One arch, peaking late.** Statements are transposed to follow a contour that
  rises to a single climax in the back half and falls to the cadence.
* **Stable and active degrees.** Stability is measured against the drone, since
  the drone is the only harmony present: unison and fifth are rest points,
  thirds and sixths are softer ones, everything else wants to move. A phrase
  resolves onto a rest point instead of having the root pasted over its last
  note.
* **Gap-fill.** A leap opens a gap, and the next notes step back into it.
* **Ornaments between the structural notes.** The skeleton stays simple; the
  flourish is the personality.

Everything random comes from the caller's `random.Random`, so a seed still
reproduces a performance exactly (acceptance criterion 5).
"""
from .profile import midi_of

GRACE_S = 0.06
# Conventional note values, in eighths, longest first: whole, dotted half,
# half, dotted quarter, quarter, eighth. A structural note is always one of
# these, so every phrase is notatable.
NOTE_VALUES = (8, 6, 4, 3, 2, 1)
ARTICULATION = 0.9           # a note stops short of the next onset, so it breathes
CLIMAX_AT = 0.68             # one high point, in the back half

# Interval to the drone, in semitones, folded into an octave. Unison and fifth
# are where a phrase can come to rest; thirds and sixths are softer rest points.
STRONG_REST = (0, 7)
WEAK_REST = (3, 4, 8, 9)


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


def fit_value(want, room):
    """The longest conventional value that is no longer than `want` or `room`."""
    limit = min(want, room)
    for value in NOTE_VALUES:
        if value <= limit:
            return value
    return 0


def stability(notes, root):
    """2 = strong rest, 1 = weak rest, 0 = active, per scale position."""
    r = midi_of(root)
    out = []
    for name in notes:
        step = (midi_of(name) - r) % 12
        out.append(2 if step in STRONG_REST else 1 if step in WEAK_REST else 0)
    return out


# -- the motif and its transformations ------------------------------------
# Each is a pure function over a list of (step, units): the cheapest and most
# principled way to earn variety from recombination.

def new_motif(rng, mood):
    """A 3-5 cell idea: mostly stepwise, with a rhythm it can be known by."""
    length = rng.choice((3, 3, 4, 4, 5))
    steps, durs = [], []
    for i in range(length):
        if i == 0:
            steps.append(0)
        elif rng.random() < mood.step_leap_ratio:
            steps.append(rng.choice((-1, 1, 1)))
        else:
            steps.append(rng.choice((-3, -2, 2, 3)))
        durs.append(rng.choice((1, 1, 1, 2, 2, 3)))
    return list(zip(steps, durs))


def transpose(motif, by):
    """Tonal sequence: restate at another pitch level, along the scale."""
    return [(s + by if i == 0 else s, d) for i, (s, d) in enumerate(motif)]


def invert(motif):
    """Mirror the contour: every rise becomes the same fall."""
    return [(-s, d) for s, d in motif]


def retrograde(motif):
    return list(reversed(motif))


def augment(motif):
    return [(s, d * 2) for s, d in motif]


def diminish(motif):
    return [(s, max(1, d // 2)) for s, d in motif]


def fragment(motif, rng):
    """Keep a sub-segment and let it stand for the whole."""
    if len(motif) <= 2:
        return motif
    n = rng.randint(2, len(motif) - 1)
    start = rng.randint(0, len(motif) - n)
    return motif[start:start + n]


TRANSFORMS = (
    ("repeat", lambda m, rng: m),
    ("sequence", lambda m, rng: transpose(m, rng.choice((-2, -1, 1, 2)))),
    ("invert", lambda m, rng: invert(m)),
    ("retrograde", lambda m, rng: retrograde(m)),
    ("augment", lambda m, rng: augment(m)),
    ("diminish", lambda m, rng: diminish(m)),
    ("fragment", lambda m, rng: fragment(m, rng)),
)
# Repetition is what makes a motif recognisable, so it is weighted highest;
# without it the transformations have nothing to vary from.
TRANSFORM_WEIGHTS = (4, 3, 2, 2, 1, 1, 2)

# An answer is a reply, not development: restating the call higher, mirroring
# it, or running it backwards all read as a response to what was just said.
# Augmentation and diminution stretch material rather than answer it.
ANSWER_TRANSFORMS = ("sequence", "invert", "retrograde", "fragment")
ANSWER_WEIGHTS = (3, 3, 2, 2)

# Developing variation: a restated call is varied, not photocopied. Returning
# the cell verbatim made every call breath in a run sound the same -- unity
# with nothing developing, which is monotony wearing a different hat.
RESTATE_TRANSFORMS = ("repeat", "sequence", "fragment", "diminish")
RESTATE_WEIGHTS = (2, 4, 2, 1)


def _arch(position):
    """0 at the phrase edges, 1 at the climax -- a rise and a longer fall."""
    if position <= CLIMAX_AT:
        return position / CLIMAX_AT
    return max(0.0, (1.0 - position) / (1.0 - CLIMAX_AT))


class Phrasing:
    """Carries the motif between breaths, which is where unity comes from."""

    def __init__(self, rng, notes, root):
        self.rng = rng
        self.notes = notes
        self.root = root
        self.stability = stability(notes, root)
        self.motif = None          # the current pair's cell
        self.call_motif = None     # what the answer must quote
        self.base = None           # the cell this breath is working with
        self.relation = "new"      # how this breath relates to the last
        self.statements = 0
        # Breaths alternate roles: a call that leaves the line open, then an
        # answer that ornaments it and resolves. Tension and release as a
        # phrase-pair, with the breath as the phrase.
        self.role = "call"
        self.last_role = "call"

    # -- helpers ----------------------------------------------------------

    def _rest_positions(self, strong=True):
        want = 2 if strong else 1
        found = [i for i, s in enumerate(self.stability) if s >= want]
        return found or list(range(len(self.notes)))

    def _clamp(self, pos):
        return max(0, min(len(self.notes) - 1, pos))

    def _fold(self, pos):
        """Reflect off the ends of the range instead of pinning against them.

        Clamping makes a line stick: every downward step at position 0 lands on
        position 0 again, and the phrase repeats one note until the motif turns
        around. Reflecting keeps it moving and mimics what a player does at the
        end of the instrument's range -- turn back.
        """
        top = len(self.notes) - 1
        if top <= 0:
            return 0
        while pos < 0 or pos > top:
            pos = -pos if pos < 0 else 2 * top - pos
        return pos

    def begin_breath(self, mood, answering):
        """Choose the material this breath works with.

        Two levels of unity. Across a pair, an **answer quotes its call**: it is
        always a transformation of the call's own cell, never fresh material, so
        the two breaths are demonstrably talking about the same thing. Across
        pairs, the rule of three -- a pair's material is reused about three
        times before anything new is invented.
        """
        if answering and self.call_motif is not None:
            pick = self.rng.choices(ANSWER_TRANSFORMS,
                                    weights=ANSWER_WEIGHTS)[0]
            self.base = dict(TRANSFORMS)[pick](self.call_motif, self.rng)
            self.relation = pick
        else:
            if self.motif is None or self.statements >= self.rng.choice((2, 2, 3)):
                self.motif = new_motif(self.rng, mood)
                self.statements = 0
                self.base = self.motif
                self.relation = "new"
            else:
                self.statements += 1
                pick = self.rng.choices(RESTATE_TRANSFORMS,
                                        weights=RESTATE_WEIGHTS)[0]
                self.base = dict(TRANSFORMS)[pick](self.motif, self.rng)
                self.relation = pick
            # The answer replies to what was actually just played, not to the
            # canonical cell it came from.
            self.call_motif = self.base
        return self.base

    def _restate(self):
        """A later statement inside one breath: vary the breath's own cell."""
        names = [n for n, _ in TRANSFORMS]
        pick = self.rng.choices(names, weights=TRANSFORM_WEIGHTS)[0]
        return dict(TRANSFORMS)[pick](self.base, self.rng)

    # -- ornaments --------------------------------------------------------

    def _trill(self, pos, start_s, dur_s, velocity, unit_s, held):
        """Shake with the upper neighbour, then resolve onto the main note.

        The shakes are grace: they decorate, and the note the motif asked for
        is the resolution, which lands on a grid position with a conventional
        value of its own. A trill therefore never moves the skeleton.
        """
        upper = self._fold(pos + 1)
        tail = 2 if held >= 6 else 1              # units the resolution keeps
        shake_units = held - tail
        shake_s = shake_units * unit_s
        n = max(2, shake_units * 4)               # four shakes to the unit
        rate = shake_s / n
        out = [Note(self.notes[pos if i % 2 == 0 else upper],
                    start_s + i * rate, rate,
                    velocity if i % 2 == 0 else max(1, int(velocity * .9)),
                    is_grace=True)
               for i in range(n)]
        out.append(Note(self.notes[pos], start_s + shake_s,
                        tail * unit_s * ARTICULATION, velocity))
        return out

    def _ornament(self, pos, start_s, velocity, mood):
        """Grace notes leaning into the beat, ahead of the structural note.

        They borrow from the silence before the note rather than from the note
        itself, so the skeleton keeps both its grid position and its written
        value. That is what a grace note is.
        """
        kind = self.rng.choices(("grace", "mordent", "turn"),
                                weights=(3, 2, 2))[0]
        shape = {"grace": (self.rng.choice((-1, 1)),),
                 "mordent": (0, -1),
                 "turn": (1, 0, -1)}[kind]
        lead = GRACE_S * len(shape)
        if start_s < lead:
            return []
        return [Note(self.notes[self._clamp(pos + offset)],
                     start_s - lead + i * GRACE_S, GRACE_S,
                     max(1, int(velocity * 0.85)), is_grace=True)
                for i, offset in enumerate(shape)]

    def _run_into(self, from_pos, to_pos, arrive_s, unit_s, velocity):
        """A fast scalar dash filling the gap before a structural note."""
        span = to_pos - from_pos
        steps = [from_pos + (1 if span > 0 else -1) * i
                 for i in range(1, abs(span))]
        if not steps:
            return []
        rate = min(0.09, unit_s / max(2, len(steps)))
        first = arrive_s - rate * len(steps)
        if first < 0:
            return []
        return [Note(self.notes[self._clamp(p)], first + i * rate, rate,
                     max(1, int(velocity * 0.8)), is_grace=True)
                for i, p in enumerate(steps)]

    # -- one breath -------------------------------------------------------

    def breath(self, mood, meter, breath_len_s, layer_velocity):
        rng = self.rng
        if not self.notes:
            raise ValueError("melody chamber has no playable notes")

        # Call and answer: the call sits lower, stays plainer and tends to
        # leave the phrase open; the answer climbs, decorates and resolves.
        answering = self.role == "answer"
        contrast = mood.call_response
        orn_rate = min(1.0, mood.ornament_rate *
                       (1.0 + 0.9 * contrast if answering else 1.0 - 0.7 * contrast))
        trill_rate = min(1.0, mood.trill_rate *
                         (1.0 + contrast if answering else 1.0 - 0.8 * contrast))
        cadence_p = min(1.0, mood.cadence_strength *
                        (1.0 + contrast if answering else 1.0 - contrast))

        # The breath is a whole number of beats, so this division is exact.
        units = max(2, round(breath_len_s / meter.unit_s))
        unit_s = meter.unit_s
        # notes_per_breath sets how much of the breath carries notes; the rest
        # is silence the phrase can breathe in.
        budget = max(2, min(units, int(round(mood.notes_per_breath * 1.4))))

        span = max(1.5, (len(self.notes) - 1) * 0.45)
        centre = ((len(self.notes) - 1) * (0.5 + mood.register_bias * 0.35)
                  + span * (0.5 if answering else -0.5) * contrast)

        base = self.begin_breath(mood, answering)
        first_statement = True

        scheduled = []
        pos = self._clamp(int(round(centre)))
        at = 0                                     # position, in units
        placed = 0
        prev_pos = pos

        while at < units and placed < budget:
            motif = base if first_statement else self._restate()
            first_statement = False
            # Follow the arch: transpose this statement toward the contour.
            target = centre + span * (_arch(at / units) * 2.0 - 1.0) * 0.55
            pos = self._fold(int(round(target)))

            for step, dur in motif:
                if at >= units or placed >= budget:
                    break
                leap = abs(step) > 1
                # Gap-fill: after a leap, the ear wants stepwise motion back.
                if leap and scheduled and rng.random() < 0.7:
                    step = -1 if step > 0 else 1
                prev_pos, pos = pos, self._fold(pos + step)

                start_s = at * unit_s
                held = fit_value(dur, units - at)
                if held == 0:
                    break
                dur_s = held * unit_s * ARTICULATION

                # Metric hierarchy, from the bar rather than from the phrase:
                # a downbeat is the strong position, other beats are next, and
                # anything between beats is weakest.
                if at % meter.units_per_measure == 0:
                    accent = 1.0
                elif at % meter.UNITS_PER_BEAT == 0:
                    accent = 0.94
                else:
                    accent = 0.86
                arch = 1.0 - mood.sweep_depth * abs(2.0 * (at / units) - 1.0)
                velocity = max(1, min(127, int(round(
                    layer_velocity * arch * accent))))

                if abs(pos - prev_pos) > 2 and rng.random() < orn_rate:
                    scheduled += self._run_into(prev_pos, pos, start_s,
                                                unit_s, velocity)
                if held >= 4 and rng.random() < trill_rate:
                    scheduled += self._trill(pos, start_s, dur_s, velocity,
                                             unit_s, held)
                else:
                    if rng.random() < orn_rate:
                        scheduled += self._ornament(pos, start_s, velocity,
                                                    mood)
                    scheduled.append(Note(self.notes[pos], start_s, dur_s,
                                          velocity))
                at += held
                placed += 1

            at += rng.choice((1, 1, 2))            # breathe between statements

        # Cadence: land on a rest point rather than overwriting with the root.
        # A call is meant to stay open, so it resolves far less often.
        if scheduled and rng.random() < cadence_p:
            rests = self._rest_positions(strong=True)
            last = max((n for n in scheduled if not n.is_grace),
                       key=lambda n: n.start_s, default=None)
            if last is not None:
                home = min(rests, key=lambda p: abs(p - pos))
                last.name = self.notes[home]
                # A cadence wants length: give it a half note where the breath
                # still has room for one, never less than it already had, and
                # never more than is left -- a written value the phrase runs
                # out of time for is not a value it has.
                room = units - round(last.start_s / unit_s)
                last.dur_s = max(last.dur_s,
                                 fit_value(4, room) * unit_s * ARTICULATION)

        self.last_role = f'{self.role}:{self.relation}'
        self.role = "call" if answering else "answer"
        scheduled.sort(key=lambda n: n.start_s)
        return scheduled
