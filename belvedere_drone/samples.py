"""Stage looped samples into the layout the generated ODF references.

`odfgen` writes pipe paths of the form `samples/<chamber>/<note>_loop.wav`,
where `<note>` is the *recorded* note, not the scale degree -- pitch-fill means
one recording can serve several degrees. This module copies exactly the files
those paths name out of a loop directory produced by `tools/loopfind.py`.

Nothing here fetches VCSL. The sample source is a deliberate, licence-bearing
choice (SPEC §6) and is made once, by hand, with `git clone --sparse`; a
build step that silently downloads audio would make it too easy to ship a set
whose provenance nobody checked.
"""
import shutil
from pathlib import Path

from .odfgen import sample_filename


def required_samples(profile):
    """{chamber_name: {recorded_note, ...}} -- what the ODF will reference."""
    return {
        name: {chamber.sample_for(n) for n in chamber.notes}
        for name, chamber in profile.chambers.items()
    }


def stage(profile, loop_dir, out_dir):
    """Copy the loops the ODF needs into out_dir/samples/. Returns the paths.

    Raises on a missing loop rather than skipping it: a pipe whose file is
    absent fails at organ-load time, a long way from the cause.
    """
    loop_dir = Path(loop_dir)
    out_dir = Path(out_dir)
    copied = []
    missing = []
    for chamber_name, notes in required_samples(profile).items():
        for note in sorted(notes):
            src = loop_dir / f"{note}_loop.wav"
            if not src.exists():
                missing.append(str(src))
                continue
            rel = sample_filename(chamber_name, note)
            dst = out_dir / (profile.sample_dir or "samples") / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied.append(dst)
    if missing:
        raise FileNotFoundError(
            "loops missing from "
            f"{loop_dir}: {', '.join(Path(m).name for m in missing)}. "
            "Run tools/loopfind.py over the sustain samples first.")
    return copied
