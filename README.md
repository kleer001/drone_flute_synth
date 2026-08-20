# drone_flute_synth

Design work and measurement tools for a Linux app that plays an endless
performance on a **simulated drone flute** — a multi-chambered flute where one
chamber holds a sustained root while another plays melody on the same breath.
Sound generation is delegated to **GrandOrgue** playing a purpose-built sample
set; the app is the player, not the synth.

**Status: specification + validated tooling. No application code yet.**

| File | What it is |
|---|---|
| [`SPEC.md`](SPEC.md) | The build specification — architecture, ODF mapping, breath model, controls, acceptance criteria, ordered spikes |
| [`RESEARCH.md`](RESEARCH.md) | What was researched and measured, including the loop-authoring experiment log and what each failed variant taught |
| `tools/dsp.py` | Shared DSP helpers (sample loading, period-aware envelopes, seeded pitch detection) |
| `tools/analyze_samples.py` | Inventory a sample folder: format, usable steady state, pitch accuracy vs. nominal |
| `tools/loop_qa.py` | **Acceptance gate** — reads `smpl` loop points, tiles to 60 s, scores pulsing and wrap discontinuity |
| `tools/loopfind.py` | Reference loop finder. Superseded for production by LoopAuditioneer; kept because it is dependency-light and documents the approach |

## Scope

Flutes only (no ocarinas). No physical instruments to record — samples come from
[VCSL](https://github.com/sgossner/VCSL) (CC0) and tunings from published
sources. Vibrato out of scope for the prototype. Live playback only.

## Setup

Python 3 with numpy and scipy; nothing else. The tools run straight from a
checkout — no package install.

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

## Current measured state

Against VCSL's Baroque Soprano Recorder (13 sustain notes, 48 kHz stereo):

- Steady state 4.5–10.6 s per note; pitch within **±6.2 cents** of nominal.
- `loopfind.py` + `loop_qa.py`: **8 of 13** notes pass both thresholds. Wrap
  discontinuity is solved across the board (0.08–4.5, mostly ~1); envelope
  pulsing is the binding constraint on the 5 failures.

See RESEARCH.md for how that number moved from 2/13 to 8/13 and what a
measurement bug nearly hid.

## License

MIT — see [LICENSE](LICENSE). Sample material referenced here comes from
[VCSL](https://github.com/sgossner/VCSL) under CC0 and is not redistributed in
this repo.
