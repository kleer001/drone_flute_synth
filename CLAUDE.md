# drone_flute_synth

A lead voice over a drone, with a drum, a rattle and a rain stick around it,
playing an endless generative performance in the browser. **The whole
instrument is a static site at the repo root** — engine included — published at
https://kleer001.github.io/drone_flute_synth/ by GitHub Pages, source `main` /
`/`. The page files sit beside the tooling because Pages serves the root, so
that is where they are.

Key and scale are controls: twelve keys, twelve scales, plus three optional
drone slots each holding a semitone offset from the tonic. The performance runs
free by default; song form arranges it into repeating blocks instead.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The page: the Web Audio graph, the controls, the mixer and effects, the lookahead scheduler |
| `engine/scales.js` | Keys and scales — semitone offsets from a tonic, and the pitches they yield in a range |
| `engine/melody.js` | The motif engine — the part that makes it musical |
| `engine/breath.js` | The breath cycle: phrases resolved to bar lines, plus `Meter` |
| `engine/percussion.js` | The rhythm layers: which stroke serves which role, the drum's hocket, the rattle's cell and fill |
| `engine/song.js` | Song form: blocks of a call and its answer, arranged so none follows itself |
| `engine/moods.js` | Parameter set: weights, bounds, whole-set validation, drone defaults |
| `engine/profile.js` | Everything true of *these recordings*: sounding offset, lead range, drone octave, meter, makeup gain, provenance |
| `engine/samples.js` | The recordings: RIFF chunk parsing, the manifest reader, and the two pools — `SampleSet` by pitch, `StrokeSet` by stroke |
| `engine/instrument.js` | The seam the page talks to: params in, breaths out |
| `engine/rng.js` | Seeded PRNG, plus round-half-to-even and non-negative modulo |
| `loops/` | The authored loops, **committed** — without them there is no player to link to |
| `strokes/` | The authored percussion one-shots, committed for the same reason |
| `manifest.json` | Generated index of both directories — the browser cannot list one |
| `check.mjs` | Acceptance gate for the engine (node, no browser) |
| `tools/` | Build-time sample work in Python: inventory, loop and one-shot authoring, their QA gates, manifest |

There is no Python at runtime. `tools/` is a build step and imports only numpy,
scipy and its own `dsp` module.

## Running

```bash
./run.sh                 # serves the repo root on the first free port from 8740
./run.sh --rebuild       # re-author the loops from VCSL first (needs the venv)

node check.mjs --key F# --mode blues       # the engine gate
python3 tools/loop_qa.py loops/*.wav      # the loop gate
python3 tools/stroke_qa.py strokes/*.wav  # the one-shot gate
```

`?key=`, `?mode=`, `?mood=` and `?seed=` set the page's starting state, as do
`?song=1`, `?blocks=`, `?repeats=`, `?drum=1`, `?rattle=1` and `?wash=1`.

## How it fits together

**The melody engine does not know what a scale is.** `Phrasing` works on
integer *positions* in a note list — `pos + step`, `_fold`, `notes[pos]`. The
only pitch-aware function is `stability()`, which folds intervals against the
tonic to find rest points. So changing key or scale means handing it a different
list, and the generator is untouched by it. That is why twelve scales cost
nothing and why the thirteenth would too.

**Pitch is arithmetic, not authorship.** `scales.pitches` yields every MIDI note
of a key and scale inside a range; `SampleSet.voiceFor` picks the nearest
recording and returns the cents to reach the target. There is no cents table and
no hand-written pitch-fill map. The recordings are whole-tone spaced, so nothing
inside the recorded span shifts more than 100 cents — asserted by `check.mjs`
across all 144 combinations.

**Note names are sounding pitch.** The loop files are named by fingering and a
soprano recorder sounds an octave above that; `soundingOffset` in
`engine/profile.js` is the only place that distinction exists.

