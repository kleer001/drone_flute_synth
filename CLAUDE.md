# drone_flute_synth

Design work and build-time measurement tools for a Linux app that plays an
endless performance on a simulated drone flute. Sound generation is delegated
to **GrandOrgue** playing a purpose-built sample set; the app is the player,
not the synth.

**State: v0 implemented.** `belvedere_drone/` generates an ODF that loads in
GrandOrgue 3.17.3 and plays a live breath-phrased performance over ALSA MIDI.
The MIDI-side acceptance criteria pass; criterion 4 (measured output pitch)
needs a real audio device and is unverified. All five spikes in SPEC §13 are
done — RESEARCH.md §7 has the results, and several of them changed the spec.
The web GUI specified in SPEC §10 is not built yet; the CLI is the only
control surface.

## Layout

| Path | What it is |
|---|---|
| `SPEC.md` | The build specification — architecture, ODF mapping, breath model, controls, web GUI, acceptance criteria, ordered spikes. The authority; when code and spec disagree, resolve it explicitly. |
| `RESEARCH.md` | What was researched and measured, including the loop-authoring experiment log and what each failed variant taught. Read §4 before touching loop code. |
| `tools/dsp.py` | Shared DSP helpers — sample loading, period-aware envelopes, seeded pitch detection |
| `tools/analyze_samples.py` | Inventory a sample folder: format, usable steady state, pitch accuracy vs. nominal |
| `tools/loop_qa.py` | Acceptance gate (SPEC §12 criterion 3). Exits non-zero on failure |
| `tools/loopfind.py` | Loop finder. Writes the `smpl` chunk GrandOrgue reads, so it is the build path — LoopAuditioneer turned out to be GUI-only (RESEARCH.md §7, S5) |
| `belvedere_drone/` | The app: profile loading, ODF generation, breath and melody scheduling, MIDI out, CLI |
| `profiles/` | Instrument profiles, one TOML each (SPEC §7) |

`tools/` imports only numpy, scipy, and its own `dsp` module — no package
install, no cross-repo dependency. Scripts run directly from a checkout.

## Running

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# build-time: samples -> loops -> QA gate
python3 tools/analyze_samples.py <sustain_dir>
python3 tools/loopfind.py <sustain_dir> <out_dir>
python3 tools/loop_qa.py <out_dir>/*.wav

# app: profile -> ODF, then play into a running GrandOrgue
python3 -m belvedere_drone.cli odf profiles/naf-double-drone-as.toml build
python3 -m belvedere_drone.cli check profiles/naf-double-drone-as.toml --out-dir build
python3 -m belvedere_drone.cli play profiles/naf-double-drone-as.toml --out-dir build --mood pastoral
```

`play` needs GrandOrgue running with the generated organ loaded; it finds the
`GrandOrgue` ALSA port by name. `--dry-run` records the MIDI stream instead of
opening a port, which is how the determinism criteria are tested.

There is no test suite. Verification is measurement, and there are two gates:
`loop_qa.py` for the sample side, and `cli.py check` for the MIDI side. A change
to loop or DSP code is unverified until it has been run against a real sample
folder and the pass count reported. A change to the ODF generator is unverified
until GrandOrgue has actually loaded the output — offline inspection missed
bugs that made every pipe fail to load (RESEARCH.md §7, S5).

## Conventions

- Two hard-won DSP rules, stated in `tools/dsp.py`'s module docstring and not
  to be relaxed without measurement: RMS envelope windows must span several
  pitch periods, and pitch detection must be seeded from the nominal note in
  the filename. Both have bitten this code before — see RESEARCH.md §4.
- Thresholds live in one place: `loop_qa.py`'s defaults (`CV < 0.02`,
  `wrap < 3.0`), matching SPEC §12. Do not fork a second set of numbers.
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
