# drone_flute_synth

A lead voice over a drone, playing an endless generative performance in the
browser. **The whole instrument is a static site at the repo root** — engine
included — published at https://kleer001.github.io/drone_flute_synth/ by GitHub
Pages, source `main` / `/`. The page files live beside the tooling deliberately:
Pages serves the root, so that is where they have to be.

Key and scale are controls: twelve keys, twelve scales, plus three optional
drone slots each holding a semitone offset from the tonic.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The page: the Web Audio graph, the controls, the lookahead scheduler |
| `engine/scales.js` | Keys and scales — semitone offsets from a tonic, and the pitches they yield in a range |
| `engine/melody.js` | The motif engine — the part that makes it musical |
| `engine/breath.js` | The breath cycle: phrases resolved to bar lines, plus `Meter` |
| `engine/moods.js` | Parameter set: weights, bounds, whole-set validation, drone defaults |
| `engine/profile.js` | Everything true of *these recordings*: sounding offset, lead range, drone octave, meter, makeup gain, provenance |
| `engine/samples.js` | `smpl`-chunk parsing and nearest-recording lookup |
| `engine/instrument.js` | The seam the page talks to: params in, breaths out |
| `engine/rng.js` | Seeded PRNG, plus round-half-to-even and non-negative modulo |
| `loops/` | The authored loops, **committed** — without them there is no player to link to |
| `check.mjs` | Acceptance gate for the engine (node, no browser) |
| `tools/` | Build-time sample work in Python: inventory, loop authoring, loop QA, manifest |

There is no Python at runtime. `tools/` is a build step and imports only numpy,
scipy and its own `dsp` module.

## Running

```bash
./run.sh                 # serves the repo root on the first free port from 8740
./run.sh --rebuild       # re-author the loops from VCSL first (needs the venv)

node check.mjs --key F# --mode blues     # the engine gate
python3 tools/loop_qa.py loops/*.wav  # the sample gate
```

`?key=`, `?mode=`, `?mood=` and `?seed=` set the page's starting state.

## How it fits together

**The melody engine does not know what a scale is.** `Phrasing` works on
integer *positions* in a note list — `pos + step`, `_fold`, `notes[pos]`. The
only pitch-aware function is `stability()`, which folds intervals against the
tonic to find rest points. So changing key or scale means handing it a different
list, and the generator is untouched by it. Preserve this. It is why twelve
scales cost nothing and why the thirteenth will too.

**Pitch is arithmetic, not authorship.** `scales.pitches` yields every MIDI note
of a key and scale inside a range; `SampleSet.voiceFor` picks the nearest
recording and returns the cents to reach the target. There is no cents table and
no hand-written pitch-fill map, and there should not be one again. The
recordings are whole-tone spaced, so nothing inside the recorded span shifts
more than 100 cents — asserted by `check.mjs` across all 144 combinations.

**Note names are sounding pitch.** The loop files are named by fingering and a
soprano recorder sounds an octave above that; `soundingOffset` in
`engine/profile.js` is the only place that distinction exists.

**Loop points must be read before decoding.** `decodeAudioData` discards the
`smpl` chunk *and* detaches the ArrayBuffer, and a buffer whose loop points went
missing does not error — it plays once and stops. `samples.js` walks the RIFF
chunk table rather than scanning for the bytes "smpl", which can occur inside
sample data.

**The voice table is built once and must cover every reachable pitch.** That
includes octaves the lead can be shifted to, not just the one it starts in — a
note the table misses comes back `undefined` and reaches an `AudioParam` several
layers down. `check.mjs` walks all 576 key/scale/octave combinations for this.

**Notes are rasterized before they leave the engine.** `melody.rasterize` runs
at the end of every breath and drops any ornament that would start within
`MIN_ONSET_GAP_S` of another note. Ornaments are placed against the note they
decorate without knowing what else landed nearby, so two could arrive in the
same instant — and every onset restarts a sample, so a pile of them in one
moment is heard as a rasp. Structural notes are never dropped, which is why the
phrase that comes out is the phrase that went in, and why `noteSequence` is
unaffected. `check.mjs` asserts both halves.

