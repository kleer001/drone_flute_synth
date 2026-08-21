"""Profile -> GrandOrgue Organ Definition File + key manifest (SPEC §4).

Every key name and value range here was read out of the GrandOrgue 3.17.3
sources rather than from secondary documentation, because the secondary
documentation is incomplete: `src/tests/testing/resources/minimal.organ` is the
smallest ODF upstream itself considers loadable, and it already carries four
combination-store keys that no tutorial mentions.

Two facts drive the design:

1. `GOSoundingPipe::Validate` picks between two pitch paths. Under a
   temperament that is "original based" -- which the default, Original, is --
   the pitch is `PitchTuning + ManualTuning + TemperamentOffset` and the
   sample's own recorded pitch is left alone. Under any other temperament
   GrandOrgue instead resamples each pipe toward equal temperament using the
   sample's MIDI unity note. We want the first path: one sample per note, no
   resampling, cents table carried in `PitchTuning`.

2. A GrandOrgue temperament is twelve offsets indexed by pitch class
   (`GOTemperamentCent::m_Tuning[12]`), so it is octave-periodic by
   construction and cannot express an octave that is not 2:1. Per-pipe
   `PitchTuning` can. That is the whole reason the cents table lives in the ODF
   and not in a temperament file.

MIDI keys are allocated here and written to a JSON manifest beside the ODF, so
the player and the ODF can never disagree about which key is which pipe (§9).
"""
import json
from pathlib import Path

from .profile import midi_of

# Manual001 spans one contiguous block; chambers get disjoint slices of it.
# 36 is below anything the melody chamber will use, and GOManual caps
# NumberOfAccessibleKeys at 85, so 36..120 is the whole usable window.
BASE_MIDI_NOTE = 36
MAX_ACCESSIBLE_KEYS = 85

# A stop whose single rank holds exactly one pipe is an *effects* stop in
# GrandOrgue: `GOStop::IsForEffects` returns true, `SetKeyState` bails out, and
# the pipe sounds for as long as the stop is engaged, ignoring the manual. A
# droneless chamber has exactly one note, so without this the drone sounds from
# the moment the organ loads and nothing -- not note-off, not CC 120/123 --
# silences it. Padding the rank with a DUMMY pipe restores key control.
MIN_PIPES_PER_RANK = 2

# GOGUIHW1DisplayMetrics reads all of these with required=true. GrandOrgue
# refuses to load an ODF that omits any one of them, even with no visible
# panel, so a generator that wants to produce a loadable file must emit the
# whole set. Values are the minimum legal ones for a console we never show.
DISPLAY_METRICS = [
    ("DispScreenSizeHoriz", "SMALL"),
    ("DispScreenSizeVert", "SMALL"),
    ("DispDrawstopBackgroundImageNum", 1),
    ("DispConsoleBackgroundImageNum", 1),
    ("DispKeyHorizBackgroundImageNum", 1),
    ("DispKeyVertBackgroundImageNum", 1),
    ("DispDrawstopInsetBackgroundImageNum", 1),
    ("DispControlLabelFont", "Times New Roman"),
    ("DispShortcutKeyLabelFont", "Times New Roman"),
    ("DispShortcutKeyLabelColour", "BLACK"),
    ("DispGroupLabelFont", "Times New Roman"),
    ("DispDrawstopCols", 2),
    ("DispDrawstopRows", 1),
    ("DispDrawstopColsOffset", "N"),
    ("DispDrawstopOuterColOffsetUp", "N"),
    ("DispPairDrawstopCols", "N"),
    ("DispExtraDrawstopRows", 0),
    ("DispExtraDrawstopCols", 0),
    ("DispButtonCols", 1),
    ("DispExtraButtonRows", 0),
    ("DispExtraPedalButtonRow", "N"),
    ("DispExtraPedalButtonRowOffset", "N"),
    ("DispExtraPedalButtonRowOffsetRight", "N"),
    ("DispButtonsAboveManuals", "N"),
    ("DispTrimAboveManuals", "N"),
    ("DispTrimBelowManuals", "N"),
    ("DispTrimAboveExtraRows", "N"),
    ("DispExtraDrawstopRowsAboveExtraButtonRows", "N"),
]

