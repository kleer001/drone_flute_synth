fresh

## Summary

There are now **two instruments** sharing one music engine, differing only in
what makes the sound. `./run.sh` is the browser one (Python plans breaths, the
page plays the loops with Web Audio); `./run_old.sh` is the GrandOrgue one,
unchanged and still passing its gates. `profile`, `moods`, `melody` and
`breath` are shared and know about neither.

This session: gave the instrument a **meter** (breaths resolve to bar lines,
notes are conventional values, tempo is a mood weight with a GUI slider); took
the loop gate from **8/13 to 12/13** by measuring the loop's envelope around it
rather than across it; widened the melody to eleven pitches; built the browser
instrument with live reverb, room presets and a submit-gated performance tab;
and measured **criterion 4** for the first time.

All previous breadcrumb todos are done. What remains is housekeeping and a few
deferred judgment calls. Working tree clean, **15 commits ahead of
origin/main**, nothing pushed.

## Todos

### Parallel
- [ ] #1 Clear `tmp/` — it is 1.7 GB. 1.4 GB is two GrandOrgue sandbox homes
      (`tmp/gohome2`, `tmp/gohome_cmb`) holding regenerable sample caches from
      the `.cmb` and reverb probes; 19 MB is `tmp/df`, Dragonfly `.deb`s
      downloaded to inspect and never installed. All scratch, all gitignored.
      Keep `tmp/toy_*.py` unless #2 moves them.
- [ ] #2 Promote `tmp/toy_pitch.py` into `tools/`. It is the **only**
      criterion-4 gate that exists and it sits in scratch, where every other
      gate has a home in `tools/`. It renders each drone voice in an
      `OfflineAudioContext` and autocorrelates — needs a running browser
      server and playwright. `tmp/toy_gate.py` and `tmp/toy_audio.py` are the
      UI/audio harnesses and could go with it.
- [ ] #3 `requirements.txt` pulls `mido` and `python-rtmidi` for a browser path
      that imports neither, and `run.sh` installs all four. Split the
      requirements, or have `run.sh` install only numpy and scipy.
- [ ] #4 Push the 15 commits to `origin/main` — deliberately held, awaiting the
      go-ahead.
- [ ] #5 Decide the **profile note-naming octave**. Every VCSL sample sounds
      exactly one octave above its filename (measured, ratio 2.000–2.004 across
      all 13) — the soprano recorder convention, named by fingering. So the
      profile's note names describe fingering, not pitch, and nothing in the
      docs says so. Either document it in the profile, or rename to sounding
      pitch (drone C5, melody C6–C7), which rewrites the ODF key mapping and
      needs GrandOrgue re-verified. Called "fine" for now; it will trip a cold
      reader.

### Sequential
_(none)_

## Context

**Two runners.** `./run.sh` → `belvedere_drone.browser.server`, serves on the
first free port at or above 8740, browser makes the sound. `./run_old.sh` →
GrandOrgue, ALSA MIDI, port 8737. Both fetch VCSL and build loops if missing.

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
the ramp it removes *is* the breath trend. RESEARCH.md §4 has both tables.

**GrandOrgue limits, measured against 3.17.3.** `PitchTuning` is bounded at
**±1800 cents** (−1800 loads, −1801 rejected), which is why the profile's drone
stops at C3 and why C2 needs the browser. The MIDI binding persists on its own
in `~/Documents/GrandOrgue/Data/<HASH>-0.cmb` (gzipped text, written on clean
exit) — **not** in `Settings/`, which stays empty; but when the ODF changes
shape GrandOrgue prompts before reusing it and waits for a human "Yes".

**Browser instrument.** `AudioBufferSourceNode` takes `loopStart`/`loopEnd`
(the `smpl` chunk) and `detune` **in cents** (the profile's cents table) — no
conversion, no ±1800 wall, so the drone offers C4/C3/C2/C1 via
`extend_drone()`, which mutates only this server's copy of the Profile.
`DRONE_FLOOR_OCTAVE` names the floor absolutely; an earlier relative count
silently reached C1 when the profile gained C3. Performance tab is
submit-gated with an exact countdown (the page owns the schedule); the room tab
is live and never reaches Python. `MAKEUP = 6.0` because VCSL peaks at
0.02–0.13.

**Verification.** Three gates: `tools/loop_qa.py` (12/13), `cli.py check` (six
MIDI criteria, both profiles), and the browser pitch measurement (criterion 4,
worst 8 cents). ±3 cents was never reachable against these samples — the raw
VCSL C4 is itself +3.2¢ sharp.

**Known gaps in the browser toy, deliberate:** no clash banner if two tabs
edit; room settings do not persist across reload; `makeImpulse` uses
`Math.random()` so the reverb tail differs per load even at the same seed.

**/simplify findings skipped, with reasons:** shared HTTP base handler and
shared `params.js`/CSS tokens across both pages (edits `web/`, which backs the
verified organ GUI); the deep `extend_drone` fix — declare the full drone range
in the profile and have `odfgen` refuse what `PitchTuning` cannot express,
which is the right altitude but changes the shared profile and needs GrandOrgue
re-verified.

## Next Step

Todo #4 or #1 — both are one-liners the user has to green-light. #2 is the one
with lasting value: criterion 4 has been unverified for the life of the project
and now has a working gate sitting in a directory that gets swept.

/home/menser/Dropbox/ai/code/drone_flute_synth