**The player is an ideal one.** One blowing pressure for every note and every
breath (`breath.VELOCITY`), and true pitch throughout. The only thing that moves
the level is the metric accent — downbeat, beat, offbeat, about 2 dB across —
plus ornaments sitting a little under the note they decorate. Do not add drift,
swell or breath-pressure variation back: it was tried and it reads as slop, and
on a real duct flute louder would also mean sharper, which is worse.

**Drones are three optional slots**, each a semitone offset from the tonic, so a
fifth is +7 in every scale and a drone can sit deliberately outside the one
being played. They share one gain stage scaled by 1/sqrt(n).

**Everything the page reads off `describe()` must be in `describe()`.** It
returns the ranges, the menus, the voices *and* the envelope times and voice
gains. A field omitted there surfaces as `NaN` deep in an `AudioParam` call, not
as a missing-property error.

**Facts about the recordings live in `profile.js`, not in the audio graph.**
Makeup gain is the example that got this wrong once: it is a compensation for
how quietly VCSL recorded, so it belongs with the sample set and not beside the
`GainNode` that applies it. Re-author the loops at a different level and every
such constant should be in one file.

**Adding a parameter touches four places, and three of them are derived.** Put
its range in `moods.NUMERIC_PARAMS` and, if the mood owns it, its name in
`moods.MOOD_WEIGHTS`; `BREATH_FIELDS` is then computed as the difference, and
the page builds its row from `describe()`. Only a menu-valued parameter needs a
fifth edit (`moods.CHOICE_PARAMS` and its markup in `index.html`) — and note
that `CHOICE_PARAMS` is subtracted from `BREATH_FIELDS`, so a numeric parameter
on a menu does not also appear as a slider. `lead_octave` is the worked example:
numeric, ranged, validated like any weight, rendered as four named choices.
Give any new parameter a default in the `Instrument` constructor or `update()`
will reject it forever as "must be a number".

## Verification

There is no unit-test suite. Verification is measurement, and there are two
gates: `tools/loop_qa.py` for the samples, `check.mjs` for the engine. A change
to loop or DSP code is unverified until it has been run against a real sample
folder and the pass count reported. A change to the audio graph or the page is
unverified until a browser has actually played it — serve the repo root and drive it
headlessly.

Note that `app.js` is an ES module, so its internals are **not** reachable
as globals from an injected script. To measure audio, import the engine modules
dynamically and render through an `OfflineAudioContext`; that exercises the same
voices, loop points and detune the live graph uses.

Measured, and worth not re-deriving: three drones in A rendered 440.37 / 657.53
/ 220.18 Hz against A4 440, E5 659.26, A3 220.

## Conventions

- Two hard-won DSP rules, stated in `tools/dsp.py`'s module docstring and not
  to be relaxed without measurement: RMS envelope windows must span several
  pitch periods, and pitch detection must be seeded from the nominal note in
  the filename.
- Thresholds live in one place: `loop_qa.py`'s defaults (`CV < 0.02`,
  `wrap < 3.0`). Parameter ranges live in `moods.NUMERIC_PARAMS`, and the page
  reads them from `describe()` rather than restating them.
- The engine uses round-half-to-even (`rng.js`'s `round`), not `Math.round`.
  The grid arithmetic lands on exact halves often enough that half-up shows as
  a rhythmic lean.
- Rebuilding loops must also refresh `loops/manifest.json` — the browser
  cannot list a directory, and a stale manifest is a silently missing note.
  `run.sh --rebuild` does both, and `check.mjs` fails if they disagree.
- Loop files hold the loop **twice**, with the loop points on the second copy.
  The first is pre-roll (the note's entry, and what a crossfading reader needs);
  nothing reads past `loopEnd`, so a third copy would be a third of the payload
  fetched and decoded unheard.
- `snake_case` in Python, `camelCase` in JS, `PascalCase` classes. Parameter
  *keys* stay snake_case on both sides, because they cross the boundary.
- Prefer deriving a list to writing a second one. `BREATH_FIELDS`,
  `TRANSFORM_NAMES` and `ROOM_FIELDS` are all computed from the table they
  describe, because a hand-kept copy is one edit from a control that silently
  never lights up.
- One path, no fallbacks. Throw rather than silently substituting a default.

## Scope

Flutes only. No physical instruments are recorded — samples come from VCSL
(CC0). Live playback only; no rendering to file. Vibrato is out of scope,
though `detune` is an automatable `AudioParam`, so it is a choice rather than a
limit.