# GOOrganController requires these four; minimal.organ carries them and an ODF
# without them fails with "Missing required value section 'Organ' entry ...".
COMBINATION_KEYS = [
    ("DivisionalsStoreIntermanualCouplers", "N"),
    ("DivisionalsStoreIntramanualCouplers", "N"),
    ("DivisionalsStoreTremulants", "N"),
    ("GeneralsStoreDivisionalCouplers", "N"),
]


def rank_pipe_count(chamber):
    """Logical pipes in a chamber's rank, padded away from the effects case."""
    return max(len(chamber.notes), MIN_PIPES_PER_RANK)


def allocate_keys(profile):
    """Assign each chamber a disjoint run of MIDI keys.

    Returns {chamber_name: {note_name: midi_key}}. Keys are a trigger index,
    not a pitch: the sounding pitch is the sample's own, shifted by the cents
    table. That is what lets a non-12-TET scale sit on a chromatic keyboard.
    """
    allocation = {}
    cursor = BASE_MIDI_NOTE
    for name in sorted(profile.chambers):
        chamber = profile.chambers[name]
        notes = sorted(chamber.notes, key=midi_of)
        allocation[name] = {n: cursor + i for i, n in enumerate(notes)}
        cursor += rank_pipe_count(chamber)
    span = cursor - BASE_MIDI_NOTE
    if span > MAX_ACCESSIBLE_KEYS:
        raise ValueError(
            f"{profile.id}: chambers need {span} keys but GOManual accepts at "
            f"most {MAX_ACCESSIBLE_KEYS}")
    return allocation


def sample_filename(chamber_name, note):
    return f"{chamber_name}/{note}_loop.wav"


def _emit_rank(lines, index, chamber, keys, windchest, sample_dir):
    notes = sorted(chamber.notes, key=midi_of)
    pipes = rank_pipe_count(chamber)
    lines.append(f"[Rank{index:03d}]")
    lines.append(f"Name={chamber.name} chamber")
    lines.append(f"NumberOfLogicalPipes={pipes}")
    lines.append(f"FirstMidiNoteNumber={keys[notes[0]]}")
    lines.append(f"WindchestGroup={windchest}")
    lines.append("HarmonicNumber=8")
    # Must stay N. A chamber's MIDI keys are scale-degree indices, not
    # pitches -- key 38 is "third hole", not D2 -- so the shift a stock
    # temperament would apply is the distance from the sample's recorded note
    # to an unrelated key number. GOSoundingPipe::Validate rejects any pipe
    # whose hypothetical retune exceeds 1800 cents, and every pipe here would.
    # It is also the right answer musically: the profile's cents table is this
    # instrument's temperament, and an organ temperament must not touch it.
    lines.append("AcceptsRetuning=N")
    for i, note in enumerate(notes, start=1):
        rel = sample_filename(chamber.name, chamber.sample_for(note))
        if sample_dir:
            rel = f"{sample_dir}/{rel}"
        lines.append(f"Pipe{i:03d}={rel}")
        # PitchTuning carries both halves of the shift: the pitch-fill step
        # from the borrowed recording to this note, and the scale's own
        # deviation from equal temperament.
        lines.append(f"Pipe{i:03d}PitchTuning={chamber.tuning_offset(note):g}")
        lines.append(f"Pipe{i:03d}LoopCrossfadeLength=20")
    for i in range(len(notes) + 1, pipes + 1):
        lines.append(f"Pipe{i:03d}=DUMMY")
    lines.append("")


def _emit_stop(lines, index, chamber, keys, rank_index):
    notes = sorted(chamber.notes, key=midi_of)
    first_logical = keys[notes[0]] - BASE_MIDI_NOTE + 1
    lines.append(f"[Stop{index:03d}]")
    lines.append(f"Name={chamber.name}")
    lines.append("NumberOfRanks=1")
    lines.append(f"Rank001={rank_index}")
    lines.append(f"FirstAccessiblePipeLogicalKeyNumber={first_logical}")
    lines.append(f"NumberOfAccessiblePipes={rank_pipe_count(chamber)}")
    # Both chambers sound from the first note; the app, not the console,
    # decides what plays.
    lines.append("DefaultToEngaged=Y")
    lines.append("Displayed=Y")
    lines.append("GCState=1")
    lines.append("")


