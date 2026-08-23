fresh

## Summary

**The instrument is a static site at the repo root** — engine included — live
at https://kleer001.github.io/drone_flute_synth/ via GitHub Pages (`main`, `/`).
The page files sit beside the tooling because that is what root-serving needs.
No Python at runtime; `tools/` is a build step only.

**Key and scale are now controls.** Twelve keys x twelve scales, plus three
optional drone slots each holding a semitone offset from the tonic. The fixed
per-profile note list, the just-intonation cents table, chambers, holes and
hand-authored pitch-fill are all gone: pitch is `scales.pitches` for what to
play and `SampleSet.voiceFor` for which recording plays it. Worst shift across
all 144 key/scale combinations is 100 cents, asserted by `check.mjs`.

The engine was **ported from Python to JavaScript** and the Python one
retired, so there is still exactly one engine. The port is faithful: over
2400 breaths per mood the two agree on notes-per-breath, breath length, grace
count, register span and call/answer ratio to within a few percent.
It is not bit-identical and cannot be — the PRNG differs — so old Python seeds
do not carry over.

`SPEC.md` and `RESEARCH.md` are deleted, along with every GrandOrgue trace
(2.1 GB of AppImage and sandbox homes included).

A `/simplify` pass then ran over the port. The two findings that mattered:
`check.mjs` was scanning `loops/` while the page reads `manifest.json`, so
the gate was blind to exactly the drift the manifest exists to prevent; and
`loopfind.py` tiled each loop 3x with `loopEnd` at 2/3, so a third of every
shipped file was fetched and decoded unheard. Both fixed — payload 4.9 -> 3.3 MB,
and the gate now fails on a stale manifest (verified by staling one).

## Todos

### Parallel
- [ ] #1 Clear `tmp/`. 19 MB is `tmp/df`, Dragonfly `.deb`s downloaded to
      inspect and never installed; the rest is 60-second `.wav` renders and
      scratch. All gitignored. Keep `tmp/toy_*.py` unless #2 moves them.
- [ ] #2 Promote the drone-pitch measurement into a real gate. It currently
      lives as an ad-hoc `OfflineAudioContext` render driven through
      playwright; `check.mjs` covers the engine but nothing automated covers
      output pitch. `tmp/toy_pitch.py` is the older Python sketch of it.
- [ ] #4 Push, then enable GitHub Pages (Settings -> Pages -> main, /docs).
      The README already links to the Pages URL, so the link is dead until
      both are done.
- [ ] #5 Consider a **drone level per slot**. Three drones share one gain
      stage scaled by 1/sqrt(n), which keeps the total sane but means a fifth
      cannot be tucked under a root. Only worth it if it sounds wanted.
- [ ] #6 Two `/simplify` findings were deliberately skipped and are still open.
      `describe()` re-exports twelve module constants across what used to be an
      HTTP boundary — app.js could import them directly and the snake_case
      naming would go with it. And the breath envelope is split: the engine
      owns attack/release times, the page owns the curve shape. Both are
      restructures rather than cleanups.

### Sequential
_(none)_

## Context

**The runner.** `./run.sh` serves the repo root on the first free port at or above
8740 via `http.server`. It only builds loops when `loops/` is empty or you
pass `--rebuild`. Key/scale/mood/seed are page controls and URL params
(`?key=A&mode=phrygian`), not CLI flags.

**The loops are committed** (13 files, 3.3 MB, `loops/`), which reverses
the old "sample audio is never committed" rule — a static player has to ship
its audio. They are CC0-derived. `loops/manifest.json` lists them because
a browser cannot list a directory; `tools/manifest.py` regenerates it and
`check.mjs` fails if it disagrees with the directory.

Each file holds the loop **twice**, loop points on the second copy. The first
is pre-roll — the note's entry, and what a crossfading reader needs before
`loopStart`. Nothing reads past `loopEnd`, which is why there is no third copy.

**Note names are sounding pitch.** The loop files are fingering-named and a
soprano recorder sounds an octave above that; `sounding_offset = 12` in the
profile is the only place that distinction lives. Measured: no energy at the
named frequency, all of it at twice.

**The meter.** Profile `[meter]` carries `beats_per_measure` (the bar belongs
to the instrument); `bpm` is a **mood weight** (tempo belongs to the piece) —
sleep 48, mourning 56, ceremonial 66, contemplative 72, pastoral 88, restless
120. A breath cycle (sounding + inhale) is a whole number of bars, the player
breathes on the last beats, the next phrase enters on a downbeat. Onsets are
eighth-note positions, durations conventional values via `melody.fit_value`.
1036 structural notes across six moods measured clean.

**Loop finder.** `flatten()` measures the RMS envelope on the segment wrapped
around itself. Measured open, the envelope's ends disagree by up to 0.82 in log
gain and that lands as a step on the seam. The alternative — removing the
endpoint ramp in the log domain — fixes wrap and destroys CV (0/13), because
the ramp it removes *is* the breath trend. Measured over all thirteen:
envelope open 8/13, endpoint ramp removed 0/13, envelope circular **12/13**.

**The audio side.** `AudioBufferSourceNode` takes `loopStart`/`loopEnd` in
seconds (straight from the `smpl` chunk) and `detune` in cents (straight from
`SampleSet.voiceFor`) — nothing is converted anywhere. Loop points must be read
from the bytes *before* `decodeAudioData`, which discards the chunk and detaches
the buffer; a buffer that lost them plays once and stops rather than erroring.
The performance panel is submit-gated with an exact countdown (the page owns the
schedule, so it knows when the scheduled music runs out); the room panel is live.
`INSTRUMENT.makeupGain = 6.0` because VCSL peaks at 0.02–0.13 — a fact about the
recordings, so it lives with them and not in the graph.

**Verification.** Two gates plus a manual measurement: `tools/loop_qa.py`
(12/13) for the samples, `node check.mjs` for the engine (determinism, no
repeated breath, 144-combination coverage, validation, manifest freshness), and
an `OfflineAudioContext` render driven through playwright for output pitch —
three drones in A at 440.37 / 657.53 / 220.18 Hz. That last one is still ad-hoc;
see todo #2. ±3 cents was never reachable against these samples — the raw VCSL
C is itself +3.2¢ sharp.

**Known gaps in the browser toy, deliberate:** no clash banner if two tabs
edit; room settings do not persist across reload; `makeImpulse` uses
`Math.random()` so the reverb tail differs per load even at the same seed.

**/simplify findings skipped, with reasons:** a shared HTTP base handler and
shared CSS tokens, both of which were cross-page factorings when there were two
pages.

## Next Step

Todo #4 or #1 — both are one-liners the user has to green-light. #2 is the one
with lasting value: criterion 4 has been unverified for the life of the project
and now has a working gate sitting in a directory that gets swept.

/home/menser/Dropbox/ai/code/drone_flute_synth
