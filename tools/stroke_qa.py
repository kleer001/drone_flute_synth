#!/usr/bin/env python3
"""Acceptance gate for percussion one-shots.

The sister of `loop_qa.py`. That one measures whether a loop can be tiled
without pulsing or clicking; a one-shot is never tiled, so what can go wrong is
different:

  container    mono at the rate the loops use, and NO `smpl` chunk -- a one-shot
               carrying loop points is a build step that confused its two paths
  edges        the first and last samples sit at zero, so a trim is not a click
  dc           no offset, which would add a thump to every onset
  peak         under full scale, so the page's limiter is not doing this job
  ending       the file does not stop while still at full level -- a sound cut
               mid-gesture and shut in a few ms is heard as a click, and one
               that repeats on a long texture is the loudest fault here

Crest factor and duration are reported rather than gated: a struck drum and a
poured wash legitimately differ by 20 dB of crest, and a threshold covering
both would be a threshold that means nothing.

    python3 tools/stroke_qa.py strokes/*.wav
"""
import argparse
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import body_level, load_mono, riff_chunks

SAMPLE_RATE = 48000
MAX_PEAK = 0.95
MAX_DC = 1e-3
MAX_EDGE = 0.01
# Last 25 ms against the loudest 50 ms. A sound allowed to end is well under
# this; one cut at full level and shut in 12 ms sits at 0.6 and up -- the ocean
# drum measured 0.62 and the shaker roll 0.95 before they were faded properly.
MAX_ENDING = 0.5
# The measure describes an *ending*, so the file has to be long enough for the
# window to be one. At 0.13 s a 25 ms window is a fifth of the whole sound and
# a natural shaker tick scores 0.50 without being cut at all.
ENDING_MIN_S = 0.5


def container(path):
    """(channels, sample_rate, has_smpl) straight from the RIFF chunk table."""
    channels = rate = None
    has_smpl = False
    for cid, body in riff_chunks(path):
        if cid == b"fmt ":
            _, channels, rate = struct.unpack("<HHI", body[:8])
        elif cid == b"smpl":
            has_smpl = True
    if channels is None:
        raise ValueError(f"{path} has no fmt chunk, or is not a RIFF/WAVE file")
    return channels, rate, has_smpl


def measure(path):
    channels, rate, has_smpl = container(path)
    _, sig = load_mono(path)
    peak = float(np.abs(sig).max())
    rms = float(np.sqrt(np.mean(sig ** 2)))
    # The loudest 50 ms is what the file is worth; a fixed window would land
    # in the tail of a short one and rate it against itself.
    body_rms = body_level(sig, rate)
    tail = float(np.sqrt(np.mean(sig[-int(0.025 * rate):] ** 2)))
    return {
        "ending": tail / body_rms if body_rms > 0 else 0.0,
        "channels": channels,
        "rate": rate,
        "smpl": has_smpl,
        "seconds": sig.size / rate,
        "peak": peak,
        "dc": float(np.mean(sig)),
        "head": float(abs(sig[0])),
        "tail": float(abs(sig[-1])),
        "crest_db": 20 * np.log10(peak / rms) if rms > 0 else float("inf"),
    }


def failures(m):
    out = []
    if m["channels"] != 1:
        out.append(f"{m['channels']} channels")
    if m["rate"] != SAMPLE_RATE:
        out.append(f"{m['rate']} Hz")
    if m["smpl"]:
        out.append("has a smpl chunk")
    if m["peak"] > MAX_PEAK:
        out.append(f"peak {m['peak']:.3f}")
    if abs(m["dc"]) > MAX_DC:
        out.append(f"dc {m['dc']:+.5f}")
    if m["head"] > MAX_EDGE or m["tail"] > MAX_EDGE:
        out.append(f"edges {m['head']:.4f}/{m['tail']:.4f}")
    if m["seconds"] >= ENDING_MIN_S and m["ending"] > MAX_ENDING:
        out.append(f"cut off at {m['ending']:.2f}x its body level")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    print(f"{'file':38s} {'sec':>6s} {'peak':>6s} {'dc':>9s} "
          f"{'crest':>7s} {'end':>6s}  verdict")
    passed = 0
    for path in sorted(args.files):
        m = measure(path)
        bad = failures(m)
        verdict = "pass" if not bad else "FAIL: " + ", ".join(bad)
        passed += not bad
        print(f"{os.path.basename(path):38s} {m['seconds']:6.2f} {m['peak']:6.3f} "
              f"{m['dc']:+9.5f} {m['crest_db']:6.1f}dB {m['ending']:5.2f}x  {verdict}")
    total = len(args.files)
    print(f"\n{passed}/{total} pass")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