def build_odf(profile, allocation):
    names = sorted(profile.chambers)
    total_keys = sum(rank_pipe_count(profile.chambers[n]) for n in names)

    lines = ["[Organ]",
             f"ChurchName={profile.display}",
             f"ChurchAddress={profile.provenance_line()}",
             "OrganBuilder=belvedere-drone",
             f"OrganComments={profile.sample_note}",
             f"NumberOfManuals=1",
             "HasPedals=N",
             "NumberOfEnclosures=1",
             f"NumberOfWindchestGroups={len(names)}",
             f"NumberOfRanks={len(names)}",
             "NumberOfTremulants=0",
             "NumberOfSwitches=0",
             "NumberOfReversiblePistons=0",
             "NumberOfDivisionalCouplers=0",
             "NumberOfGenerals=0",
             "NumberOfPanels=0",
             # GOGUIPanel reads the built-in console's own element counts from
             # the [Organ] group. Only this one is not already covered by a
             # key above; GrandOrgue reports the rest as "Unused ODF entry".
             "NumberOfLabels=0"]
    for key, value in COMBINATION_KEYS:
        lines.append(f"{key}={value}")
    for key, value in DISPLAY_METRICS:
        lines.append(f"{key}={value}")
    lines.append("")

    # One Enclosure on CC 11 gives continuous level within a breath (§9).
    lines += ["[Enclosure001]", "Name=Breath", "AmpMinimumLevel=0",
              # Same mechanism for enclosures: 1 means enclosure 1.
              "MIDIInputNumber=1",
              "Displayed=N", ""]

    # One windchest per chamber: independent chambers, one shared air supply.
    for i, name in enumerate(names, start=1):
        lines += [f"[WindchestGroup{i:03d}]",
                  f"Name={name} chamber",
                  "NumberOfEnclosures=1",
                  "Enclosure001=1",
                  "NumberOfTremulants=0", ""]

    for i, name in enumerate(names, start=1):
        _emit_rank(lines, i, profile.chambers[name], allocation[name], i,
                   profile.sample_dir)

    lines += ["[Manual001]",
              "Name=Flute",
              # ODF reference, Manual objects: "0 means no association, 1 maps
              # to pedal, 2 to first manual". Omitting it defaults to 0, and a
              # manual with no association never inherits any MIDI settings --
              # which is why this organ ignored every note it was ever sent.
              "MIDIInputNumber=2",
              f"NumberOfLogicalKeys={total_keys}",
              "FirstAccessibleKeyLogicalKeyNumber=1",
              f"FirstAccessibleKeyMIDINoteNumber={BASE_MIDI_NOTE}",
              f"NumberOfAccessibleKeys={total_keys}",
              f"NumberOfStops={len(names)}"]
    for i in range(1, len(names) + 1):
        lines.append(f"Stop{i:03d}={i}")
    # The manual has to be visible. GrandOrgue ignores incoming notes until a
    # manual has a MIDI receiver assigned, and the only supported way to assign
    # one is to right-click the manual and "Listen for events" -- which is
    # impossible on a console that draws nothing.
    lines += ["NumberOfCouplers=0", "NumberOfDivisionals=0",
              "NumberOfTremulants=0", "NumberOfSwitches=0", "Displayed=Y", ""]

    for i, name in enumerate(names, start=1):
        _emit_stop(lines, i, profile.chambers[name], allocation[name], i)

    return "\n".join(lines) + "\n"


def build_manifest(profile, allocation):
    return {
        "profile_id": profile.id,
        "display": profile.display,
        "provenance": profile.provenance_line(),
        "tuning_origin": profile.tuning_origin,
        "base_midi_note": BASE_MIDI_NOTE,
        "chambers": {
            name: {
                "holes": profile.chambers[name].holes,
                "keys": allocation[name],
                "cents": {n: profile.chambers[name].cents_for(n)
                          for n in allocation[name]},
                "samples": {n: profile.chambers[name].sample_for(n)
                            for n in allocation[name]},
                "pitch_tuning": {n: profile.chambers[name].tuning_offset(n)
                                 for n in allocation[name]},
            }
            for name in allocation
        },
    }


def generate(profile, out_dir):
    """Write <id>.organ and <id>.manifest.json into out_dir. Returns paths."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    allocation = allocate_keys(profile)

    odf_path = out_dir / Path(profile.odf_path).name
    odf_path.write_text(build_odf(profile, allocation))

    manifest_path = odf_path.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(build_manifest(profile, allocation), indent=2) + "\n")
    return odf_path, manifest_path