**Recordings come in two forms, and the pools differ in what indexes them.**
A sustained note is looped, so one recording covers a whole breath; a struck
one is over when it is over. `SampleSet` is indexed by *pitch* — hand it a MIDI
note, get the nearest recording and the cents to reach it. `StrokeSet` is
indexed by *stroke and force* — hand it `hit` at velocity 96, get the layer
recorded at about that force and a variation. Both live in `samples.js`, and
`readSampleInfo` reports a missing `smpl` chunk as `loop: null` rather than as
an error, because a one-shot wants none; `readLoopPoints` is the caller that
says a missing one is fatal.

**Nothing at runtime parses a recording's name.** VCSL names its percussion
inconsistently across instruments — `HDrumL_Hit_v2_rr1_Sum`,
`Mid_ShakerDouble_Down_rr1`, `Cabasa1_Rub_v1_rr2_Mid` — so which file is which
stroke is decided once, by a table in `tools/oneshot.py`, and written into the
manifest. Everything downstream reads `<pool>-<stroke>-l<level>-v<variant>.wav`,
which is ours and regular.

**A round robin that can repeat is not one.** `StrokeSet.pick` draws from a
layer excluding the recording it used last, because two identical onsets
running is the sound of a sampler rather than a player — which is the only
reason several recordings of one stroke were authored. Where a layer holds two
that is strict alternation; where it holds more it is a walk that never repeats
immediately. The variations inside a layer are sorted, so which one a seed
reaches does not depend on the order the build step walked the directory in.

**Velocity layers are spread across the range, not keyed on their numbers.**
The frame drum was recorded at VCSL's layers 2 and 3 and has no layer 1, so a
table keyed on the recorded number would leave the bottom of the velocity range
unplayable. `pick` spreads whatever layers exist evenly over 0–127 instead, and
`check.mjs` asserts that velocity 0 and 127 reach the softest and loudest.

**A pool is normalised by one factor, not file by file — and then levelled
per recording at playback.** Two different operations on two different axes,
and collapsing them into one is the mistake worth not repeating.

The *build step* scales a whole pool by a single factor, so every level
relationship the recordings carry survives into the files. Normalising each
file to its own peak there would flatten the lot, including the one
relationship that means something: a muted hit really is quieter than an open
one.

The *engine* then applies a per-recording gain that brings every recording of
**one stroke** to a common loudness, never across strokes. What that removes is
two accidents. Across layers, VCSL recorded the frame drum about 15 dB apart in
body level and `pick` crosses between those layers at velocity 64. Within a
layer, the two round-robin takes differ by up to 5.4 dB — more than a whole
step of the velocity curve, so two strikes at the *same* velocity landed 5 dB
apart and a sweep came out non-monotone: velocity 32 measured quieter than
velocity 24. Neither is dynamics; dynamics come continuously from the velocity
curve. A layer's worth is its timbre and a round robin's worth is that no two
onsets are identical, and both survive untouched.

Measured before and after: the worst spread inside a stroke was 21.9 dB, and is
now under 0.5 dB, with the velocity sweep monotone across the layer boundary.
Boosting is safe because it moves signal and noise together — the takes being
lifted carry 39–43 dB of signal to noise and still do afterwards.

Loudness is measured at build time into the manifest and the *policy* is in
`StrokeSet._level`, so what to do about a measurement can change without
re-authoring a sample.

**Percussion draws from its own random stream.** Sharing the melody's would
mean a strike consumed a number the phrase generator was going to use, so
turning a drum on would rewrite the tune and a seed would no longer name one
performance. `Instrument` seeds a second `Rng` from the same seed offset by a
constant; `check.mjs` asserts that several hundred strikes change no note of
40 breaths and that the strikes themselves reproduce.

**Each rhythm layer stands in a different relation to the tune, and that is
the whole design.** The drum *answers* it: `hocket` reduces the breath's notes
to the grid, takes the empty slots inside the span the tune occupies, and
spends a fraction of them strongest-first, so a strike never doubles an onset —
`check.mjs` asserts zero doubled onsets over 60 breaths. The rattle *references*
it: `timelineCell` takes the motif's own durations, stretches them by
`rattle_scale`, and runs the result against a free performance clock that
crosses the bar line and plays on through the inhale, which is what gives a
free melody something to be heard against. The rain stick *smears*: one wash,
rarely, eight seconds of grains held apart by `WASH_MIN_GAP` breaths so two
never read as one gesture.

