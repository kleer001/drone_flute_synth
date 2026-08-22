#!/usr/bin/env python3
"""Acceptance gate for drone loops.

Reads loop points from the WAV's `smpl` chunk - the same metadata
tools/loopfind.py writes and the player reads back - tiles the loop out to 60
seconds, and measures the two things that make a drone loop audibly fail:

  envelope CV   slow level pulsing once per loop, from the player's breath
                wobble being baked into the looped region
  wrap          waveform discontinuity across the splice point, as a
                multiple of the loop's own typical sample-to-sample step
                (~1.0 = indistinguishable from any other step; >3 audible)

    python3 tools/loop_qa.py file.wav [file2.wav ...]
    python3 tools/loop_qa.py file.wav --loop-start N --loop-end M

Thresholds default to the spec's: CV < 0.02 and wrap < 3.0.
"""
import argparse
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import (load_mono, note_from_filename, nominal_hz, detect_f0,
                 envelope_hop, rms_envelope, steady_region)


def read_smpl_loops(path):
    """Return [(start, end), ...] from the WAV `smpl` chunk, or [] if absent.

    scipy does not expose this chunk, so parse the RIFF container directly.
    """
    with open(path, 'rb') as fh:
        if fh.read(4) != b'RIFF':
            return []
        fh.read(4)
        if fh.read(4) != b'WAVE':
            return []
        loops = []
        while True:
            hdr = fh.read(8)
            if len(hdr) < 8:
                break
            cid, size = struct.unpack('<4sI', hdr)
            body = fh.read(size)
            if cid == b'smpl' and len(body) >= 36:
                n = struct.unpack('<I', body[28:32])[0]
                for i in range(n):
                    off = 36 + i * 24
                    if off + 24 > len(body):
                        break
                    start, end = struct.unpack('<II', body[off + 8:off + 16])
                    loops.append((start, end))
            if size % 2:
                fh.read(1)
        return loops


def score(sig, sr, start, end, f0):
    """Tile [start, end) to 60 s and measure pulsing and wrap discontinuity."""
    loop = sig[start:end]
    if len(loop) < 32:
        return None
    hop = envelope_hop(sr, f0)
    reps = int(np.ceil(60.0 * sr / len(loop)))
    tiled = np.tile(loop, reps)[:int(60 * sr)]
    e = rms_envelope(tiled, hop)
    # Wrap discontinuity, measured as the step from the last sample of the loop
    # to the first, normalised by the loop's own typical sample-to-sample step.
    # Normalising by RMS *amplitude* would be wrong: adjacent samples of any
    # waveform differ by its slope, so even a perfect loop would score nonzero.
    # ~1.0 means the wrap step is indistinguishable from any other step.
    steps = np.diff(loop)
    step_rms = float(np.sqrt(np.mean(steps ** 2))) or 1e-12
    return dict(
        loop_s=len(loop) / sr,
        periods=len(loop) / (sr / f0),
        cv=float(e.std() / e.mean()),
        pp=float((e.max() - e.min()) / e.mean()),
        wrap=float(abs(loop[0] - loop[-1]) / step_rms),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--loop-start', type=int)
    ap.add_argument('--loop-end', type=int)
    ap.add_argument('--max-cv', type=float, default=0.02)
    ap.add_argument('--max-wrap', type=float, default=3.0)
    args = ap.parse_args()

    print(f"{'file':32}{'loop_s':>8}{'periods':>9}{'cv':>8}{'pp':>8}{'wrap':>8}  verdict")
    passed = total = 0
    for path in args.files:
        sr, m = load_mono(path)
        note = note_from_filename(path)
        f_nom = nominal_hz(note) if note else 440.0
        s0, s1 = steady_region(m, sr, f_nom)
        f0 = detect_f0(m[s0:s0 + min(sr, max(s1 - s0, 1))], sr, f_nom)

        if args.loop_start is not None and args.loop_end is not None:
            spans = [(args.loop_start, args.loop_end)]
        else:
            spans = read_smpl_loops(path)
        if not spans:
            print(f"{os.path.basename(path)[:32]:32}{'':>8}{'':>9}{'':>8}{'':>8}{'':>8}  "
                  f"NO LOOP POINTS (no smpl chunk; pass --loop-start/--loop-end)")
            total += 1
            continue

        for st, en in spans:
            r = score(m, sr, st, en, f0)
            if r is None:
                print(f"{os.path.basename(path)[:32]:32}  loop too short")
                total += 1
                continue
            ok = r['cv'] < args.max_cv and r['wrap'] < args.max_wrap
            passed += ok
            total += 1
            print(f"{os.path.basename(path)[:32]:32}{r['loop_s']:8.3f}{r['periods']:9.1f}"
                  f"{r['cv']:8.4f}{r['pp']:8.3f}{r['wrap']:8.4f}  {'PASS' if ok else 'FAIL'}")

    print(f"\n{passed}/{total} pass (cv < {args.max_cv}, wrap < {args.max_wrap})")
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main())
