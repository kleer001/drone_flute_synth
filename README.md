# drone_flute_synth

A Linux app, and the measurement tools behind it, that plays an endless
performance on a **simulated drone flute** — a multi-chambered flute where one
chamber holds a sustained root while another plays melody on the same breath.
Sound generation is delegated to **GrandOrgue** playing a purpose-built sample
set; the app is the player, not the synth.

**Status: v0 works.** The generator produces an `.organ` that loads cleanly in
GrandOrgue 3.17.3, and the player streams a live, seeded, breath-phrased
performance to it over ALSA MIDI. All five spikes in SPEC §13 are done — and
two of them changed the design, including the one the project was built around
(see [Intonation](#intonation-what-spike-s1-found)).

| File | What it is |
|---|---|
| [`SPEC.md`](SPEC.md) | The build specification — architecture, ODF mapping, breath model, controls, web GUI, acceptance criteria, ordered spikes |
| [`RESEARCH.md`](RESEARCH.md) | What was researched and measured, including the loop-authoring experiment log and what each failed variant taught |
| `tools/dsp.py` | Shared DSP helpers (sample loading, period-aware envelopes, seeded pitch detection) |
| `tools/analyze_samples.py` | Inventory a sample folder: format, usable steady state, pitch accuracy vs. nominal |
| `tools/loop_qa.py` | **Acceptance gate** — reads `smpl` loop points, tiles to 60 s, scores pulsing and wrap discontinuity |
| `tools/loopfind.py` | Loop finder. Writes the `smpl` chunk GrandOrgue reads, so it *is* the build path — LoopAuditioneer turned out to be GUI-only |
| `belvedere_drone/` | The app — profile loading, ODF generation, sample staging, breath and melody scheduling, MIDI out, CLI |
| `profiles/` | Instrument profiles, one TOML each |

## Scope

Flutes only (no ocarinas). No physical instruments to record — samples come from
[VCSL](https://github.com/sgossner/VCSL) (CC0) and tunings from published
sources. Vibrato out of scope for the prototype. Live playback only.

## Setup

Python 3.11+ (for `tomllib`), with numpy and scipy for the tools and
mido + python-rtmidi for MIDI output. Everything runs straight from a checkout
— no package install. You also need GrandOrgue itself; the upstream
[AppImage](https://github.com/GrandOrgue/grandorgue/releases) needs no root.

```bash
git clone https://github.com/kleer001/drone_flute_synth.git
cd drone_flute_synth
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## Use

Inventory a folder of sustain samples:

```bash
python3 tools/analyze_samples.py /path/to/VCSL/Aerophones/Edge-blown\ Aerophones/Baroque\ Soprano\ Recorder/Sustain
```

Build candidate loops, then gate them:

```bash
python3 tools/loopfind.py <sustain_dir> <out_dir>
python3 tools/loop_qa.py <out_dir>/*.wav
```

`loop_qa.py` exits non-zero if any loop fails, so it drops straight into CI or a
build script. Thresholds: 60-second render envelope `CV < 0.02` (level pulsing)
and `wrap < 3.0` (splice discontinuity, as a multiple of the loop's own typical
sample-to-sample step).

Build the organ, check it, and play it:

```bash
python3 -m belvedere_drone.cli odf   profiles/naf-double-drone-as.toml build --loops <out_dir>
python3 -m belvedere_drone.cli check profiles/naf-double-drone-as.toml --out-dir build
python3 -m belvedere_drone.cli play  profiles/naf-double-drone-as.toml --out-dir build --mood pastoral
```

Load `build/naf-double-drone-as.organ` in GrandOrgue first; `play` finds the
`GrandOrgue` ALSA port by name. `--dry-run` records the MIDI stream instead of
opening a port. Every performance prints its seed, and the seed reproduces it
byte for byte.

## Intonation: what spike S1 found

The project was pitched on a strong claim — that Native American flutes have a
**stretched octave** of roughly 1150–1250 cents, which a conventional sampler
cannot represent and GrandOrgue's per-pipe tuning can. Going to find the
measurements behind that claim did not confirm it:

- Flutopedia, the standard reference, gives NAF scale steps in **integer
  semitones** and states no octave size.
- The acoustics paper it hosts treats a flat second octave as a **defect makers
  correct**, not an intended feature.
- Maker sources describe equal temperament, or offer **just intonation** as a
  deliberate option.
- The specific cents figures appear only in search-engine AI summaries — word
  for word across differently-worded queries — and on no primary page.

So the octave is 2:1, and the headline claim is retired. What replaces it is
smaller and sourced: a drone flute has a real reason to want just intonation,
because every melody note sounds against a fixed held root where tempered
beating is exposed. The shipped profile uses a just minor pentatonic and records
its provenance in the profile itself. RESEARCH.md §7 has the source-by-source
record.

## Current measured state

Against VCSL's Baroque Soprano Recorder (13 sustain notes, 48 kHz stereo):

- Steady state 4.5–10.6 s per note; pitch within **±6.2 cents** of nominal.
- `loopfind.py` + `loop_qa.py`: **8 of 13** notes pass both thresholds. Wrap
  discontinuity is solved across the board (0.08–4.5, mostly ~1); envelope
  pulsing is the binding constraint on the 5 failures.

See RESEARCH.md for how that number moved from 2/13 to 8/13 and what a
measurement bug nearly hid.

On the app side, `cli.py check` asserts the MIDI-side acceptance criteria:
determinism from the seed, no repeated consecutive breath, balanced note-on/off
over 60 breaths, and a panic path that sends all-notes-off and all-sound-off.
The one criterion still unverified is measured output pitch within ±3 cents,
which needs GrandOrgue's audio recorded on a machine with a real audio device.

## License

MIT — see [LICENSE](LICENSE). Sample material referenced here comes from
[VCSL](https://github.com/sgossner/VCSL) under CC0 and is not redistributed in
this repo.
