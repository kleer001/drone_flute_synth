"""Instrument profile loading and validation (SPEC §7).

Provenance is a hard gate, not a convention: a cents table whose origin is
unrecorded is indistinguishable from a guess, and §2 makes the cents table the
primary artifact. A profile that cannot say where its tuning came from is
rejected at load rather than quietly played.
"""
import tomllib
from pathlib import Path

TUNING_ORIGINS = ("published", "maker-spec", "estimate")
SAMPLE_SOURCES = ("vcsl-cc0", "synthesized", "other-licensed")

SEMITONE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5,
            'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}


def midi_of(note):
    """'F#4' -> 66. Raises on an unparseable note name."""
    body, octave = note[:-1], note[-1]
    if body not in SEMITONE or not octave.isdigit():
        raise ValueError(f"unparseable note name: {note!r}")
    return (int(octave) + 1) * 12 + SEMITONE[body]


class Chamber:
    def __init__(self, name, holes, notes, cents, samples):
        self.name = name
        self.holes = holes
        self.notes = notes
        self.cents = cents
        self.samples = samples

    def cents_for(self, note):
        return self.cents.get(note, 0.0)

    def sample_for(self, note):
        """Which recorded note supplies this note (SPEC §6 pitch-fill).

        VCSL's recorder is sampled whole-tone, so a scale with semitone steps
        has to borrow the nearest recording and shift it. The shift is folded
        into the pipe's cents value by `tuning_offset`.
        """
        return self.samples.get(note, note)

    def tuning_offset(self, note):
        """Total cents for the pipe: pitch-fill shift plus scale deviation."""
        return (midi_of(note) - midi_of(self.sample_for(note))) * 100.0 \
            + self.cents_for(note)


class Meter:
    """The instrument's one global clock: a tempo and a bar length.

    Breaths resolve to bar lines rather than inventing a grid each time, so
    every phrase in a performance is commensurable with every other one.

    The unit is the eighth note. Motif durations are whole units, and the
    conventional values a phrase can use -- eighth through whole -- are counts
    of them.
    """

    UNITS_PER_BEAT = 2                     # the beat is a quarter; the unit an eighth

    def __init__(self, bpm, beats_per_measure):
        self.bpm = float(bpm)
        self.beats_per_measure = int(beats_per_measure)
        if self.bpm <= 0:
            raise ValueError(f"bpm must be positive, got {self.bpm}")
        if self.beats_per_measure < 1:
            raise ValueError(
                f"beats_per_measure must be at least 1, got "
                f"{self.beats_per_measure}")
        self.beat_s = 60.0 / self.bpm
        self.measure_s = self.beat_s * self.beats_per_measure
        self.unit_s = self.beat_s / self.UNITS_PER_BEAT
        self.units_per_measure = self.beats_per_measure * self.UNITS_PER_BEAT

    def __repr__(self):
        return (f"<Meter {self.bpm:g} bpm, {self.beats_per_measure}/4, "
                f"bar {self.measure_s:.3f}s>")


class Profile:
    def __init__(self, data, path):
        self.path = path
        self.id = data["id"]
        self.display = data["display"]
        self.family = data["family"]
        self.concert_a_hz = float(data["concert_a_hz"])

        self.tuning_origin = data["tuning_origin"]
        self.tuning_source = data.get("tuning_source", "")
        self.sample_source = data["sample_source"]
        self.sample_note = data.get("sample_note", "")

        if self.tuning_origin not in TUNING_ORIGINS:
            raise ValueError(
                f"{path}: tuning_origin must be one of {TUNING_ORIGINS}, "
                f"got {self.tuning_origin!r}")
        if self.sample_source not in SAMPLE_SOURCES:
            raise ValueError(
                f"{path}: sample_source must be one of {SAMPLE_SOURCES}, "
                f"got {self.sample_source!r}")
        # The honesty gate: anything claiming a source must name it.
        if self.tuning_origin in ("published", "maker-spec") and not self.tuning_source:
            raise ValueError(
                f"{path}: tuning_origin={self.tuning_origin!r} requires a "
                f"non-empty tuning_source citation")

        self.chambers = {}
        for name, c in data["chambers"].items():
            notes = list(c["notes"])
            for n in notes:
                midi_of(n)                      # validate every name up front
            cents = {k: float(v) for k, v in c.get("cents", {}).items()}
            unknown = set(cents) - set(notes)
            if unknown:
                raise ValueError(
                    f"{path}: chamber {name!r} has cents entries for notes it "
                    f"cannot sound: {sorted(unknown)}")
            samples = dict(c.get("samples", {}))
            unknown = set(samples) - set(notes)
            if unknown:
                raise ValueError(
                    f"{path}: chamber {name!r} maps samples for notes it "
                    f"cannot sound: {sorted(unknown)}")
            for src in samples.values():
                midi_of(src)
            self.chambers[name] = Chamber(name, int(c["holes"]), notes, cents,
                                          samples)

        if "drone" not in self.chambers:
            raise ValueError(f"{path}: profile needs a 'drone' chamber")
        if "melody" not in self.chambers:
            raise ValueError(f"{path}: profile needs a 'melody' chamber")

        if "meter" not in data:
            raise ValueError(
                f"{path}: profile needs a [meter] table with bpm and "
                f"beats_per_measure")
        m = data["meter"]
        self.meter = Meter(m["bpm"], m["beats_per_measure"])

        b = data["breath"]
        self.breath_mean_s = float(b["mean_s"])
        self.breath_spread_s = float(b["spread_s"])
        self.inhale_s = float(b["inhale_s"])

        self.odf_path = data["odf"]["path"]
        self.sample_dir = data["odf"].get("sample_dir", "")

    @property
    def is_tuning_sourced(self):
        """False when the cents table is this project's own estimate."""
        return self.tuning_origin != "estimate"

    def provenance_line(self):
        src = self.tuning_source or "no citation"
        return (f"tuning: {self.tuning_origin} ({src}) | "
                f"samples: {self.sample_source}")


def load(path):
    path = Path(path)
    with open(path, "rb") as fh:
        return Profile(tomllib.load(fh), path)
