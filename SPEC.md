# Drone Flute Simulator — Specification (v0.5)

A Linux app that plays an endless, non-repeating performance on a **simulated
drone flute** — a multi-chambered flute where one chamber holds a sustained root
while another plays melody on the same breath. Sound comes from **GrandOrgue**
playing a purpose-built sample set; the app is the *player*, not the synth.

**Fixed scope:** flutes only (no ocarinas). No physical instruments to record —
samples and tunings come from freely-licensed online sources. Vibrato out of
scope for the prototype. Live playback only; no file rendering.

**Status:** §6 reports measured results from spikes run against real sample data
using the tools in `tools/` (see `RESEARCH.md` for the full log). §2 contains
unverified figures, flagged. Everything else is design.

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
Native MIDI pitch-bend handling appears absent — community reports say a bend
wheel sends something GrandOrgue won't accept and needs remapping
([Organ Forum](https://organforum.com/forums/forum/organ-building-repair-restoration/virtual-organs/762454-expression-not-working-in-grandorgue);
forum-level, spike S2).

So: no vibrato, no breath-bends, no half-holing, no glissandi. **Accepted for the
prototype.** Pitch is fixed per pipe at design time — which §2 turns from a
limitation into the point.

If vibrato later becomes essential, the MIDI seam (§4) is the escape hatch:
`sfizz`/SFZ has real pitch bend and CC crossfades. Don't build that abstraction
now — a clean MIDI boundary is abstraction enough.

---

## 2. The intonation argument (why this isn't just a sampler patch)

A Native American–style flute is **not in equal temperament, and not by
accident.** Step sizes come from tube acoustics and finger-hole placement, not
arithmetic. Reported measurements put the first step (minor third) at roughly
**280–330 cents** against 12-TET's 300; whole-tone steps at **185–220 cents**
straddling the just 204; and the octave itself measuring **1150–1250 cents**,
not 1200.

> **Provenance flag — read before relying on these numbers.** They come from a
> search-engine summary of [flutetree.org](https://www.flutetree.org/nature/MythPentatonic.html),
> which is **blocked by this environment's egress proxy** — I could not read the
> page. Same for [Flutopedia](https://www.flutopedia.com/) (Clint Goss), the
> standard reference, which cites systematic measurements by Richard Payne. The
> *shape* of the claim — NAF tuning departs materially from 12-TET — is
> corroborated across independent maker and teaching sources
> ([Prana](https://www.pranaflutes.com/professional-tuning/),
> [ATFlutes](https://atflutes.com/information/learning/native-american-style-flute-tuning)).
> **Treat the specific cents values as unverified.** Spike S1.

If the stretched octave is real it matters enormously: a conventional sampler
pitch-shifting one recording across a range **cannot represent an instrument
whose octave isn't 2:1**. GrandOrgue can, exactly, because every pipe is an
independent sample with its own `PitchTuning`. That is the strongest technical
reason to use it here, and the §1 constraint doesn't touch it.

**Design consequence:** the profile's cents table is the primary artifact. Right
table with a mediocre sample still sounds like the instrument; wrong table with a
perfect sample sounds like a MIDI flute.

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

---

## 4. ODF mapping

Per chamber: a **Rank** containing *only the notes that chamber can physically
sound* — a droneless chamber is one pipe; a 6-hole melody chamber is 8–13 pipes,
not 61 — on its own **Windchest**, exposed as a **Stop**, with per-pipe
`PitchTuning` carrying the §2 cents table, plus an **Enclosure** for dynamics.
The app cannot play what the instrument can't.

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
FirstAccessibleKeyMIDINoteNumber=57      ; A3
NumberOfAccessibleKeys=16

[Rank001]                                 ; DRONE chamber — one pipe
NumberOfLogicalPipes=1
WindchestGroup=1
Pipe001=drone/A3_loop.wav
Pipe001PitchTuning=-14                    ; cents, from the profile
Pipe001LoopCrossfadeLength=20

[Rank002]                                 ; MELODY chamber — only playable notes
NumberOfLogicalPipes=8
WindchestGroup=2
Pipe001=melody/A3.wav
Pipe001PitchTuning=0
Pipe002=melody/C4.wav
Pipe002PitchTuning=+12
; ... one entry per physically available note
```

> **Verify attribute spelling against the ODF reference before coding** — this
> block is structurally right but the exact key names are from secondary
> sources. `ODFedit` and `GOODF` exist as working references. Spike S3.

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

**Breath layers.** Each chamber ships as parallel Ranks (`soft`, `normal`,
`pushed`) at different breath pressures, each with its own timbre *and its own
tuning offsets*, so pushing sharpens both chambers **together** — real coupled
behaviour, coarsely quantised. The driver switches Stops between notes;
Enclosure/CC 11 gives continuous level *within* a layer. Layer switches are only
clean at note boundaries; the generator must respect that. (Whether GrandOrgue
honours velocity for per-note selection is unverified — spike S4. If it does,
layering gets much cheaper.)

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

This is the single biggest schedule item and now has a tool behind it.

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
- intonation: equal / just / **profile cents table** (default) — **build-time**
- harmony-chamber interval on triples: root+5th / +4th / +3rd

Concert reference and intonation are baked into per-pipe `PitchTuning` in the
generated ODF (§4), and §3 forbids making GrandOrgue reload one. They are chosen
at launch and fixed for the session; §10.2 has the split.

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

MIDI note numbers are assigned by the ODF generator and written into the profile's
generated manifest, so app and ODF never disagree about which key is which pipe.

---

## 10. Control surface and web GUI

A small local web page — sliders, pull-downs, radio buttons — over a headless
engine. The only feedback it gives is a per-control **spinner meaning "you
changed this, the performance hasn't picked it up yet"**, which stops when the
change takes effect. No meters, no note display, no visualisation.

### 10.1 Why so little feedback is the honest maximum

§3 makes GrandOrgue a **write-only device** — we cannot query what is sounding.
Any "now playing" display would be a display of our own intent dressed up as
observation. So the page shows committed parameter values and nothing else. The
pending spinner is the one piece of live state we genuinely own, because the
engine knows exactly when it consumed a change.

### 10.2 Runtime controls vs. build-time settings — a correction to §8

§8 lists concert reference and intonation among "controls". **They are not
runtime controls.** Both are baked into per-pipe `PitchTuning` in the generated
`.organ` (§4), and §3 means we cannot make GrandOrgue reload an organ. The same
applies to the instrument profile itself and to the set of playable notes.

Changing any of those requires: regenerate the ODF → the user reloads it in
GrandOrgue by hand → restart the app. That is a launch-time workflow, not a
slider.

**The GUI therefore exposes runtime controls only.** Build-time settings appear
as read-only facts about the loaded organ, with a line saying they are fixed for
this session. Choosing them stays in `cli.py` flags.

| Setting | Where it lives |
|---|---|
| profile, concert reference, intonation table, playable notes | launch-time; ODF-baked; read-only in the GUI |
| drone root, mode, harmony interval, breath, mood, level, run state | runtime; the GUI's job |

### 10.3 The seam

The engine is headless and authoritative; the GUI is one client of a
`Controller` with two operations:

```
apply(param, value) -> change_id      # queue a change; never applies it inline
snapshot()          -> dict           # committed values + pending change ids
```

`cli.py` drives the same `Controller`. The web server never touches the
scheduler thread, the MIDI port, or the panic path.

### 10.4 When a change counts as enacted

This definition is the whole spinner contract, so it is stated exactly:

> A change is **enacted** when the scheduler has begun a breath computed with the
> new value. Not when it was received, not when it was queued.

Mechanism: the engine holds `pending: {change_id: (param, value)}`. At the top of
each breath cycle (§5) it drains `pending` into the live parameter set. Draining
is the only place parameters change, which is what guarantees §5's rule that
layer switches land on note boundaries.

- A second change to the same parameter **replaces** the pending one. The
  superseded `change_id` simply leaves `pending`, so its spinner stops too. The
  page does not need to distinguish superseded from enacted.
- Two exceptions apply immediately, with **no spinner**, because queueing them
  for up to 14 s would be user-hostile: **master level** (CC 7) and **stop**.
- Worst-case spinner duration is one breath plus an inhale gap — up to ~15.6 s
  at the §5 clamps. The control's label says "applies at the next breath" so the
  wait reads as designed rather than hung.

### 10.5 Transport: polled HTTP, no websockets

Python's stdlib `http.server.ThreadingHTTPServer` on a daemon thread, serving
one static page. **No new dependencies** beyond the MIDI library.

The page polls `GET /state` every 250 ms. Polling rather than SSE or websockets
because the only thing being pushed is "is this id still pending", loopback
polling at 4 Hz costs nothing, and an SSE stream under `ThreadingHTTPServer`
pins one thread per open tab with reconnect logic to match. Nothing here needs
it.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/` | — | the single static page |
| `GET` | `/state` | — | `{run_id, seed, breath_index, committed{}, pending[], readonly{}}` |
| `POST` | `/set` | `{param, value}` | `{change_id}` — issued only after the engine has queued it |
| `POST` | `/stop` | — | `{ok}` — immediate; all-notes-off |
| `POST` | `/start` | — | `{ok}` — immediate |

Reconciliation rules for the page:

- A control that is focused or has a pending change is **not** overwritten by a
  poll. Everything else follows `/state`, so two open tabs converge within one
  poll interval.
- `run_id` is derived from the seed and start time. If it changes, the engine
  restarted: the page reloads rather than showing stale values.
- A failed poll marks the page disconnected and disables every control.

### 10.6 The controls

| Control | Widget | Values | Commit |
|---|---|---|---|
| Run | Start / Stop buttons | — | immediate |
| Master level | slider | 0–127 → CC 7 | immediate |
| Drone root | pull-down | drone chamber's available notes (§7) | next breath |
| Mode | pull-down | scales ∩ playable notes (§8) | next breath |
| Harmony interval | radio | 5th / 4th / 3rd — hidden unless the profile has a third chamber | next breath |
| Mood preset | pull-down | the six §8 presets, plus *Custom* | next breath |
| Mood weights | 8 sliders | ranges from the §8 table | next breath |
| Breath mean / spread / inhale | 3 sliders | 3–14 s / 0–5 s / 0.3–1.6 s | next breath |
| Pulse | radio off/on + BPM slider | off by default (§5) | next breath |
| Seed | read-only text + *Reseed* button | — | next breath |

Moving any mood weight switches the preset pull-down to *Custom*; choosing a
preset overwrites all eight sliders. Read-only block above the controls: profile
id, concert reference, intonation origin (`tuning_origin` from §7), ODF path.

### 10.7 Determinism — an amendment to §12 criterion 5

Byte-identical replay from a seed alone cannot survive a GUI that changes
parameters mid-run. Resolution: the engine appends every **enacted** change to a
JSONL session log as `{breath_index, param, value}`. Criterion 5 becomes:

> Two runs from the same seed **with no control changes** produce byte-identical
> MIDI; a run with control changes reproduces byte-identically from seed +
> session log.

The log is written whether or not the GUI is running, so a CLI-only run replays
by the same rule.

### 10.8 Binding and access

Default bind is `127.0.0.1:8737`. On loopback there is no authentication and
none is needed — any local user could open the MIDI port directly.

`--listen <addr>` for LAN access (a phone on the couch is a real use case for an
endless player) **requires** `--token`, checked on every request including
`/state`. Without the flag, no non-loopback interface is bound at all. The
threat is modest but not zero: an open port here lets a stranger start an
endless drone on someone's speakers.

### 10.9 What the GUI must never do

- **Own the lifecycle.** Closing the tab does not stop the performance. The
  engine is the process; the page is a window onto it.
- **Sit in the panic path.** All-notes-off on exit, signal, and crash stays
  engine-side (§3). A browser that never loads must not change failure
  behaviour.
- **Block the scheduler.** Server on its own thread, changes crossing by queue.
- **Claim knowledge of GrandOrgue's state** (§10.1). If the user moves a stop in
  GrandOrgue's own window, our display is wrong and cannot know it — the
  read-only block says so.

### 10.10 Acceptance criteria for the GUI

1. Moving a control shows its spinner within 250 ms, and the spinner clears
   within one poll interval of the change being drained.
2. Superseding a pending change clears the earlier spinner without leaking a
   `change_id` that never resolves.
3. Closing the browser mid-performance changes nothing audible; reopening it
   shows current values.
4. Killing the engine with the page open shows disconnected within 1 s and
   disables all controls.
5. Bound to loopback, no non-loopback interface accepts a connection. With
   `--listen`, a request without the token is refused.
6. Ten minutes of continuous polling with a page open shifts breath start times
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
  control.py      # Controller: apply()/snapshot(), pending queue, session log (§10.3)
  cli.py          # v0 entry point
  web/            # v1 GUI (§10)
    server.py     #   stdlib ThreadingHTTPServer: /state /set /start /stop, token auth
    static/       #   index.html, app.js, style.css — one page, no build step
```

No `tui.py`: one GUI, not two. The TUI's main advantage was costing only one
dependency, and §10.5 gets that to zero.

## 12. Acceptance criteria

**v0 is done when:**
1. A 10-minute continuous run produces no stuck notes and no MIDI buffer growth.
2. Killing the app (SIGINT and SIGKILL-then-restart) leaves no sounding drone.
3. Every generated loop passes `tools/loop_qa.py`: 60 s render envelope
   **CV < 0.02** and wrap discontinuity **< 3.0** (as a multiple of the loop's
   own typical sample-to-sample step). Currently 8/13 — see §6.
4. Measured output pitch of each pipe matches the profile's cents table within
   **±3 cents** (record GrandOrgue's output, run `dsp.detect_f0` seeded from the
   nominal note).
5. Two runs with the same seed **and no control changes** produce
   byte-identical MIDI streams; a run with control changes reproduces
   byte-identically from seed + session log (§10.7).
6. No two consecutive breaths are identical in note sequence.

## 13. Spikes, in order

| # | Spike | Decides |
|---|---|---|
| **S1** | **Read the tuning sources.** Flutopedia/flutetree are egress-blocked here; get Payne's measurements by hand. | §2 — and §2 is the project. Do it first. |
| S2 | Send pitch bend to GrandOrgue, observe. | Confirms or kills §1 |
| S3 | Hand-write a minimal ODF: one Rank, one pipe, one looped WAV, audible. | Verifies §4 attribute names; smallest proof of the sample path |
| S4 | Does a Rank respond to MIDI velocity? | Whether breath layers need Stop-switching |
| S5 | Run LoopAuditioneer batch over the 13 VCSL sustains; score with the QA gate. | Retires the §6 risk — or reopens it |

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
(live only). Live blown input — that's
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

1. **Does the stretched octave survive S1?** If NAF octaves really aren't 2:1,
   §2 is the headline feature. If they are, GrandOrgue is merely convenient
   rather than uniquely right, and the project is less interesting.
2. **Does a retuned recorder read as a drone flute?** Unknown until heard. The
   fallback is synthesis, which trades one wrongness for another.
3. **Do the European double flutes justify separate profiles**, or are dvojnice
   and kettősfurulya close enough to the NAF-double model to be presets of it?
   Answering needs the native-language sourcing in §15.