**The rattle's fill adds; it never takes away.** A player gets busier by
subdividing, not by skipping, so `rattle_fill` only places strokes in the gaps
*between* the cell's onsets — the figure itself sounds identically at every
setting, and at 1 every unit of the grid sounds with the cell accented on top.
Thinning the cell instead would eat the one thing the layer is for; how sparse
the figure is, is `rattle_scale`.

The fill's velocity is per pool, and that is not a preference. Strokes are
levelled within themselves and never against each other, so what a pool's
second stroke was recorded at carries into the mix: at one velocity the
cabasa's rub arrives about 6 dB *over* its own hit while the rattle's up-stroke
sits 4 dB under. The velocities in `RATTLE_STROKE_ROLES` were solved against
the measured loudness to put every pool 4 dB under its own softest cell stroke,
and `check.mjs` recomputes that margin rather than trusting the numbers.

**A song is blocks, and a block is a call and its answer.** `song.js` orders
block *indices*, and each one expands to both of its breaths, so an answer can
never leave its call; the arrangement refuses to place a block twice running,
moving an offender to the back and reshuffling when that locks at the tail. It
draws from a third stream seeded off the same seed, so turning song form on
rearranges the performance without changing what the breaths themselves are.

**Loop points are read before decoding.** `decodeAudioData` discards the `smpl`
chunk *and* detaches the ArrayBuffer, and a buffer whose loop points went
missing does not error — it plays once and stops. `samples.js` walks the RIFF
chunk table rather than scanning for the bytes "smpl", which can occur inside
sample data.

**The voice table is built once, covering every reachable pitch.** That includes
octaves the lead can be shifted to, not just the one it starts in — a note the
table misses comes back `undefined` and reaches an `AudioParam` several layers
down. `check.mjs` walks all 576 key/scale/octave combinations for this.

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
plus ornaments sitting a little under the note they decorate. Drift, swell and
breath-pressure variation were tried and removed: they read as slop, and on a
real duct flute louder would also mean sharper.

**The inhale is a count of sixteenths, and a beat is the floor a mood is
written at.** The cycle is whole bars and the inhale is subtracted from it, so
the phrase length is the remainder and need not land on a beat. The floor is
not arithmetic but the rattle: it runs on the eighth-note grid, so a gap
shorter than a beat is at most one slot of it and the layer stops reading as
indifferent to the breath — measured, a two-sixteenth inhale put no rattle
stroke in the gap across 60 breaths. Shorter is still the control's to ask for;
the range starts at one sixteenth.

**Drones are three optional slots**, each a semitone offset from the tonic, so a
fifth is +7 in every scale and a drone can sit deliberately outside the one
being played. They share one gain stage scaled by 1/sqrt(n).

**Everything the page reads off `describe()` is in `describe()`.** It returns
the ranges, the menus, the voices *and* the envelope times and voice gains. A
field omitted there surfaces as `NaN` deep in an `AudioParam` call, not as a
missing-property error.

**The mixer is one channel per instrument, not one wet/dry stage.** Each of
the five runs dry to the master and taps a send to the reverb and to the delay,
which is what lets the drum sit close while the drone sits far back in the same
room. `MIX` is the only place a channel is written down and the strips are
built from it, so a channel cannot exist in the graph without a strip to move
it. Tone sits after the master rather than before the sends, so a darker room
darkens the tails too. Only the percussion channels skip the sample set's
makeup gain, because only the loops were recorded quietly enough to need it.

**Facts about the recordings live in `profile.js`, not in the audio graph.**
Makeup gain is the example that got this wrong once: it is a compensation for
how quietly VCSL recorded, so it belongs with the sample set and not beside the
`GainNode` that applies it. Re-authoring the loops at a different level then
moves one constant in one file.

