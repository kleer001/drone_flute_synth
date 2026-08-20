"""Shared DSP helpers for drone-flute sample analysis.

Two rules learned the hard way during the loop spike (see RESEARCH.md):

1. Any RMS-envelope window MUST span several pitch periods. A window shorter
   than one period tracks the waveform itself, so "envelope flattening" then
   mangles the tone instead of removing the breath wobble.
2. Pitch detection MUST be seeded from the known nominal note. Blind
   autocorrelation on a near-sinusoidal recorder produces octave errors of
   +1200 / -1200 / -2600 cents.
"""
import os
import re
import warnings

import numpy as np
from scipy.io import wavfile
from scipy.io.wavfile import WavFileWarning

SEMITONE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5,
            'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}


def midi_of(note):
    """'F#4' -> 66. Raises on an unparseable note name."""
    m = re.fullmatch(r'([A-G]#?)(-?\d)', note)
    if not m:
        raise ValueError(f"unparseable note name: {note!r}")
    return (int(m.group(2)) + 1) * 12 + SEMITONE[m.group(1)]


def nominal_hz(note, concert_a=440.0):
    """'F#4' -> Hz. Raises on an unparseable note name."""
    return concert_a * 2 ** ((midi_of(note) - 69) / 12)


def note_from_filename(path):
    """VCSL convention: SopRecorder_Sus_F#4_rr1_Main.wav -> 'F#4'."""
    stem = os.path.basename(str(path))
    m = re.search(r'(?:^|_)([A-G]#?-?\d)(?:_|\.)', stem)
    return m.group(1) if m else None


def load_mono(path):
    """Read a WAV as float64 mono in [-1, 1]. Returns (sample_rate, samples)."""
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', WavFileWarning)
        sr, x = wavfile.read(path)
    if x.dtype.kind == 'i':
        x = x.astype(np.float64) / np.iinfo(x.dtype).max
    elif x.dtype.kind == 'u':
        info = np.iinfo(x.dtype)
        x = (x.astype(np.float64) - info.max / 2) / (info.max / 2)
    else:
        x = x.astype(np.float64)
    return sr, (x.mean(axis=1) if x.ndim > 1 else x)


def rms_envelope(sig, hop):
    """Block RMS. `hop` must span >= 4 pitch periods (see module docstring)."""
    n = len(sig) // hop
    if n < 1:
        return np.array([np.sqrt(np.mean(sig ** 2))])
    return np.sqrt(np.mean(sig[:n * hop].reshape(n, hop) ** 2, axis=1))


def envelope_hop(sr, f0, periods=4, floor=256):
    """Envelope window guaranteed to span `periods` pitch periods."""
    return max(int(periods * sr / f0), floor)


def detect_f0(sig, sr, f_nominal, semitone_window=3.0):
    """Autocorrelation restricted to +-`semitone_window` around the nominal.

    Seeding is what prevents the octave errors described in the module
    docstring. Returns Hz, parabolically interpolated.
    """
    w = sig * np.hanning(len(sig))
    ac = np.correlate(w, w, 'full')[len(w) - 1:]
    lo = int(sr / (f_nominal * 2 ** (semitone_window / 12)))
    hi = int(sr / (f_nominal * 2 ** (-semitone_window / 12)))
    lo, hi = max(lo, 1), min(hi, len(ac) - 1)
    if hi <= lo + 1:
        return float('nan')
    seg = ac[lo:hi]
    i = int(np.argmax(seg))
    lag = lo + i
    if 0 < i < len(seg) - 1:
        a, b, c = seg[i - 1], seg[i], seg[i + 1]
        den = a - 2 * b + c
        if den:
            lag += (a - c) / (2 * den)
    return sr / lag


def cents(f, f_ref):
    return 1200.0 * np.log2(f / f_ref)


def steady_region(sig, sr, f_nominal, thresh=0.5, trim=0.12):
    """Contiguous span above `thresh` of peak RMS, trimmed `trim` at each end.

    Returns (start, stop) sample indices - the material a loop may come from.
    """
    hop = envelope_hop(sr, f_nominal)
    e = rms_envelope(sig, hop)
    idx = np.where(e > thresh * e.max())[0]
    if len(idx) == 0:
        return 0, len(sig)
    s0, s1 = idx[0] * hop, min((idx[-1] + 1) * hop, len(sig))
    pad = int(trim * (s1 - s0))
    return s0 + pad, s1 - pad
