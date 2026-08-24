#!/usr/bin/env python3
"""Author percussion one-shots from the VCSL recordings.

The sister of `loopfind.py`. That one finds a loop inside a sustained note so
it can be held indefinitely; this one takes a struck sound and leaves it
struck, with no `smpl` chunk, because a frame drum hit is over when it is over.

What it does is bookkeeping and levels:

  1. read a pool's recordings, under whichever irregular names VCSL gave them
  2. mono, trimmed to the sound, resampled to the rate the loops already use
  3. scaled by ONE factor for the whole pool -- see `author_pool`
  4. written as <pool>-<stroke>-l<level>-v<variant>.wav

VCSL names its percussion inconsistently across instruments
(HDrumL_Hit_v2_rr1_Sum, Mid_ShakerDouble_Down_rr1, Cabasa1_Rub_v1_rr2_Mid), so
the mapping from a file to a stroke is a table below rather than one clever
pattern applied everywhere. This is the only place in the project that reads a
VCSL name, which is why nothing at runtime has to.

    python3 tools/oneshot.py <vcsl_root> <out_dir> [pool ...]
"""
import argparse
import os
import re
import sys
from fractions import Fraction

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, resample_poly, sosfiltfilt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import body_level, load_mono

# The loops are 48k mono; matching them means the page decodes one rate.
SAMPLE_RATE = 48000
# Headroom under full scale. The page's limiter catches the moments a stroke
# and a long reverb tail land together, and this keeps it from working hard.
PEAK = 0.89
# Below this is silence as far as trimming is concerned.
SILENCE = 3e-4
FADE_IN_S = 0.001        # the transient is the sound; this only kills a click
FADE_OUT_S = 0.012
# A sound that runs past `max_s` is cut mid-gesture rather than having died
# away, so it is still at full level when the file ends. The ocean drum is cut
# at 8 s while measuring 0.89-3.7x its own body level; a 12 ms fade on that is
# an edge, and it is heard as a click. Long enough to read as the gesture
# ending instead.
CUT_FADE_OUT_S = 0.80
# The fade-in answers a different question. Truncating a tail says nothing
# about an attack: a wash that switches on in 1 ms ticks, where a struck
# sound's 1 ms IS the attack. So it follows `sustain` on the pool, not the
# length cap -- otherwise shortening any `max_s` would quietly soften a
# transient the recording is made of.
SUSTAIN_FADE_IN_S = 0.05
# Subsonic trim. Several of VCSL's shortest shaker recordings carry a DC
# offset of a couple of thousandths -- harmless in a long sustain, but these
# are 80 ms bursts, so the offset arrives as a step and is heard as a thump on
# every onset. Measured by tools/stroke_qa.py, which fails a file that has it.
# 20 Hz is below anything a shaker or a drum head produces.
HIGHPASS_HZ = 20.0

