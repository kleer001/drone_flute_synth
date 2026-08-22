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
The web GUI of SPEC §10 is built: `--gui` serves it on `127.0.0.1:8737`.

## Layout

| Path | What it is |
|---|---|
| `SPEC.md` | The build specification — architecture, ODF mapping, breath model, controls, web GUI, acceptance criteria, ordered spikes. The authority; when code and spec disagree, resolve it explicitly. |
| `RESEARCH.md` | What was researched and measured, including the loop-authoring experiment log and what each failed variant taught. Read §4 before touching loop code. |
| `tools/dsp.py` | Shared DSP helpers — sample loading, period-aware envelopes, seeded pitch detection |
| `tools/analyze_samples.py` | Inventory a sample folder: format, usable steady state, pitch accuracy vs. nominal |
| `tools/loop_qa.py` | Acceptance gate (SPEC §12 criterion 3). Exits non-zero on failure |
| `tools/loopfind.py` | Loop finder. Writes the `smpl` chunk GrandOrgue reads, so it is the build path — LoopAuditioneer turned out to be GUI-only (RESEARCH.md §7, S5) |
| `belvedere_drone/` | The app: profile loading, ODF generation, breath and melody scheduling, MIDI out, control seam, web GUI, CLI |
| `profiles/` | Instrument profiles, one TOML each (SPEC §7) |

`tools/` imports only numpy, scipy, and its own `dsp` module — no package
install, no cross-repo dependency. Scripts run directly from a checkout.

## Running

There are two instruments, sharing one music engine and differing only in what
makes the sound.

`./run.sh` is the browser one: Python plans the breaths and the page plays the
same loops with Web Audio. No GrandOrgue, no MIDI, no ODF, one process. Reverb,
tone and level are ours and move while it sounds. `belvedere_drone/browser/`
holds it.

`./run_old.sh` is the GrandOrgue one: it fetches what is missing, builds the
organ, starts GrandOrgue, serves the submit-gated GUI on the first free port at
or above 8737, and plays over ALSA MIDI. The steps below are that, done by hand.

`profile`, `moods`, `melody` and `breath` are shared and know about neither.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# build-time: samples -> loops -> QA gate
python3 tools/analyze_samples.py <sustain_dir>
python3 tools/loopfind.py <sustain_dir> <out_dir>
python3 tools/loop_qa.py <out_dir>/*.wav

# app: profile -> ODF, then play into a running GrandOrgue
python3 -m belvedere_drone.cli odf profiles/recorder-drone-c.toml build
python3 -m belvedere_drone.cli check profiles/recorder-drone-c.toml --out-dir build
python3 -m belvedere_drone.cli play profiles/recorder-drone-c.toml --out-dir build --mood pastoral

# the same performance with the web control surface (SPEC §10)
python3 -m belvedere_drone.cli play profiles/recorder-drone-c.toml --out-dir build --gui
```

`play` needs GrandOrgue running with the generated organ loaded; it finds the
`GrandOrgue` ALSA port by name. `--dry-run` records the MIDI stream instead of
opening a port, which is how the determinism criteria are tested.

The engine is authoritative and headless: `control.Controller` owns the
performance and both `cli.py` and `web/server.py` are clients of it. Nothing in
`control.py` imports the server, and the server never touches the scheduler
thread, the MIDI port, or the panic path.

GrandOrgue ignores incoming notes until a manual has a MIDI receiver bound in
its own window (right-click the manual, *Listen for events*). The generated
console draws its manual and stops so that is possible, and `midi_out` sends via
`Midi Through` so the binding stays valid across runs.

That binding is a one-time step per machine, not per run. GrandOrgue keeps it in
`~/Documents/GrandOrgue/Data/<HASH>-0.cmb` — gzipped text, written on clean exit
— and it survives both restarts and regeneration of the ODF. It is not in
`~/Documents/GrandOrgue/Settings/`, which stays empty; looking there is what
makes a working binding look lost. RESEARCH.md §7 has the sources, the two
failed attempts at seeding it from config, and why the file cannot be shipped
prebuilt.

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
