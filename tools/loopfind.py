#!/usr/bin/env python3
"""Reference loop finder for sustained flute samples.

This is the build path. It writes the `smpl` chunk the player reads back for
loop points, so a loop it did not author is a loop the instrument cannot play.
Eight algorithm variants were tried; the ordering below is what survived.

Pipeline, in the order that matters:
  1. locate the steady region (period-aware envelope window)
  2. seed f0 from the filename's nominal note, then refine
  3. search loop [a, b) over an INTEGER number of pitch periods, minimising
     normalised waveform mismatch between the windows at a and b
  4. crossfade the loop tail against the material preceding a, so the wrap is
     a naturally consecutive pair of samples
  5. divide out the slow breath envelope, LAST
  6. emit the loop twice, pointing the loop points at the second copy

Steps 4 and 5 partially undo each other and whichever runs last wins its
metric. Flattening goes last deliberately: the crossfade touches ~12 ms while
the breath envelope spans the whole loop, and measurement shows the envelope is
the binding constraint. Validate output with loop_qa.py, never trust the search.

    python3 tools/loopfind.py <in_dir> <out_dir>
"""
import argparse
import glob
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import (load_mono, note_from_filename, nominal_hz, midi_of, detect_f0,
                 envelope_hop, rms_envelope, steady_region)


def flatten(seg, hop):
    """Divide out the slow RMS envelope, measured around the loop. `hop` must
    span several periods.

    The envelope is measured on the segment wrapped around itself, because
    that is how the loop is heard: tiled, its last sample is followed by its
    first. Measured open, the envelope's two ends never agree -- here they
    disagree by up to 0.82 in log gain, a level ratio over 2:1 -- and the gain
    curve inherits that as a step sitting exactly on the seam. Low notes pay
    most, their adjacent samples differing least and the wrap metric being in
    units of the loop's own typical step.

    Measuring circularly removes the step without leaving anything behind.
    Forcing the open envelope's ends to agree instead, by removing the
    endpoint ramp, does fix wrap and ruins CV: the ramp it takes out is the
    breath trend itself (13/13 on wrap, 0/13 overall). Removing that ramp in
    the linear rather than the log domain is worse again, distorting a
    multiplicative gain (CV 0.004-0.026 -> 0.016-0.234).
    section 4.
    """
    pad = int(hop)
    ext = np.concatenate([seg[-pad:], seg, seg[:pad]])
    e = rms_envelope(ext, hop)
    if len(e) < 3:
        return seg
    t = (np.arange(len(e)) + 0.5) * hop - pad
    gain = np.interp(np.arange(len(seg)), t, e.mean() / np.maximum(e, 1e-9))
    return seg * gain


def find_loop(reg, sr, f0, lo_s, hi_s, guard, n_starts=16):
    """Best (mismatch, a, b) with b - a an integer number of periods."""
    period = sr / f0
    win = max(int(round(4 * period)), 256)
    pmin = max(int(lo_s * sr / period), 8)
    pmax = int(min(hi_s * sr, len(reg) * 0.80) // period)
    best = None
    for a in [guard + int(j * period) for j in range(0, n_starts * 4, 4)]:
        for n in range(pmin, max(pmin + 1, pmax)):
            b = a + int(round(n * period))
            if b + win >= len(reg):
                break
            wa, wb = reg[a:a + win], reg[b:b + win]
            na, nb = np.linalg.norm(wa), np.linalg.norm(wb)
            if na == 0 or nb == 0:
                continue
            err = float(np.linalg.norm(wa / na - wb / nb) / np.sqrt(2))
            if best is None or err < best[0]:
                best = (err, a, b)
    return best


def build_loop(sig, sr, f0, guard_ms=12.0, lo_s=0.30, hi_s=3.0):
    s0, s1 = 0, len(sig)
    hop = envelope_hop(sr, f0)
    guard = int(sr * guard_ms / 1000)
    hi = min(hi_s, (s1 - s0) / sr * 0.65)
    found = find_loop(sig, sr, f0, min(lo_s, hi * 0.5), hi, guard)
    if not found:
        return None
    err, a, b = found
    ext = sig[a - guard:b]
    loop = ext[guard:].copy()                 # exactly b - a samples
    k = min(guard, len(loop) // 4)
    ramp = np.linspace(0, np.pi / 2, k)
    loop[-k:] = loop[-k:] * np.cos(ramp) + ext[:k] * np.sin(ramp)   # crossfade
    # Flatten LAST. The crossfade only touches `k` samples (~12 ms) and the wrap
    # metric has wide headroom, whereas the breath envelope spans the whole loop
    # and is the binding constraint - so the envelope gets the final word.
    loop = flatten(loop, hop)
    return err, loop


def write_wav_with_loop(path, sr, mono, loop_start, loop_end, midi_note):
    """16-bit mono WAV carrying an `smpl` chunk: the loop points and the pitch.

    `midi_note` becomes `dwMIDIUnityNote`, the standard field for the sample's
    own recorded pitch. It must be the note actually played: a wrong unity note
    silently shifts every note a player derives from this file.
    """
    pcm = np.clip(mono, -1, 1)
    raw = (pcm * 32767).astype('<i2').tobytes()
    fmt = struct.pack('<HHIIHH', 1, 1, sr, sr * 2, 2, 16)
    smpl = (struct.pack('<IIIIIIIII', 0, 0, int(1e9 / sr), midi_note, 0, 0, 0, 1, 0)
            + struct.pack('<IIIIII', 0, 0, loop_start, loop_end, 0, 0))
    body = (b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt)) + fmt
            + b'smpl' + struct.pack('<I', len(smpl)) + smpl
            + b'data' + struct.pack('<I', len(raw)) + raw)
    with open(path, 'wb') as fh:
        fh.write(b'RIFF' + struct.pack('<I', len(body)) + body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('in_dir')
    ap.add_argument('out_dir')
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    made = 0
    for path in sorted(glob.glob(os.path.join(args.in_dir, '*.wav'))):
        note = note_from_filename(path)
        if not note:
            continue
        sr, m = load_mono(path)
        f_nom = nominal_hz(note)
        s0, s1 = steady_region(m, sr, f_nom)
        if s1 - s0 < sr:
            print(f"{note:5} steady {(s1-s0)/sr:.2f}s - too short, skipped")
            continue
        f0 = detect_f0(m[s0:s0 + min(sr, s1 - s0)], sr, f_nom)
        built = build_loop(m[s0:s1], sr, f0)
        if not built:
            print(f"{note:5} no loop found")
            continue
        err, loop = built
        # Emit the loop twice and point the loop at the SECOND copy. The first
        # is pre-roll: it plays as the note's entry, and a player that
        # crossfades the seam needs material before loop start or it discards
        # the loop outright. Nothing needs material *after* loop end -- playback
        # wraps there and never reads past it -- so a third copy would be a
        # third of every file fetched, decoded and held in memory unheard.
        out = np.tile(loop, 2)
        dst = os.path.join(args.out_dir, f"{note}_loop.wav")
        write_wav_with_loop(dst, sr, out, len(loop), 2 * len(loop),
                            midi_of(note))
        print(f"{note:5} loop {len(loop)/sr:6.3f}s  seam_mismatch {err:.4f}  -> {os.path.basename(dst)}")
        made += 1
    print(f"\n{made} loops written to {args.out_dir}")
    print("Now validate: python3 tools/loop_qa.py " + os.path.join(args.out_dir, "*.wav"))


if __name__ == '__main__':
    main()
