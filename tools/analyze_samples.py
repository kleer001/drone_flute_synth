#!/usr/bin/env python3
"""Inventory a folder of sustain samples: format, usable steady state, and
pitch accuracy against the nominal note in each filename.

This produced the measured VCSL table in SPEC.md section 6.

    python3 tools/analyze_samples.py <dir> [--concert-a 440]
"""
import argparse
import glob
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import (load_mono, note_from_filename, nominal_hz, detect_f0, cents,
                 steady_region)


def analyse(path, concert_a):
    note = note_from_filename(path)
    if note is None:
        return None
    sr, m = load_mono(path)
    f_nom = nominal_hz(note, concert_a)
    s0, s1 = steady_region(m, sr, f_nom)
    steady_s = (s1 - s0) / sr
    # Detect on up to 1 s of steady material; too short a window is unreliable.
    win = m[s0:s0 + min(sr, max(s1 - s0, 1))]
    f0 = detect_f0(win, sr, f_nom) if steady_s >= 0.25 else float('nan')
    return dict(note=note, sr=sr, dur=len(m) / sr, steady_s=steady_s,
                f0=f0, cents=cents(f0, f_nom) if f0 == f0 else float('nan'),
                reliable=steady_s >= 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('directory')
    ap.add_argument('--concert-a', type=float, default=440.0)
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.directory, '*.wav')))
    if not paths:
        sys.exit(f"no .wav files in {args.directory}")

    rows = [r for r in (analyse(p, args.concert_a) for p in paths) if r]
    print(f"{'note':6}{'sr':>7}{'dur_s':>8}{'steady_s':>10}{'f0_hz':>10}{'cents':>8}   ")
    for r in rows:
        flag = '' if r['reliable'] else '  (steady < 1 s: pitch unreliable)'
        print(f"{r['note']:6}{r['sr']:7}{r['dur']:8.2f}{r['steady_s']:10.2f}"
              f"{r['f0']:10.2f}{r['cents']:+8.1f}{flag}")

    ok = [r for r in rows if r['reliable']]
    if ok:
        c = np.array([r['cents'] for r in ok])
        s = np.array([r['steady_s'] for r in ok])
        print(f"\n{len(rows)} samples, {len(ok)} with >=1 s steady state")
        print(f"  steady state : {s.min():.1f} - {s.max():.1f} s")
        print(f"  pitch error  : {c.min():+.1f} to {c.max():+.1f} cents "
              f"(max |{np.abs(c).max():.1f}|)")
        notes = [r['note'] for r in rows]
        print(f"  coverage     : {' '.join(notes)}")


if __name__ == '__main__':
    main()
