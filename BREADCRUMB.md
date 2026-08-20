fresh

## Summary

Ran SPEC.md end to end: all five spikes (§12), then built a v0 app. The spikes
changed the spec — S1 killed §2's stretched-octave thesis, S4 made breath layers
velocity-based, S5 dropped LoopAuditioneer. SPEC/RESEARCH/README/CLAUDE.md are
updated to match.

Working: ODF generation loads cleanly in GrandOrgue 3.17.3, MIDI seam is live,
MIDI-side acceptance criteria pass. **Not yet working: trustworthy audio.**
GrandOrgue emits a constant 932 Hz tone with no MIDI input, and reports
polyphony 0 while doing it — so we cannot yet say "it makes sounds" honestly.

Two user directives are outstanding: move the package under `src/` like
`../create_project` does, and get `run.sh` actually launching the thing.

## Todos

### Parallel
- [ ] #1 Move `belvedere_drone/` to `src/belvedere_drone/` per `../create_project`
      conventions: add `pyproject.toml` (hatchling, `packages = ["src/<pkg>"]`,
      `requires-python`, dev extras pytest/ruff, `[tool.ruff] line-length = 100`,
      `[tool.pytest.ini_options] pythonpath = ["src"]`). Update SPEC §10's module
      layout, CLAUDE.md and README paths, and `run.sh`'s `-m` invocations.
- [ ] #2 Diagnose the constant 932 Hz tone (see Context — this is the blocker on
      any claim that it makes sound).
- [ ] #6 Move working files out of system `/tmp` into the repo's `tmp/`
      (new global rule). `tmp/` and `vendor/` are already in `.gitignore`.

### Sequential
- [ ] #3 (needs: #2) Verify `run.sh` end to end on a real desktop session —
      it has never been run start-to-finish; only its individual steps have.
- [ ] #4 (needs: #2) Teach `run.sh` to seed GrandOrgue's audio device on first
      run, so a fresh clone makes sound without hand-configuring the GUI.
- [ ] #5 (needs: #2) Write `tools/pitch_qa.py` for SPEC §11 criterion 4: sound
      each pipe alone, record, `dsp.detect_f0` seeded from nominal, assert within
      ±3 cents of the profile's cents table. The recording rig now exists.
- [ ] #7 (needs: #1) Commit. Nothing from this session is committed yet.

## Context

**Nothing is committed.** Working tree has modified SPEC.md, RESEARCH.md,
README.md, CLAUDE.md, requirements.txt, tools/dsp.py, tools/loopfind.py, plus
untracked `belvedere_drone/`, `profiles/`, `run.sh`.

**The 932 Hz problem (todo #2).** Evidence gathered, in order:
- GrandOrgue running, zero MIDI sent → constant 932 Hz sine, RMS 0.0101,
  peak 0.0150 (peak/RMS ≈ 1.49, so near-pure tone), dead flat across the whole
  recording including breath gaps.
- GrandOrgue not running → null sink is *exactly* silent (RMS 0.000000). So it
  is GrandOrgue's stream, not another app.
- CC 123 + CC 120 on all 16 channels does **not** stop it → not a stuck MIDI note.
- GrandOrgue's own toolbar reports **polyphony 0** while the tone plays.
- 932 Hz = A#5 (932.33), which is both melody Pipe006 and exactly 2× the drone
  A#4 (466.16).
Polyphony 0 + a pure tone points away from "a pipe is stuck" and toward an audio
path artifact — e.g. PortAudio/ALSA underrunning and repeating a stale buffer.
Worth testing next: run GrandOrgue with **no organ loaded** (`-g`) and see if the
tone is still there. That separates ODF from audio backend in one shot.

**GrandOrgue config is gzipped INI** at `$HOME/GrandOrgueConfig`. Read/patch with
`gzip.decompress` / `gzip.compress`. Seeding these three keys under
`[AudioDevices]` is what made it produce audio at all (it ships with an empty
device and is silent until set):
```
Device001Name=PortAudio: ALSA: pulse
Device001ApiName=ALSA
Device001PortName=PortAudio
```
MIDI needs no seeding: `[MIDIIn]` enables "Midi Through" by default and
`[MidiInitial001]` binds Manual 1 (ObjectType=Manual, ReceiverType=Manual,
MidiInputNumber=1), so channel 1 note-ons reach the manual.

**Silent capture rig** (records without playing through the user's headset):
```bash
pactl load-module module-null-sink sink_name=drone_test    # returns module id
PULSE_SINK=drone_test <launch GrandOrgue>
parec --device=drone_test.monitor --format=s16le --rate=48000 --channels=2 \
      --file-format=wav out.wav
pactl unload-module <id>     # ALWAYS unload when finished
```
Headless GrandOrgue runs under `Xvfb :NN` + `xdotool` + `import -window root`.
Its error text only appears in a separate window titled "Log messages" — raise it
with `xdotool windowmap/windowraise` and screenshot; stderr shows nothing useful.

**GrandOrgue binary**: upstream AppImage 3.17.3-1, extracted with
`--appimage-extract` (no root, no FUSE). `run.sh` fetches it into `vendor/`.
Ubuntu's packaged 3.13.1 is older.

**ODF facts that cost time** (all in RESEARCH.md §7, don't re-derive):
`AcceptsRetuning=N` is mandatory — MIDI keys are scale-degree indices, so a stock
temperament implies a >1800-cent retune and GrandOrgue rejects every pipe. 28
`Disp*` keys are required even with nothing displayed. `[Manual001]` must list
stops (`Stop001=1`), not just count them. Upstream's
`src/tests/testing/resources/minimal.organ` is the authority on required keys.

**Naming question for #1**: `belvedere_drone` comes from SPEC §10 and §3's
architecture diagram, not from thin air — but the user reacted to it. Decide
whether to keep it or rename (and update SPEC if renaming).

**Loop QA is 8/13** and the shipped profile knowingly uses one failing loop
(F#5, wrap 4.5) because it is the only recording near F5.

**Cleanup done this session**: the PipeWire null sink module was unloaded and
stray Xvfb servers killed. If a `drone_test` sink reappears, it leaked —
`pactl unload-module` it.

## Next Step

Todo #2: run GrandOrgue with `-g` (GUI only, no organ) under the null-sink rig
and record. If the 932 Hz tone is still present with no samples loaded, it is the
PortAudio/ALSA path and the ODF is exonerated; if it vanishes, bisect the ODF by
loading a single-pipe organ.

/home/menser/Dropbox/ai/code/drone_flute_synth
