# drone_flute_synth

Design work and build-time measurement tools for a Linux app that plays an
endless performance on a simulated drone flute. Sound generation is delegated
to **GrandOrgue** playing a purpose-built sample set; the app is the player,
not the synth.

**State: specification plus validated tooling. No application code exists yet.**
`SPEC.md` §10 gives the intended module layout for the app; nothing under
`belvedere_drone/` has been written.

## Layout

| Path | What it is |
|---|---|
| `SPEC.md` | The build specification — architecture, ODF mapping, breath model, controls, acceptance criteria, ordered spikes. The authority; when code and spec disagree, resolve it explicitly. |
| `RESEARCH.md` | What was researched and measured, including the loop-authoring experiment log and what each failed variant taught. Read §4 before touching loop code. |
| `tools/dsp.py` | Shared DSP helpers — sample loading, period-aware envelopes, seeded pitch detection |
| `tools/analyze_samples.py` | Inventory a sample folder: format, usable steady state, pitch accuracy vs. nominal |
| `tools/loop_qa.py` | Acceptance gate (SPEC §11 criterion 3). Exits non-zero on failure |
| `tools/loopfind.py` | Reference loop finder. Superseded for production by LoopAuditioneer; kept as dependency-light documentation of the approach |

`tools/` imports only numpy, scipy, and its own `dsp` module — no package
install, no cross-repo dependency. Scripts run directly from a checkout.

## Running

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

python3 tools/analyze_samples.py <sustain_dir>
python3 tools/loopfind.py <sustain_dir> <out_dir>
python3 tools/loop_qa.py <out_dir>/*.wav
```

There is no test suite. Verification is measurement: `loop_qa.py` is the gate,
and a change to loop or DSP code is unverified until it has been run against a
real sample folder and the pass count reported.

## Conventions

- Two hard-won DSP rules, stated in `tools/dsp.py`'s module docstring and not
  to be relaxed without measurement: RMS envelope windows must span several
  pitch periods, and pitch detection must be seeded from the nominal note in
  the filename. Both have bitten this code before — see RESEARCH.md §4.
- Thresholds live in one place: `loop_qa.py`'s defaults (`CV < 0.02`,
  `wrap < 3.0`), matching SPEC §11. Do not fork a second set of numbers.
- Sample audio is never committed. VCSL (CC0) is the source; `.gitignore`
  excludes `*.wav` deliberately.
- Honesty gates in the profile format (SPEC §7): a field is marked "measured"
  only if it was measured. Estimates are labelled as estimates, with source.
- `snake_case` functions and variables, `PascalCase` classes. Comments explain
  why, not what.
- One path, no fallbacks. Raise rather than silently substituting a default.

## Scope

Flutes only, no ocarinas. No physical instruments are recorded — samples come
from VCSL, tunings from published sources. Vibrato is out of scope for the
prototype. Live playback only; no rendering to file.
