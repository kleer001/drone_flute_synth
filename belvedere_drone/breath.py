"""The breath cycle (SPEC §5).

The signature of a drone flute is that melody and drone share one breath. Both
chambers release on the same event, which is what gives GrandOrgue's release
samples a true simultaneous cutoff -- an app that drones forever loses the
instrument.

Lung capacity sets how long a phrase wants to be; the profile's meter decides
where it can end. A breath cycle -- sounding plus inhale -- is snapped to a
whole number of bars, so the beat runs unbroken through the silence and the
next phrase enters on a downbeat.

`run` is a generator of timed MIDI actions rather than a loop that sleeps, so
the same schedule can be played live or collected byte-for-byte in a dry run.
That is what makes acceptance criteria 5 and 6 testable.
"""
from . import melody
from .profile import Meter

BREATH_CLAMP_S = (3.0, 14.0)
INHALE_CLAMP_S = (0.3, 1.6)

# Breath layers as note-on velocity (SPEC §5). GOSoundingPipe reads
# MinVelocityVolume/MaxVelocityVolume and per-attack AttackVelocity, so a layer
# is a velocity band rather than a stop change; see RESEARCH.md §7 (spike S4).
LAYER_VELOCITY = {"soft": 52, "normal": 84, "pushed": 116}


def _clamp(value, bounds):
    return max(bounds[0], min(bounds[1], value))


class Breath:
    def __init__(self, index, length_s, inhale_s, layer, drone_note,
                 melody_notes):
        self.index = index
        self.length_s = length_s
        self.inhale_s = inhale_s
        self.layer = layer
        self.drone_note = drone_note
        self.melody_notes = melody_notes

    def note_sequence(self):
        """The melody note names in order -- criterion 6 compares on this."""
        return tuple(n.name for n in self.melody_notes if not n.is_grace)


class Performer:
    """Plans breaths. Holds no MIDI state; `cli` turns plans into messages."""

    def __init__(self, profile, mood, rng, root=None, breath_spread_s=None,
                 inhale_s=None):
        self.profile = profile
        self.mood = mood
        self.rng = rng
        # The profile supplies the defaults; the GUI can override them per
        # submission (SPEC §10.7) without mutating an immutable profile.
        self.breath_spread_s = (profile.breath_spread_s
                                if breath_spread_s is None else breath_spread_s)
        self.inhale_s = profile.inhale_s if inhale_s is None else inhale_s
        drone = profile.chambers["drone"]
        self.root = root or drone.notes[0]
        if self.root not in drone.notes:
            raise ValueError(
                f"drone chamber cannot sound {self.root!r}; it has "
                f"{drone.notes}")
        # The bar comes from the instrument, the tempo from the mood.
        self.meter = Meter(mood.bpm, profile.beats_per_measure)
        self.melody_notes = sorted(
            profile.chambers["melody"].notes, key=melody.midi_of)
        # The motif lives here rather than in a single breath: restating it
        # across breaths is where the line gets its unity (SPEC §8).
        self.phrasing = melody.Phrasing(rng, self.melody_notes, self.root)
        self._index = 0
        self._last_sequence = None

    def _choose_layer(self):
        if self.rng.random() < self.mood.pushed_bias:
            return "pushed"
        return "soft" if self.rng.random() < 0.35 else "normal"

    def _snap(self, sound_target_s, inhale_target_s):
        """Fit one breath cycle to whole bars, in beats.

        The cycle -- sounding plus inhale -- is a whole number of bars, so the
        next phrase begins on a downbeat and the beat runs unbroken through the
        silence. The player breathes on the last beats of the bar, which is
        where a wind player breathes.

        Returns (sounding seconds, inhale seconds), both whole beats.
        """
        meter = self.meter
        measures = max(1, round((sound_target_s + inhale_target_s)
                                / meter.measure_s))
        cycle_beats = measures * meter.beats_per_measure
        inhale_beats = max(1, round(inhale_target_s / meter.beat_s))
        # Leave the phrase at least two beats to sound in.
        inhale_beats = min(inhale_beats, max(1, cycle_beats - 2))
        return ((cycle_beats - inhale_beats) * meter.beat_s,
                inhale_beats * meter.beat_s)

    def next_breath(self):
        """Plan one breath. Never repeats the previous note sequence (§11.6)."""
        length, inhale = self._snap(
            _clamp(self.rng.gauss(self.mood.breath_mean_s,
                                  self.breath_spread_s), BREATH_CLAMP_S),
            _clamp(self.rng.gauss(self.inhale_s, 0.2), INHALE_CLAMP_S))
        layer = self._choose_layer()

        # Redraw rather than mutate: mutating a phrase to force a difference
        # would bias the note distribution in a way that is hard to reason
        # about. Redrawing keeps the walk's statistics intact.
        for _ in range(8):
            notes = self.phrasing.breath(self.mood, self.meter, length,
                                         LAYER_VELOCITY[layer])
            sequence = tuple(n.name for n in notes if not n.is_grace)
            if sequence != self._last_sequence:
                break
        self._last_sequence = sequence

        self._index += 1
        plan = Breath(self._index, length, inhale, layer, self.root, notes)
        plan.role = self.phrasing.last_role      # call or answer, for display
        return plan
