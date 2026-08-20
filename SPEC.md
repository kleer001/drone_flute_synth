# Drone Flute Simulator — Specification (v0.6)

A Linux app that plays an endless, non-repeating performance on a **simulated
drone flute** — a multi-chambered flute where one chamber holds a sustained root
while another plays melody on the same breath. Sound comes from **GrandOrgue**
playing a purpose-built sample set; the app is the *player*, not the synth.

**Fixed scope:** flutes only (no ocarinas). No physical instruments to record —
samples and tunings come from freely-licensed online sources. Vibrato out of
scope for the prototype. Live playback only; no file rendering.

**Status:** all five spikes in §13 have been run; results are folded into the
sections they decided and recorded in full in `RESEARCH.md` §7. §2 was rewritten
as a result — its original figures did not survive. A v0 implementation exists
under `belvedere_drone/` and its generated ODF loads in GrandOrgue 3.17.3.

---

## 1. Why GrandOrgue, and the one thing it can't do

GrandOrgue is a GPL-2 sample-based pipe organ simulator (Linux/Win/macOS, on
RtMidi/RtAudio/wxWidgets) reading plain-text **Organ Definition Files**
(`.organ`) describing Organ → Manual / Windchest / Rank / Stop / Pipe /
Tremulant / Enclosure ([repo](https://github.com/GrandOrgue/grandorgue),
[ODF architecture PDF](https://sourceforge.net/p/ourorgan/wiki/Overview%20of%20architecture%20of%20an%20ODF/attachment/GOArchitectureForDesigningSamplesets.pdf)).

It hands us the hard parts:

| Need | GrandOrgue feature |
|---|---|
| A drone holding indefinitely, seamlessly | attack / **looped sustain** / release per pipe, with loop- and release-crossfade lengths |
| A believable note *ending* — breath cutoff, not a fade | release samples, optionally switched on hold duration |
| **Per-note tuning that isn't equal temperament** | per-pipe `PitchTuning` / `PitchCorrection` — see §2, this is the crux |
| Independent chambers sharing one air supply | one Windchest + Rank + Stop per chamber |
| Continuous level | Enclosure on MIDI CC 11 |
| Linux audio routing | JACK or ALSA |

**The constraint:** GrandOrgue tremulants are **amplitude-only**. Pitch-based
tremulant has been an open feature request since Sept 2021, milestone 3.18.0, no
implementation ([issue #709](https://github.com/GrandOrgue/grandorgue/issues/709)).
Native MIDI pitch bend is **absent, confirmed in the source** (spike S2):
`GOMidiEvent::MidiType` in GrandOrgue 3.17.3 enumerates note, aftertouch,
control change, program change, RPN, NRPN and SysEx, and has no pitch-bend
member at all — a bend message has no representation in the live MIDI path.
Status `0xE0` appears only in the MIDI *file* reader.

So: no vibrato, no breath-bends, no half-holing, no glissandi. **Accepted for the
prototype.** Pitch is fixed per pipe at design time — which §2 turns from a
limitation into the point.

If vibrato later becomes essential, the MIDI seam (§4) is the escape hatch:
`sfizz`/SFZ has real pitch bend and CC crossfades. Don't build that abstraction
now — a clean MIDI boundary is abstraction enough.

---

## 2. The intonation argument (why this isn't just a sampler patch)

**Revised after spike S1. The original version of this section claimed Native
American flutes have a stretched octave of 1150–1250 cents and named specific
step sizes. Those numbers could not be confirmed and the direction of the claim
is contradicted by the sources that do exist.** The full source-by-source
record is in RESEARCH.md §7; the short version:

- Flutopedia — the standard reference — gives NAF scale steps in **integer
  semitones**, not cents, and states no octave size.
- The acoustics paper Flutopedia hosts (Prairie 2006) uses 12-TET as its
  reference grid and treats octave deviation as a **defect to be engineered
  out**: a cylindrical flute plays its second register flat, and the maker's job
  is to correct it.
- Maker sources describe tuning in equal temperament, or offer **just
  intonation** as a deliberate alternative on request.
- The specific cents figures appear only in search-engine AI summaries, word
  for word across differently-worded queries, and on no primary page.

**So the octave is 2:1.** SPEC §18 question 1 asked what happens if it is, and
answered itself: "GrandOrgue is merely convenient rather than uniquely right,
and the project is less interesting." That is the honest outcome. GrandOrgue's
per-pipe `PitchTuning` is still the right mechanism — exact, one sample per
note, no resampling — but a 2:1-octave scale is also expressible as a
twelve-entry temperament, which many samplers support. The architecture does
not change; the *claim* does.

**What survives, and is worth building.** A drone flute has a real acoustic
reason to want non-equal intonation that a melody-only instrument does not:
every melody note sounds against a fixed, continuously-held root, so the
beating of a tempered third or seventh is exposed. Just intonation removes it.
That is a defensible, sourced, audible reason for a non-equal cents table —
[Southern Cross Flutes](https://www.southerncrossflutes.com/natural-tuning-vs-equal-temperament/)
tune drone flutes this way on request — and it is what the shipped profile uses,
recorded as `tuning_origin = "maker-spec"`.

A GrandOrgue temperament is twelve offsets indexed by pitch class
(`GOTemperamentCent::m_Tuning[12]`), so it is octave-periodic by construction
and could not express a stretched octave even if one turned up later. Per-pipe
`PitchTuning` can. That is why the cents table lives in the ODF and not in a
temperament file, and it keeps the door open at zero cost.

**Design consequence, unchanged:** the profile's cents table is the primary
artifact. Right table with a mediocre sample still sounds like the instrument;
wrong table with a perfect sample sounds like a MIDI flute. What changed is
that the table must now say honestly where it came from, which §7 enforces.

---

## 3. Architecture

```
  belvedere-drone                 ALSA/JACK MIDI            GrandOrgue                JACK
  (our app, Python)      ─────────────────────────>    (running, GUI, user-      ─────────>  speakers
   profile + mood                note on/off, CC 11,     loaded organ) + our ODF
   → breath + notes              program/stop switching
```

We emit MIDI; GrandOrgue makes sound. Nothing links against GrandOrgue.

**Why out-of-process, deliberately:** GrandOrgue is a wxWidgets GUI application
with no embeddable engine API, and it is GPL-2 — linking would pull our app into
GPL-2. MIDI keeps licensing free and means a GrandOrgue upgrade can't break us.

**Because playback is live-only**, the app does not manage GrandOrgue's
lifecycle. GrandOrgue runs with its GUI, the user loads the organ once, our app
connects to its MIDI input port. No headless-autoload problem to solve.

**Consequence to accept:** we cannot query GrandOrgue's state. The app is the
sole authority on what is sounding, and must send all-notes-off on exit *and* on
crash (install a signal handler and an `atexit` hook — a stuck drone is the worst
possible failure mode of this app). Treat GrandOrgue as a write-only device.

Write-only is a statement about **reading**. GrandOrgue does change at runtime —
temperament, per-pipe voicing and reverb are all live in its own window — we
simply have no channel to drive them and no way to observe them. §10.1 has the
capability table and RESEARCH.md §8 the sources; both note that **Panic is
MIDI-assignable**, which gives the stuck-drone path a second, independent lever.

### Signal chain and reverb

```
  our app  --MIDI-->  GrandOrgue  --[built-in convolution reverb]-->  JACK  -->  speakers
```

Reverb is **not app code and not an extra process**: GrandOrgue ships a
convolution reverb (File → Settings → Reverb), built on Fons Adriaensen's
`zita-convolver` — the same engine an external `jconvolver` would use. Point it
at an impulse response and the room happens inside the process we are already
running.

Three things about it are load-bearing rather than cosmetic:

- **A dry sample set is the right input.** VCSL's close-recorded recorders (§6)
  suit convolution; a wet sample set would double the room.
- **Reverb length fights the breath model.** §5's whole argument is that the
  drone *stops* when the player inhales. A cathedral tail of 5–6 s fills the
  0.3–1.6 s inhale gap completely and erases the effect the breath model exists
  to produce. Start around **1.5–2.5 s** and tune it against `inhale_s` by ear;
  it is a parameter of the performance, not a preset to pick by taste.
- **It does not rescue a bad loop.** Envelope pulsing (§6) is amplitude
  modulation and survives convolution unchanged; the QA gate measures the dry
  loop, which is correct. Reverb masks nothing the gate cares about.

Settings are global rather than per-organ, and toggling reverb while notes sound
stops them on Linux — so it is configured once, before the performance, which is
exactly how §3 already treats GrandOrgue. If the built-in path disappoints, the
external options are `zita-rev1` (algorithmic, no IR licensing question at all)
and Dragonfly Reverb (LV2, four algorithms), both needing a plugin host and JACK
wiring in the launch script. RESEARCH.md §8 has the evidence and its gaps.

---

## 4. ODF mapping

Per chamber: a **Rank** on its own **Windchest**, exposed as a **Stop**, with
per-pipe `PitchTuning` carrying the §2 cents table, plus an **Enclosure** for
dynamics. Only the notes the chamber can physically sound have samples — a
droneless chamber has one; a 6-hole melody chamber has 8–13, not 61. The app
cannot play what the instrument can't.

**Keys are real MIDI note numbers, and retuning is on.** A pipe sits at the MIDI
number of the note it actually sounds, and unplayable numbers in between are
`DUMMY` pipes. The tempting alternative — packing pipes densely and treating the
key as a scale-degree index — costs more than it saves: it forces
`AcceptsRetuning=N`, because a stock temperament then implies retunes of well
over 1800 cents and GrandOrgue rejects every pipe. Real-note mapping keeps
implied retunes small, so `AcceptsRetuning=Y` holds and **GrandOrgue's own
temperament switching works on our organ** — which is what makes intonation a
live setting rather than a build-time one (§10.2).

The profile's cents table lives in `PitchTuning`, which GrandOrgue treats as the
organ's **original temperament**. That is the default and the interesting one.
Selecting any of GrandOrgue's stock temperaments swaps our table for theirs,
which has a consequence worth being blunt about:

> A GrandOrgue temperament is **twelve offsets per octave**, repeating. By
> construction it cannot express a stretched octave. If §2's non-2:1 octave
> survives, it lives in `PitchTuning` and **only in the original temperament** —
> switching to equal or just discards the very thing §2 argues is the point.
> That is fine, and it is what makes the comparison interesting: the switch is
> an A/B between the instrument's tuning and the arithmetic one.

Illustrative shape of a generated two-chamber `.organ` (line-oriented INI-style):

```ini
[Organ]
ChurchName=NAF-style double drone flute in A
NumberOfManuals=1
NumberOfWindchestGroups=2
NumberOfEnclosures=1
NumberOfStops=2

[Manual001]
NumberOfStops=2
Stop001=1
Stop002=2
FirstAccessibleKeyMIDINoteNumber=57      ; A3
NumberOfAccessibleKeys=16                ; A3..C5

[Rank001]                                 ; DRONE chamber — one pipe
NumberOfLogicalPipes=1
FirstMidiNoteNumber=57                    ; A3
WindchestGroup=1
AcceptsRetuning=Y
Pipe001=drone/A3_loop.wav
Pipe001PitchTuning=-14                    ; cents, from the profile
Pipe001LoopCrossfadeLength=20

[Rank002]                                 ; MELODY chamber — real note numbers,
NumberOfLogicalPipes=16                   ;   gaps filled with DUMMY
FirstMidiNoteNumber=57
WindchestGroup=2
AcceptsRetuning=Y
Pipe001=melody/A3.wav                     ; 57 A3
Pipe001PitchTuning=0
Pipe002=DUMMY                             ; 58 — the instrument has no A#3
Pipe003=DUMMY                             ; 59
Pipe004=melody/C4.wav                     ; 60 C4
Pipe004PitchTuning=+12
Pipe005=DUMMY                             ; 61
Pipe006=melody/D4.wav                     ; 62 D4
Pipe006PitchTuning=-6
; ... a sample where the instrument has a hole, DUMMY where it doesn't
```

> **Attribute names verified against the GrandOrgue 3.17.3 sources** (spike S3).
> The block above is structurally right but **not loadable as written**. What a
> real ODF also needs, and why, is in RESEARCH.md §7; the load-blocking items:
>
> - `[Organ]` requires four combination-store keys no tutorial mentions
>   (`DivisionalsStoreIntermanualCouplers` and three siblings).
> - `[Organ]` takes `NumberOfRanks`; the `NumberOfStops` shown above belongs in
>   `[Manual001]`, which must also *list* its stops (`Stop001=1`).
> - **28 `Disp*` display-metric keys are required** even with nothing displayed.
>
> `belvedere_drone/odfgen.py` emits all of this. It does **not** yet emit the
> real-note key mapping decided above: v0 packs pipes as scale-degree indices
> and is therefore pinned to `AcceptsRetuning=N`, which is where the ±1800-cent
> rejection was measured. Spec and code disagree here, and the spec is the
> authority — the generator has to move.

**No rank may hold fewer than two pipes.** A stop whose single rank has exactly
one pipe is an *effects* stop in GrandOrgue — `GOStop::IsForEffects` — and an
effects stop sounds whenever it is engaged, ignoring the manual entirely. A
droneless chamber has exactly one note, so the generator pads short ranks with a
`DUMMY` pipe. Skipping this makes the drone sound from the moment the organ
loads, with nothing in the MIDI vocabulary able to stop it (RESEARCH.md §7).

The app **generates the `.organ` from the profile** (§7). Nobody hand-maintains
ODFs.

---

## 5. Performance model: breath, not tempo

The signature of a real drone flute is that **melody and drone share one breath**.
The drone is not continuous — it stops when the player inhales. An app that
drones forever loses the instrument. The core loop is therefore a breath cycle:

```
loop:
    breath_len ~ N(mean, spread)          # e.g. 7.0 s ± 2.5, clamped [3, 14]
    layer      = choose_layer(mood)       # soft | normal | pushed
    note_on(drone_chamber, root, layer)
    if triple: note_on(harmony_chamber, interval, layer)
    schedule_melody(breath_len, mood)     # §8
    ... play ...
    all_notes_off()                       # ONE release = one breath ending
    sleep(inhale_gap ~ N(0.7, 0.2), clamped [0.3, 1.6])
```

Both chambers release on the same event, so GrandOrgue's release samples produce
the true simultaneous cutoff. Phrase length bounded by lung capacity is what
makes the pacing feel human rather than algorithmic.

Optional pulse/BPM quantisation exists but is **off by default** — free rhythm is
truer to these instruments.

**Breath layers.** Each chamber has `soft`, `normal` and `pushed` layers at
different breath pressures, each with its own timbre *and its own tuning
offsets*, so pushing sharpens both chambers **together** — real coupled
behaviour, coarsely quantised.

Spike S4 settled how to switch them, and the answer is cheaper than Stops.
GrandOrgue honours velocity two ways: `MinVelocityVolume`/`MaxVelocityVolume`
scale level continuously, and **`Attack###AttackVelocity` selects which attack
sample fires from the note-on velocity**. So a layer is a velocity band inside
one Rank, chosen per note by the note-on itself. The constraint that layer
switches are only clean at note boundaries was a consequence of Stop-switching
and does not apply. Enclosure/CC 11 still gives continuous level within a layer.

v0 sends the layer as note-on velocity and ships a single attack per pipe, so
the layers currently differ in level only; multi-attack ranks are a v2 item.

---

## 6. Sample pipeline — with measured results

**No GrandOrgue-format drone-flute sample set exists.** Playback is solved;
content is not. With no recording, the source is:

### Source: VCSL (CC0)

The [Versilian Community Sample Library](https://github.com/sgossner/VCSL) is
**CC0 — public domain**, professionally recorded, on GitHub. Under
`Aerophones/Edge-blown Aerophones` it ships Ball Whistle, four **Baroque
Recorders** (Soprano/Alto/Tenor/Bass), Ocarina Small, Ocarina Typical, and
others. **Recorders are duct flutes** — the same acoustic family as the NAF and
the dvojnice. CC0 means the derived ODF set redistributes with zero friction.

**What this honestly gets us:** correct *structure* and *intonation*, approximate
*voice*. A recorder retuned to a NAF cents table is a recorder playing NAF
tuning — right skeleton, wrong timbre. Given §2 that is the more important half.
Record it in `sample_note` and never imply otherwise.

### Measured: what the Soprano Recorder actually contains

Sparse-cloned and analysed (numpy/scipy, 13 sustain + 13 staccato files):

| Property | Measured |
|---|---|
| Format | 48 kHz, stereo, 13 sustain notes, 1 round-robin |
| Note coverage | C4 D4 E4 F♯4 G♯4 A♯4 C5 D5 E5 F♯5 G5 A♯5 C6 — **whole-tone spaced**, confirming VCSL's "usually wholetone" README claim. Semitones need pitch-fill. |
| Reproduce with | `python3 tools/analyze_samples.py <sustain_dir>` |
| Total duration | 9.0 – 14.5 s per note |
| **Usable steady state** | **4.5 – 10.6 s** — ample loop material |
| Pitch accuracy | **−0.6 to +6.2 cents** vs nominal (max abs 6.2) |

Pitch accuracy is good news: VCSL's fidelity claim holds, so our `PitchTuning`
offsets land on a trustworthy baseline.

### Measured: loop authoring, and what the numbers actually say

Spike ran **eight algorithm variants** to make a seamless drone loop from a
human-played recorder sustain. Two failure modes:

1. **Breath tremor.** The player's slow level wobble is baked into the sustain,
   so looping it pulses once per loop. Raw loops gave a 60-second render
   envelope **CV of 0.037–0.303** (30% level swing at worst — grossly audible).
2. **Wrap discontinuity** at the splice point.

**A measurement bug nearly hid the answer, and is worth stating because it
inverted the conclusion.** The first wrap metric normalised the splice step by
RMS *amplitude* — wrong, because adjacent samples of any waveform differ by its
slope, so even a perfect loop scores nonzero. Corrected to normalise by the
loop's own typical sample-to-sample step and validated against synthetic loops
(exact integer-period sine → 1.41; one with a 0.09-sample rounding error →
10.23), the picture changed:

- **Wrap is not the binding constraint.** All 13 loops score 0.08–4.5 against a
  threshold of 3.0. The crossfade works.
- **Envelope pulsing is.** It accounts for essentially every failure.

Flattening and crossfading do each partly undo the other, so whichever runs last
wins its metric — but since wrap has headroom and CV does not, flattening goes
**last**:

| Order | Notes passing both thresholds |
|---|---|
| flatten → crossfade last | 2 / 13 |
| **crossfade → flatten last** | **8 / 13** |
| flatten with linearly-detrended gain | 1 / 13 |

Current state of `tools/loopfind.py`: **8/13**, CV 0.004–0.026 (mostly ~0.006),
wrap 0.08–4.5. The five failures are four marginal wrap misses (3.0–4.5) and one
CV miss. Reproduce with `tools/loopfind.py` then `tools/loop_qa.py`.

Three bugs found en route, recorded in RESEARCH.md because they are easy to
repeat: an envelope window shorter than the pitch period flattens the waveform
instead of the breath; a naive crossfade breaks integer-period alignment,
jogging the pitch; and blind autocorrelation on a near-sinusoidal recorder gives
octave errors of ±1200 cents.

### Decision: don't hand-roll this

**[LoopAuditioneer](https://github.com/GrandOrgue/LoopAuditioneer)** — GPLv3, and
it lives in the **GrandOrgue GitHub organisation itself** — exists precisely for
"evaluating, creating and manipulating loops and cues and other properties of wav
file metadata … for sample production for virtual pipe organs like GrandOrgue."
It does crossfading in several modes, overlaid waveform inspection at the loop
points, and **batch processing**
([user guide](https://loopauditioneer.sourceforge.io/userguide.html)).

Loop points live in the **WAV file's own metadata**, which is what LoopAuditioneer
edits and what GrandOrgue reads — so looping is a build-time asset step, not app
code. Adopt it: batch-process the VCSL sustains, keep our analysis script only as
a **QA gate** (it already measures the right things — CV over a 60 s render and
wrap discontinuity), not as the loop generator.

**Reversed by spike S5.** LoopAuditioneer 0.13.0 has no command-line interface
— its batch processing is a GUI dialog — so it cannot be scripted into a build.
It is also not needed: GrandOrgue reads loop points from the WAV's own `smpl`
chunk (`GOWave::LoadSamplerChunk`), and `tools/loopfind.py` already writes that
chunk. LoopAuditioneer stays useful for auditioning a loop by ear and remains
the right tool for hand-inspection; the build path does not depend on it.

Loading the output in GrandOrgue then exposed two bugs in `loopfind.py` that no
amount of offline QA would have caught — loop points with no pre-roll for the
crossfade, which made **every pipe fail to load**, and a hardcoded
`dwMIDIUnityNote`. Both are fixed and recorded in RESEARCH.md §7.

### Fallback

Anything VCSL can't cover gets rendered from a physical model (STK waveguide
flute, or Faust) as attack + sustain-loop + release. Infinitely loopable and
exactly tunable, but audibly synthetic. Mark `sample_source = "synthesized"`.

---

## 7. Instrument profile format

One TOML per instrument beside its sample set. Provenance is first-class: a
guessed tuning must never masquerade as a sourced one.

```toml
id            = "naf-double-drone-a-440"
display       = "Native American–style double drone flute, key of A"
family        = "naf-double"
concert_a_hz  = 440.0

# Honesty gates. No "measured" — we measure nothing.
tuning_origin = "estimate"          # published | maker-spec | estimate
tuning_source = ""                  # citation for the cents table
sample_source = "vcsl-cc0"          # vcsl-cc0 | synthesized | other-licensed
sample_note   = "Baroque soprano recorder, retuned per pipe; timbre is a proxy."

[chambers.drone]
holes = 0
notes = ["A3"]

[chambers.melody]
holes = 6
notes = ["A3","C4","D4","E4","G4","A4","B4","C5"]
# Deviation from 12-TET per §2. THE primary artifact of this file.
cents = { A3 = 0, C4 = +12, D4 = -6, E4 = +2, G4 = -9, A4 = -14 }

[breath]
mean_s = 7.0
spread_s = 2.5
inhale_s = 0.7

[odf]
path = "naf-double-drone-a/naf-double-drone-a.organ"
```

---

## 8. Controls and the melody generator

### Tonality
- drone root, constrained to the drone chamber's available notes
- concert reference: 440 / 432 / instrument's own — **build-time**, see §10.2
- mode: the **intersection** of requested scale and the melody chamber's physical
  notes — we never offer a note the instrument can't make
- intonation: **profile cents table** (default) / equal / just — **live**, but
  switched in GrandOrgue's window rather than ours (§10.2)
- harmony-chamber interval on triples: root+5th / +4th / +3rd

### Tempo (breath)
breath length mean + spread; notes per breath; inhale gap mean + spread; optional
pulse, default off.

### Feeling
A named macro over a weights table — not a model. Presets: **Contemplative,
Mourning, Pastoral, Ceremonial, Restless, Sleep**.

| Parameter | Range | Contemplative | Restless | Sleep |
|---|---|---|---|---|
| notes per breath | 1–14 | 4 | 11 | 2 |
| step:leap ratio | 0–1 | 0.80 | 0.45 | 0.92 |
| ornament rate | 0–1 | 0.10 | 0.40 | 0.02 |
| cadence strength | 0–1 | 0.70 | 0.25 | 0.90 |
| register bias | −1..+1 | 0.0 | +0.4 | −0.3 |
| dynamic sweep depth | 0–1 | 0.25 | 0.55 | 0.15 |
| `pushed` layer bias | 0–1 | 0.15 | 0.60 | 0.02 |
| breath mean (s) | 3–14 | 8.0 | 5.0 | 11.0 |

*(Numbers are a starting point to tune by ear, not derived values.)*

### Melody algorithm

A constrained weighted random walk over the chamber's playable notes —
deliberately legible and hand-tunable:

```
schedule_melody(breath_len, mood):
    n     = round(mood.notes_per_breath * jitter(0.85, 1.15))
    times = sorted(n draws from Beta(a,b) scaled to breath_len)
            # Beta shapes the phrase: (2,4) front-loaded, (4,2) back-loaded,
            # (3,3) arch. Mood picks the shape.
    cur   = weighted_choice(available, bias=mood.register_bias)
    for i, t in enumerate(times):
        if random() < mood.step_leap_ratio:
            cur = neighbour(cur, available)          # adjacent in the scale
        else:
            cur = weighted_leap(cur, available)      # 3rd/4th/5th, weighted down
        if random() < mood.ornament_rate:
            emit_grace(cur, t)                       # ~60 ms neighbour before
        emit(cur, t, dur=next_t - t)
    # cadence: land the last note on the drone root
    if random() < mood.cadence_strength:
        force_last(root)
```

**Seeded and deterministic** — a good session reproduces from its seed alone,
which is all the reproducibility a live-only app needs. Print the seed on start.

---

## 9. MIDI mapping

One manual, one channel, chambers separated by Stop state.

| Message | Use |
|---|---|
| Note on/off, ch 1 | melody chamber notes |
| Note on/off, ch 1 (fixed key) | drone chamber root |
| CC 11 | Enclosure — continuous level within a breath |
| CC 7 | master level |
| Stop switching | select breath layer (`soft`/`normal`/`pushed`) |
| CC 120 / 123 | all-sound-off / all-notes-off — sent on exit, signal, and crash |
| GrandOrgue Panic | a MIDI event bound to GrandOrgue's own Panic, fired alongside CC 120/123 — resets its sound engine even if our note-offs were lost (§10.1) |

MIDI note numbers are assigned by the ODF generator and written into the profile's
generated manifest, so app and ODF never disagree about which key is which pipe.

---

## 10. Control surface and web GUI

A small local web page — sliders, pull-downs, radio buttons, and a **Submit**
button. Changes do not apply as you make them. You edit a working copy, submit
it, and the whole set lands together on the next breath boundary, with a
countdown saying when.

### 10.1 What GrandOrgue actually allows

§3 says GrandOrgue is a **write-only device**, which is true about *reading* its
state and was previously over-read as "nothing can change at runtime". Checked
against the documentation, the picture is more useful:

| Capability | Available at runtime? | Reachable from our app? |
|---|---|---|
| Notes, CC 11, CC 7, stop switching | yes | **yes** — MIDI (§9) |
| Panic (all sound off) | yes | **yes** — MIDI-assignable since 3.15.0 |
| Exit, Memory Set | yes | yes — MIDI-assignable |
| Temperament switching | yes — "samples are retuned on the fly when playing" | **no** — GUI only, not MIDI-bindable |
| Voicing: per-pipe amplitude, gain, tuning | yes — Organ Settings dialog, down to individual pipe | **no** — GUI only |
| Reload a regenerated ODF | yes — File → Reload | **no** — menu/keyboard only |
| Real-time pitch bend / MIDI Tuning Standard | no — declined upstream | no |

Two consequences worth stating plainly:

1. **Live retuning and revoicing exist, in GrandOrgue's own window.** We cannot
   drive them, but the user already has that window open (§3). Hand-voicing by
   ear is a legitimate workflow, not a workaround, and GrandOrgue's Save writes
   the fine-tuning data to disk — so numbers arrived at by ear can be copied
   back into the profile's cents table by hand, or read out of that file if it
   ever gets tedious.
2. **Panic is MIDI-assignable, so the panic path gets a second belt.** §3 calls
   a stuck drone the worst failure mode; our handler can now fire GrandOrgue's
   own Panic in addition to CC 120/123, which resets its sound engine even if
   our note-offs were lost.

Sources for this table are in RESEARCH.md §8.

### 10.2 Three tiers of setting

| Tier | Examples | How it changes |
|---|---|---|
| **Runtime, ours** | drone root, mode, harmony interval, breath, mood, level, run state | the GUI — submit, next breath |
| **Runtime, GrandOrgue's** | intonation (temperament), per-pipe voicing, reverb | the user, in GrandOrgue's window; live, and invisible to us |
| **Build-time** | concert reference, profile, which notes exist | regenerate the ODF, reload it in GrandOrgue, restart (§10.8) |

§8 lists intonation and concert reference together as "controls". They are not
the same kind of thing.

**Intonation is live.** Because §4 maps keys to real note numbers and leaves
`AcceptsRetuning=Y`, GrandOrgue's temperament selector works on our organ and
retunes the loaded samples on the fly. The profile's cents table is the original
temperament and the default; equal, just and the historical temperaments are one
menu away. This is the app's most interesting setting and it costs us no code at
all — the price is that it lives in GrandOrgue's window, because temperament is
not MIDI-bindable (§10.1). Our page names it in the read-only block and points
at GrandOrgue rather than pretending to own it.

**Concert reference is not.** 440 / 432 / the instrument's own pitch is baked
into `PitchTuning` when the ODF is generated. It is also the one place the two
runtime tiers collide: switching to a non-original temperament is reported to
retune the whole organ to a1 = 440 Hz, which would quietly undo a 432 profile.
Unconfirmed, and the shape of the answer doesn't change the design — a 432
instrument wants its own tuning anyway, which is the original temperament. If
you are running 432, stay on Original.

### 10.3 The seam

The engine is headless and authoritative; the GUI is one client of a
`Controller`:

```
stage(changes: dict) -> None            # edit the working copy; nothing sounds different
submit()             -> submission_id   # validate the whole set, queue it atomically
snapshot()           -> dict            # committed values, working copy, in-flight id, eta
```

`cli.py` drives the same `Controller`. The web server never touches the
scheduler thread, the MIDI port, or the panic path.

### 10.4 The submit model

**Why a button and not live controls.** Not politeness about latency — a
correctness requirement. Under per-control commits, changing mode and then root
lets one breath run with a root that is not in the new mode. Submitting a set
makes the change atomic: root, mode and mood land on the same breath or none of
them do.

Three states per control:

| State | Meaning | Shown as |
|---|---|---|
| **committed** | what the performance is using | normal |
| **dirty** | edited here, not submitted | marked, with a global *Revert* |
| **in-flight** | submitted, waiting for the next breath | locked, with the countdown |

- **Validation happens at submit**, server-side, over the whole set — which is
  where §8's "we never offer a note the instrument can't make" finally has a
  home. A root outside the mode's intersection is rejected, nothing applies, and
  the page says which field failed. Per-control commits had nowhere to put a
  cross-field rule.
- **One `submission_id` per submit.** No per-control ids, and no superseding
  rule to specify: a set is in flight or it isn't.
- **Two exceptions bypass Submit entirely** — **master level** (CC 7) and
  **Start/Stop**. They live in a separate transport strip that is visibly live,
  so nobody hunts for a Submit button for the volume slider.
- While a set is in flight the form is locked. A second submit is refused rather
  than queued; there is at most one pending set.

### 10.5 The countdown

The wait is **exact, not estimated**. The engine drew this breath's length and
the inhale gap from their distributions (§5) and knows when the breath started,
so seconds-to-next-drain is arithmetic. `/state` carries `next_drain_in`; the
page ticks locally and resyncs on each poll.

> **Applies in 11 s** — then 10, 9, …

Telling the user it will be a while is fine; pretending it is instant is not.
Two rules:

- If the countdown reaches zero and the set has not drained, **switch to an
  indeterminate spinner**. That is the honest display when the truth is harder
  to find than expected, and it should be rare enough to be worth logging.
- Worst case is one breath plus an inhale gap — ~15.6 s at the §5 clamps.

### 10.6 Transport: polled HTTP

Python's stdlib `http.server.ThreadingHTTPServer` on a daemon thread, serving
one static page. **No new dependencies** beyond the MIDI library.

The page polls `GET /state` every 250 ms. Polling rather than SSE or websockets:
the only live values are a countdown and an in-flight flag, loopback polling at
4 Hz costs nothing, and an SSE stream under `ThreadingHTTPServer` pins a thread
per open tab with reconnect logic to match.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/` | — | the single static page |
| `GET` | `/state` | — | `{run_id, seed, breath_index, committed{}, in_flight, next_drain_in, readonly{}}` |
| `POST` | `/submit` | full parameter set | `{submission_id}` or `{errors: {field: reason}}` |
| `POST` | `/level` | `{value}` | `{ok}` — immediate, no submit |
| `POST` | `/stop`, `/start` | — | `{ok}` — immediate |
| `POST` | `/regenerate` | — | `{odf_path, reload_required: true}` (§10.8) |

Reconciliation, now that the page holds a working copy:

- Polls update the **committed baseline only**. A dirty field is never
  overwritten by a poll.
- If another tab submits while this one is dirty, the page shows *"settings
  changed underneath you"* with a choice: keep editing, or discard and reload
  the new baseline. Last submit wins; we do not merge.
- `run_id` changing means the engine restarted — the page reloads rather than
  showing stale values. A failed poll marks it disconnected and disables
  everything.

### 10.7 The controls

Transport strip — live, no Submit:

| Control | Widget | Values |
|---|---|---|
| Run | Start / Stop | — |
| Master level | slider | 0–127 → CC 7 |
| Panic | button | CC 120/123 + GrandOrgue's own Panic (§10.1) |

Submit-gated panel:

| Control | Widget | Values |
|---|---|---|
| Drone root | pull-down | drone chamber's available notes (§7) |
| Mode | pull-down | scales ∩ playable notes (§8) |
| Harmony interval | radio | 5th / 4th / 3rd — hidden unless the profile has a third chamber |
| Mood preset | pull-down | the six §8 presets, plus *Custom* |
| Mood weights | 8 sliders | ranges from the §8 table |
| Breath mean / spread / inhale | 3 sliders | 3–14 s / 0–5 s / 0.3–1.6 s |
| Pulse | radio off/on + BPM slider | off by default (§5) |
| Seed | text + *Reseed* | — |

Moving any mood weight switches the preset pull-down to *Custom*; choosing a
preset overwrites all eight sliders. Both are working-copy edits — nothing
sounds different until Submit.

Read-only block: profile id, concert reference, `tuning_origin` (§7), ODF path,
and a line saying that **intonation, voicing and reverb are switched in
GrandOrgue's window** — live, but ours to name rather than to drive, so whatever
this page last knew about them may be wrong.

### 10.8 Regenerate and reload

Build-time settings get an explicit, honest two-step. `POST /regenerate` writes
a new `.organ` from the current profile and returns the path; the page then says:

> **Regenerated ODF written.** Press **File → Reload** in GrandOrgue, then restart
> the player. Sound stops while the sample set loads, and the drone will break.

We cannot press it for them (§10.1). Reload is a between-performances action,
never a control, and the page must say so rather than implying a seamless
switch.

### 10.9 Determinism — an amendment to §12 criterion 5

Byte-identical replay from a seed alone cannot survive a GUI that changes
parameters mid-run. The engine appends every **applied submission** to a JSONL
session log as `{breath_index, submission_id, params{}}` — one entry per set,
not per field. Criterion 5 becomes:

> Two runs from the same seed **with no submissions** produce byte-identical
> MIDI; a run with submissions reproduces byte-identically from seed + session
> log.

The log is written whether or not the GUI is running, so a CLI-only run replays
by the same rule.

### 10.10 Binding and access

Default bind is `127.0.0.1:8737`. On loopback there is no authentication and
none is needed — any local user could open the MIDI port directly.

`--listen <addr>` for LAN access (a phone on the couch is a real use case for an
endless player) **requires** `--token`, checked on every request including
`/state`. Without the flag, no non-loopback interface is bound at all. The
threat is modest but not zero: an open port here lets a stranger start an
endless drone on someone's speakers.

### 10.11 What the GUI must never do

- **Own the lifecycle.** Closing the tab does not stop the performance.
- **Sit in the panic path.** All-notes-off on exit, signal, and crash stays
  engine-side (§3). A browser that never loads must not change failure
  behaviour.
- **Block the scheduler.** Server on its own thread, submissions crossing by
  queue.
- **Claim knowledge of GrandOrgue's state.** If the user switches temperament or
  revoices a pipe in GrandOrgue's window, our display is wrong and cannot know
  it. The read-only block says so.

### 10.12 Acceptance criteria for the GUI

1. Editing a control marks it dirty and changes nothing audible; Revert restores
   the committed values.
2. A submitted set applies entirely on one breath boundary, or not at all — no
   breath ever runs with a partially applied set.
3. A submission whose root is outside the selected mode is refused with a
   named field, and nothing is applied.
4. The countdown reaches zero within 250 ms of the set actually draining; if it
   reaches zero first, the spinner appears.
5. Closing the browser mid-performance changes nothing audible; reopening shows
   current values.
6. Killing the engine with the page open shows disconnected within 1 s and
   disables all controls.
7. Bound to loopback, no non-loopback interface accepts a connection. With
   `--listen`, a request without the token is refused.
8. Ten minutes of continuous polling with a page open shifts breath start times
   by **< 5 ms** against a headless run of the same seed.

---

## 11. Module layout

```
belvedere_drone/
  profile.py      # load/validate TOML; enforce provenance fields
  odfgen.py       # profile -> .organ + sample manifest
  samples.py      # VCSL fetch, pitch-fill, LoopAuditioneer batch invocation
  # build-time tools already written and validated, in tools/:
  #   dsp.py, analyze_samples.py, loop_qa.py, loopfind.py
  breath.py       # breath cycle scheduler (§5)
  melody.py       # weighted walk + phrase shaping (§8)
  moods.py        # the weights table
  midi_out.py     # ALSA/JACK port, panic handler
  control.py      # Controller: stage()/submit()/snapshot(), session log (§10.3)
  cli.py          # v0 entry point
  web/            # v1 GUI (§10)
    server.py     #   stdlib ThreadingHTTPServer: /state /submit /level /start /stop
                  #   /regenerate, token auth
    static/       #   index.html, app.js, style.css — one page, no build step
```

No `tui.py`: one GUI, not two. The TUI's main advantage was costing only one
dependency, and §10.5 gets that to zero.

## 12. Acceptance criteria

**v0 is done when:**

| # | Criterion | Status |
|---|---|---|
| 1 | A 10-minute continuous run produces no stuck notes and no MIDI buffer growth. | **Pass** — `cli.py check` runs 60 breaths and asserts note-ons balance note-offs and nothing is left sounding. |
| 2 | Killing the app (SIGINT and SIGKILL-then-restart) leaves no sounding drone. | **Partial** — the panic path (CC 123 + CC 120, signal handler, `atexit`) is asserted by `check`. SIGKILL cannot be caught by anything; recovery there depends on GrandOrgue, and is untested. |
| 3 | Every generated loop passes `tools/loop_qa.py`: 60 s render envelope **CV < 0.02** and wrap discontinuity **< 3.0**. | **8/13** — unchanged; the S5 fixes moved metadata, not audio. The shipped profile uses one failing loop (F#5, wrap 4.5). |
| 4 | Measured output pitch of each pipe matches the profile's cents table within **±3 cents** (record GrandOrgue's output, run `dsp.detect_f0` seeded from the nominal note). | **Not verified.** Needs GrandOrgue's audio output recorded, which needs a real audio device — it cannot be done from a headless session. |
| 5 | Two runs with the same seed **and no submissions** produce byte-identical MIDI streams; a run with submissions reproduces byte-identically from seed + session log (§10.9). | **Pass** for the no-submission half — and a different seed is asserted to differ. The submission half is **not met**: the engine writes the session log on every applied set, but nothing reads it back, so a run with submissions has no replay path. |
| 6 | No two consecutive breaths are identical in note sequence. | **Pass** over 60 breaths. |

Run criteria 1, 2, 5 and 6 with:

```bash
python3 -m belvedere_drone.cli check profiles/naf-double-drone-as.toml --out-dir build
```

## 13. Spikes, in order

All five are **done**. Full record in RESEARCH.md §7.

| # | Spike | Outcome |
|---|---|---|
| S1 | Read the tuning sources. | **Negative.** The stretched octave is unsupported and the cited figures trace to search-engine summaries, not sources. §2 rewritten; the profile ships just intonation instead, sourced to a maker. |
| S2 | Send pitch bend to GrandOrgue, observe. | **Confirms §1**, and from the source rather than a forum: `GOMidiEvent::MidiType` has no pitch-bend member. |
| S3 | Hand-write a minimal ODF. | **Loads**, after five corrections to §4. The generator in `odfgen.py` produces a clean load in GrandOrgue 3.17.3. |
| S4 | Does a Rank respond to MIDI velocity? | **Yes**, two ways. Breath layers do not need Stop-switching; see §5. |
| S5 | LoopAuditioneer batch over the 13 VCSL sustains. | **Tool rejected** — GUI-only, unscriptable, and unnecessary since `loopfind.py` already writes the `smpl` chunk GrandOrgue reads. Loading the result exposed two real bugs. |

## 14. Phasing

- **v0** — one profile (VCSL soprano recorder retuned), one mood, breath loop,
  drone + melody, JACK out, CLI. Proves the MIDI→GrandOrgue seam and the breath
  model.
- **v1** — ODF generator from profiles, the three solid profiles (§15), 6 moods,
  web GUI (§10), seeded determinism.
- **v2** — sourced cents tables replacing estimates, remaining profiles, breath
  layers.

## 15. Library — flutes, graded by evidence

| Profile | Configuration | Evidence |
|---|---|---|
| NAF-style **double** drone flute | melody chamber 6 holes; drone chamber holeless, fixed root | Solid — documented by current makers ([Singing Tree](https://singingtreeflutes.com/pages/about-our-flutes), [Southern Cross](https://www.southerncrossflutes.com/native-american-flutes-shop/drone-flutes/)). A modern maker tradition, not a historical one — label it so. |
| NAF-style **triple** | centre 6-hole melody; holeless root; third chamber 3 holes → 3rd/4th/5th | Solid ([Elemental triple](https://www.horizonsflutestore.com/products/elemental-flutes-triple-drones)) |
| **Dvojnice** (Croatia / Serbia / Bosnia) | two parallel bores in one block, end-blown duct; drone + melody, reported 3 and 4 holes | Moderate — English coverage is derivative; wants Croatian/Serbian or ethnomusicological sourcing |
| **Kettősfurulya** (Transylvania / E. Hungary) | joined pair; one melody, one harmonic tone | Moderate — wants Hungarian-language sources |
| **Fujara** (central Slovakia) | contrabass overtone fipple flute, 3 holes, tabor-pipe class | Instrument solid; **drone pairing not** — popular pages describe a "bass drone + secondary drone + melodic pipe" build I could not confirm credibly. Verify before profiling. |

Ocarinas are **deferred** — out of scope, and the multi-chamber ones I found
extend *range* rather than drone. VCSL's CC0 ocarinas wait for whenever that
changes.

## 16. Non-goals

Recording real instruments. Vibrato, bends, half-holing. File rendering or export
(live only). Writing any audio effect: reverb is GrandOrgue's built-in
convolution (§3), configured by the user, never a signal path of ours. Live blown input — that's
[Smule's Ocarina](https://en.wikipedia.org/wiki/Ocarina_(app)), a different app.
Ocarinas. Any claim of ethnographic authenticity beyond what `tuning_origin`
records.

## 17. Prior art

Drone generators are plentiful and all synth-based, melody-free:
[chromatone/drone](https://github.com/chromatone/drone) (tanpura/shruti),
[myNoise's virtual shruti box](https://mynoise.net/NoiseMachines/shrutiBoxDroneGenerator.php),
[Diffusia](https://synthanatomy.com/2025/11/full-fx-media-diffusia-free-drone-synthesizer-plugin-for-macos-linux-and-windows.html)
(free, Linux, 6-voice drone synth), [Drone Quest](https://bark-instruments.itch.io/drone-quest).
Generative-ambient players like [Generative.fm](https://generative.fm/) do endless
composition but no instrument modelling.

Nothing found combines a **real-instrument drone-flute library at correct
non-equal intonation** with a **breath-phrased generative melody** on Linux. The
neighbours are drone-without-melody or melody-without-instrument.

## 18. Open questions

1. ~~**Does the stretched octave survive S1?**~~ **Answered: no.** See §2. The
   headline feature is gone; what remains is a sourced just-intonation drone
   flute, which is a smaller but honest claim. The interesting question it
   leaves behind: *is just intonation audibly better under a sustained drone
   than 12-TET?* That one can be settled by ear, with A/B profiles, once
   criterion 4 is verifiable.
2. **Does a retuned recorder read as a drone flute?** Unknown until heard. The
   fallback is synthesis, which trades one wrongness for another.
3. **Do the European double flutes justify separate profiles**, or are dvojnice
   and kettősfurulya close enough to the NAF-double model to be presets of it?
   Answering needs the native-language sourcing in §15.