**Adding a parameter touches four places, and three of them are derived.** Its
range goes in `moods.NUMERIC_PARAMS` and, if the mood owns it, its name in
`moods.MOOD_WEIGHTS`; `BREATH_FIELDS` is then computed as the difference, and
the page builds its row from `describe()`. Only a menu-valued parameter needs a
fifth edit (`moods.CHOICE_PARAMS` and its markup in `index.html`) — and
`CHOICE_PARAMS` is subtracted from `BREATH_FIELDS`, so a numeric parameter on a
menu does not also appear as a slider. `lead_octave` is the worked example:
numeric, ranged, validated like any weight, rendered as four named choices. A
parameter without a default in the `Instrument` constructor is rejected by
`update()` forever as "must be a number".

## Verification

There is no unit-test suite. Verification is measurement, and there are three
gates: `tools/loop_qa.py` for the loops, `tools/stroke_qa.py` for the one-shots,
`check.mjs` for the engine. The one-shot gate is fatal in `run.sh` where the
loop gate is advisory: a loop that misses its CV threshold is a known
compromise on the lowest note, while a one-shot that fails carries a click or a
DC step that every onset would sound. A change
to loop or DSP code is measured by running it against a real sample folder and
reporting the pass count. A change to the audio graph or the page is measured by
a browser actually playing it — serving the repo root and driving it headlessly.

Note that `app.js` is an ES module, so its internals are **not** reachable
as globals from an injected script. Measuring audio means importing the engine
modules dynamically and rendering through an `OfflineAudioContext`; that
exercises the same voices, loop points and detune the live graph uses.

Measured, and worth not re-deriving: three drones in A rendered 440.37 / 657.53
/ 220.18 Hz against A4 440, E5 659.26, A3 220.

## Conventions

- Three hard-won DSP rules, stated in `tools/dsp.py` and each established by
  measurement: RMS envelope windows span several pitch periods, pitch detection
  is seeded from the nominal note in the filename, and the size of a struck
  sound is the loudest 50 ms window rather than the peak — the frame drum's
  layers differ by 19 dB of peak but 15 dB of body, so levelling by peak
  over-corrects by 4 dB.
- Thresholds live in one place: `loop_qa.py`'s defaults (`CV < 0.02`,
  `wrap < 3.0`). Parameter ranges live in `moods.NUMERIC_PARAMS`, and the page
  reads them from `describe()` rather than restating them.
- The engine uses round-half-to-even (`rng.js`'s `round`), not `Math.round`.
  The grid arithmetic lands on exact halves often enough that half-up shows as
  a rhythmic lean.
- Rebuilding also refreshes `manifest.json` — the browser cannot list a
  directory, and a stale manifest is a silently missing note or a stroke that
  never sounds. It sits at the root because it indexes both `loops/` and
  `strokes/`. `run.sh --rebuild` does all of it, and `check.mjs` fails if the
  manifest and the directories disagree.
- The manifest is read through `samples.parseManifest` rather than indexed
  field by field, because the page and the acceptance gate have to agree about
  what a pool is and a second reader is one edit from disagreeing.
- Loop files hold the loop **twice**, with the loop points on the second copy.
  The first is pre-roll (the note's entry, and what a crossfading reader needs);
  nothing reads past `loopEnd`, so a third copy would be a third of the payload
  fetched and decoded unheard.
- `snake_case` in Python, `camelCase` in JS, `PascalCase` classes. Parameter
  *keys* stay snake_case on both sides, because they cross the boundary.
- Lists are derived rather than written twice. `BREATH_FIELDS`,
  `TRANSFORM_NAMES` and `ROOM_FIELDS` are all computed from the table they
  describe, because a hand-kept copy is one edit from a control that silently
  never lights up.
- One path, no fallbacks: the code throws rather than silently substituting a
  default.

## Scope

Five voices: a lead flute, up to three drones sharing one stage, a drum, a
rattle and a rain stick. The flute and the drone come from one pitched sample
set; the three rhythm layers each draw from a pool of one-shots, and the drum
and the rattle can be pointed at any pool whose strokes their role table knows.

No physical instruments are recorded; samples come from VCSL (CC0). Playback is
live; there is no rendering to file. There is no vibrato, though `detune` is an
automatable `AudioParam`, so that is a choice rather than a limit.