# Every pool: where VCSL keeps it, how to read its names, and how long a
# stroke is allowed to run. `rules` is a list because one instrument can carry
# two naming schemes -- the small shaker does.
#
# A rule is (pattern, {vcsl stroke: our stroke}). Named groups the pattern may
# supply: stroke (required), level (defaults to 1), variant (defaults to 1).
POOLS = {
    "frame_drum": dict(
        source="Membranophones/Struck Membranophones/Frame Drum",
        # Hand is dropped: body level -58 dB with 8.6 dB of signal to noise.
        rules=[(r"HDrumL_(?P<stroke>Hit|HitMuted)"
                r"(?:_v(?P<level>\d+))?_rr(?P<variant>\d+)_Sum\.wav",
                {"Hit": "hit", "HitMuted": "muted"})],
        max_s=4.0,
    ),
    "frame_drum_small": dict(
        source="Membranophones/Struck Membranophones/Frame Drum",
        rules=[(r"HDrumS_(?P<stroke>Hit|HitMuted)"
                r"(?:_v(?P<level>\d+))?_rr(?P<variant>\d+)_Sum\.wav",
                {"Hit": "hit", "HitMuted": "muted"})],
        max_s=3.0,
    ),
    "rattle": dict(
        source="Idiophones/Struck Idiophones/Shaker, Large",
        rules=[(r"LShaker_(?P<stroke>Hit|Shake1D|Shake1U)_rr(?P<variant>\d+)_Mid\.wav",
                {"Hit": "hit", "Shake1D": "down", "Shake1U": "up"})],
        max_s=1.5,
    ),
    "rattle_small": dict(
        source="Idiophones/Struck Idiophones/Shaker, Small",
        rules=[(r"Mid_Shaker(?P<stroke>Double|HighFaster|LowFaster)"
                r"_(?P<dir>Up|Down)_rr(?P<variant>\d+)\.wav",
                {"Double": "double", "HighFaster": "high", "LowFaster": "low"}),
               (r"Mid_Shaker_(?P<stroke>Roll_Fast|Slap)_rr(?P<variant>\d+)\.wav",
                {"Roll_Fast": "roll", "Slap": "slap"})],
        max_s=2.5,
    ),
    "cabasa": dict(
        source="Idiophones/Struck Idiophones/Cabasa",
        rules=[(r"Cabasa1_(?P<stroke>Hit|Rub)(?:_v(?P<level>\d+))?"
                r"_rr(?P<variant>\d+)_Mid\.wav",
                {"Hit": "hit", "Rub": "rub"})],
        max_s=2.0,
    ),
    "guiro": dict(
        source="Idiophones/Struck Idiophones/Guiro",
        rules=[(r"Guiro_(?P<stroke>Hit|Fast|Med|Slow)_rr(?P<variant>\d+)_Mid\.wav",
                {"Hit": "hit", "Fast": "fast", "Med": "med", "Slow": "slow"})],
        max_s=3.0,
    ),
    # The ocean drum is the rain stick's stand-in: VCSL has no rain stick, and
    # a shallow drum full of beads is the same gesture -- a wash of grains that
    # rises and falls as it is tilted. Its recordings are `Sus`, long and
    # continuous, so they are capped rather than trimmed, and they swell in
    # rather than switching on.
    "rain_stick": dict(
        source="Membranophones/Other Membranophones/Ocean Drum",
        rules=[(r"OceanDrum_Sus_(?P<variant>\d+)_Mid\.wav", {"": "wash"})],
        max_s=8.0, sustain=True,
    ),
}


def classify(name, rules):
    """(stroke, level, variant) for a VCSL file name, or None if no rule fits."""
    for pattern, strokes in rules:
        m = re.fullmatch(pattern, name)
        if not m:
            continue
        groups = m.groupdict()
        raw = groups.get("stroke") or ""
        if raw not in strokes:
            continue
        stroke = strokes[raw]
        # The small shaker encodes its direction separately from its stroke.
        if groups.get("dir"):
            stroke = f"{stroke}_{groups['dir'].lower()}"
        level = int(groups["level"]) if groups.get("level") else 1
        variant = int(groups["variant"]) if groups.get("variant") else 1
        return stroke, level, variant
    return None


