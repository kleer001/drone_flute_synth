fresh

## Summary

The instrument makes sound. Verified end to end on the real desktop and the real
output device: GrandOrgue on `:0`, audio recorded from the Plantronics sink's
monitor while `cli play` ran — 28.7 s, peak 0.049, inhale gaps visible as drops
to ~0.0005. That was the last blocker and it is closed.

Since the previous breadcrumb: the shipped profile moved from A#/NAF to
`recorder-drone-c` (C root, just intonation, **no borrowed samples**); the
melody engine was rewritten from a random walk into a motif engine with
call-and-answer phrasing; the SPEC §10 web GUI was built and measured; and
`run.sh` became a working one-command entry point.

Three items are outstanding — one bug, two features. None is started.

## Todos

### Parallel
- [ ] #1 BUG: the GUI's Submit/Revert buttons stay disabled when only a slider
      is moved. They enable when the change comes from the mood pull-down.
      Engine was verified healthy while reproducing (`running: true`,
      `in_flight: None`, `next_drain_in` ticking, no server-side dirty fields),
      so the form lock is NOT stuck — `locked = offline || inFlight !== null`
      is false. Fault is client-side in `web/static/app.js`: `anyDirty()` is not
      going true on slider input. Note synthetic `input` events DID enable
      Submit in earlier testing, so the repro probably needs a real pointer.
      Suspect `isDirty()`'s number compare or `render()` overwriting `working`.
- [ ] #2 FEATURE: octave control for the drone root — C4 → C3 → C2. Note the
      melody chamber is only 7 notes and answers already reach the top of it,
      so dropping the drone also gives the contour room (see Context).
- [ ] #3 FEATURE: reverb controls. GrandOrgue ships a convolution reverb
      (File → Settings → Reverb, built on `zita-convolver`), but it is **global,
      not per-organ**, and not MIDI-bindable — so decide what the GUI can
      honestly own versus only name. RESEARCH.md §8 has the capability table and
      the caveats; §10.11 forbids claiming knowledge of GrandOrgue's state.
- [ ] #4 Persist the GrandOrgue MIDI binding without a manual step. The import
      works but `File → Save` could not be driven by automation (neither
      `ctrl+s` nor clicking the menu item landed) and
      `~/Documents/GrandOrgue/Settings/` is still empty, so the binding is lost
      on restart. Find where GrandOrgue writes the `.cmb` on clean exit and ship
      that, or automate the save.
- [ ] #5 Promote `tmp/engrave.py` (proportional-time score → SVG/PDF) and
      `tmp/render_wav.py` (offline preview render) into `tools/` with
      `--seed` / `--mood` / `--duration` flags. Both are throwaway scripts in
      `tmp/` right now and will vanish.

### Sequential
- [ ] #6 (needs: #2) Widen the melody chamber once the octave control exists.
      VCSL has C4 D4 E4 F#4 G#4 A#4 recorded below what the profile uses, so the
      range can grow with no new machinery — a profile edit, not code.

## Context

**Sound path, now working.** Three separate faults, fixed in this order:
1. `odfgen` never emitted `MIDIInputNumber`. Default is 0 = *no association*, so
   no MIDI config could attach to the manual. **1 is the pedal; a single-manual
   organ is 2**, and its Initial MIDI slot is `MidiInitial002`, not 001.
2. The manual's receiver had degenerate ranges — `high_key: 0`, `high_value: 0`
   (key range 0..0, velocity range 1..0), matching nothing. Fixed by importing
   `grandorgue-midi.yaml` (committed at repo root) via
   **Audio/MIDI → MIDI Objects → Import**.
3. **The probes were sending the wrong notes.** `Manual001` starts at
   `FirstAccessibleKeyMIDINoteNumber` = 36 and the app sends 36..44 from the key
   manifest, but every manual test used 60..67. GrandOrgue receives out-of-range
   notes and correctly drops them, which is **indistinguishable from an unbound
   receiver**. This cost hours. Check the key range first.

**Diagnostics that work:** `Audio/MIDI → Log MIDI events` prints every arriving
event and separates "not received" from "received and dropped".
`aconnect -l` confirms the ALSA subscription. Hand-writing the GrandOrgue config
file failed three times — the GUI's YAML **Export** is what made the real state
visible. GrandOrgue's own help is bundled at
`vendor/grandorgue/usr/share/GrandOrgue/help/GrandOrgue.htb` (a zip of HTML);
read it before reverse-engineering anything. Chapter 10 is the ODF reference.

**GTK file dialogs mangle typed paths** (inline autocompletion turns
`/home/menser/...` into `/home/me/menser/...`). Put the path on the clipboard
with `xclip -selection clipboard` and `ctrl+v` instead of `xdotool type`.

**Profile.** `profiles/recorder-drone-c.toml` ships. Root C, melody
C5 D5 E5 F#5 G5 A#5 C6 — every one a real VCSL recording, so `PitchTuning`
carries only the cents table (max 13.69 ¢, was 118). `C5 → G5` is the *only*
perfect fifth in the 13 recordings, which is why the root is C. Those seven
pitches are harmonics 8·9·10·11·12·14·16 of C. The A# profile is kept as the
NAF-keyed alternative and pays for its root with four transposed pipes.

**Melody engine** (`melody.py`, rewritten): a `Phrasing` object carries a 3–5
note motif across breaths and transforms it (sequence, inversion, retrograde,
augmentation, diminution, fragmentation). Breaths alternate call and answer, and
**the answer always quotes the call**. Rhythm is a grid the breath supplies —
whole pulses of ~0.36 s — not a global tempo. Pitch follows one arch peaking at
0.68. The walk *reflects* off the ends of the range; clamping made lines stick.

**GUI** (`web/`, SPEC §10): stdlib `ThreadingHTTPServer`, polled at 4 Hz, one
static page, 12 sliders. All eight §10.12 criteria measured (RESEARCH.md §9) —
tightest was 0.30 ms breath drift over 10 minutes against a 5 ms budget.
Colour carries state only: amber = edited, green = sounding, red = panic.

**Not built, not claimed:** replay from seed + session log (the log is written,
nothing reads it); Mode and Pulse controls (the engine has no scale or pulse
model); GrandOrgue's own Panic via MIDI.

**Verification is measurement.** Two gates: `tools/loop_qa.py` (8/13 loops pass;
the profile knowingly uses one that does not) and `cli.py check` (MIDI side).
An ODF change is unverified until GrandOrgue has actually loaded it.

## Next Step

Todo #1 — the Submit/Revert bug. It is the one thing actively broken in
something already shipped, and it blocks using the GUI for #2 and #3. Start by
reproducing with a real pointer (not synthetic events) and logging what
`anyDirty()` sees.

/home/menser/Dropbox/ai/code/drone_flute_synth