def prepare(path, max_s, sustain=False):
    """Mono, trimmed to the sound, resampled, faded. Returns float64 in [-1, 1]."""
    sr, sig = load_mono(path)
    # Before trimming, so the trim sees where the sound actually starts rather
    # than where the offset crosses the threshold.
    sos = butter(2, HIGHPASS_HZ / (sr / 2), btype="highpass", output="sos")
    sig = sosfiltfilt(sos, sig)
    loud = np.flatnonzero(np.abs(sig) > SILENCE)
    if loud.size == 0:
        raise ValueError(f"{path} is silent")
    sig = sig[loud[0]:loud[-1] + 1]

    if sr != SAMPLE_RATE:
        ratio = Fraction(SAMPLE_RATE, sr).limit_denominator()
        sig = resample_poly(sig, ratio.numerator, ratio.denominator)

    limit = int(max_s * SAMPLE_RATE)
    cut = sig.size > limit
    if cut:
        sig = sig[:limit]

    # A trim lands mid-waveform, and a step to zero is a click. These are the
    # shortest fades that remove it without softening the transient -- unless
    # the sound was cut rather than allowed to end, which needs a real fade.
    fade_in = SUSTAIN_FADE_IN_S if sustain else FADE_IN_S
    fade_out = CUT_FADE_OUT_S if cut else FADE_OUT_S
    n_in = min(int(fade_in * SAMPLE_RATE), sig.size // 2)
    n_out = min(int(fade_out * SAMPLE_RATE), sig.size // 2)
    if n_in:
        sig[:n_in] *= np.linspace(0.0, 1.0, n_in)
    if n_out:
        sig[-n_out:] *= np.linspace(1.0, 0.0, n_out)
    return sig


def author_pool(name, spec, vcsl_root, out_dir):
    """Author one pool. Returns the number of files written."""
    src = os.path.join(vcsl_root, spec["source"])
    if not os.path.isdir(src):
        raise SystemExit(f"{name}: no such directory {src}")

    found = []
    for fname in sorted(os.listdir(src)):
        if not fname.lower().endswith(".wav"):
            continue
        hit = classify(fname, spec["rules"])
        if hit:
            found.append((fname, *hit))
    if not found:
        raise SystemExit(f"{name}: no recording in {src} matched a rule")

    signals = [prepare(os.path.join(src, f), spec["max_s"], spec.get("sustain", False))
               for f, _, _, _ in found]

    # ONE factor for the whole pool. Normalising each file to its own peak
    # would erase precisely what the velocity layers encode -- a soft hit and a
    # hard one would come out the same size, and the layer choice in
    # StrokeSet.pick would change the timbre without changing the loudness.
    peak = max(float(np.abs(s).max()) for s in signals)
    if peak <= 0:
        raise SystemExit(f"{name}: every recording is silent")
    scale = PEAK / peak

    # The spread between the softest and loudest layer of a stroke, in dB.
    # This is what a velocity layer is worth: two layers far apart mean the
    # midpoint of the velocity range is a cliff, not a ramp. Measured as body
    # rather than peak, because that is what the engine levels by and what the
    # gate checks -- reporting peak here said 19 dB for the frame drum where
    # every other number in the project says 15.
    by_stroke = {}
    for (fname, stroke, level, variant), sig in zip(found, signals):
        out = f"{name}-{stroke}-l{level}-v{variant}.wav"
        data = np.clip(sig * scale, -1.0, 1.0)
        wavfile.write(os.path.join(out_dir, out),
                      SAMPLE_RATE, (data * 32767.0).astype(np.int16))
        body = body_level(sig, SAMPLE_RATE)
        layers = by_stroke.setdefault(stroke, {})
        layers[level] = max(layers.get(level, 0.0), body)

    spread = []
    for stroke in sorted(by_stroke):
        bodies = by_stroke[stroke].values()
        if len(by_stroke[stroke]) > 1:
            spread.append(f"{stroke} {20 * np.log10(max(bodies) / min(bodies)):.0f}dB")
    note = f"  layers: {', '.join(spread)}" if spread else ""
    print(f"{name:18s} {len(found):3d} files  peak {peak:.3f} -> {PEAK}  "
          f"strokes: {', '.join(sorted(by_stroke))}{note}")
    return len(found)


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("vcsl_root")
    ap.add_argument("out_dir")
    ap.add_argument("pools", nargs="*", default=None,
                    help="pools to author; default is all of them")
    args = ap.parse_args()

    wanted = args.pools or sorted(POOLS)
    unknown = [p for p in wanted if p not in POOLS]
    if unknown:
        raise SystemExit(f"unknown pool(s): {', '.join(unknown)}; "
                         f"have {', '.join(sorted(POOLS))}")

    os.makedirs(args.out_dir, exist_ok=True)
    total = sum(author_pool(p, POOLS[p], args.vcsl_root, args.out_dir) for p in wanted)
    print(f"\n{total} one-shots in {len(wanted)} pools -> {args.out_dir}")


if __name__ == "__main__":
    main()
