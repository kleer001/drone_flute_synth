# Research notes

What was checked, what was measured, and what remains unverified. Findings that
shaped the design live in [`SPEC.md`](SPEC.md); this file is the working record,
including the dead ends.

---

## 1. GrandOrgue capability

Verified from primary sources:

- Sample-based pipe organ simulator, GPL-2, Linux/Win/macOS, on RtMidi/RtAudio/
  wxWidgets ([repo](https://github.com/GrandOrgue/grandorgue)).
- Plain-text Organ Definition Files describe Organ → Manual / Windchest / Rank /
  Stop / Pipe / Tremulant / Enclosure, with attack / looped-sustain / release
  samples per pipe, per-pipe tuning and gain, and loop/release crossfade lengths
  ([ODF architecture PDF](https://sourceforge.net/p/ourorgan/wiki/Overview%20of%20architecture%20of%20an%20ODF/attachment/GOArchitectureForDesigningSamplesets.pdf)).

**The constraint.** Tremulants are amplitude-only. A pitch-based tremulant has
been an open feature request since Sept 2021, milestone 3.18.0, with no
implementation ([issue #709](https://github.com/GrandOrgue/grandorgue/issues/709)).
This is primary and solid.

Native MIDI pitch-bend handling appears absent — reports say a bend wheel sends
something GrandOrgue won't accept and must be remapped
([Organ Forum](https://organforum.com/forums/forum/organ-building-repair-restoration/virtual-organs/762454-expression-not-working-in-grandorgue)).
**Forum-level only; unverified.** Spike S2 in SPEC.md.

**Why this is survivable:** GrandOrgue's strength (seamless looped sustain with
exact per-pipe tuning) maps onto the hard part of a drone flute, and its weakness
(no continuous pitch) only costs the expressive gestures already descoped.

## 2. Intonation — the central design argument, and its weakest evidence

A Native American–style flute is not in equal temperament. Step sizes come from
tube acoustics and finger-hole placement. Reported: first step (minor third)
**280–330 cents** vs 12-TET's 300; whole tones **185–220 cents** vs just 204;
octave **1150–1250 cents** rather than 1200.

> **These figures are unverified.** They come from a search-engine summary of
> [flutetree.org](https://www.flutetree.org/nature/MythPentatonic.html), which is
> **blocked by this environment's egress proxy** — the page could not be read.
> Same for [Flutopedia](https://www.flutopedia.com/) (Clint Goss), the standard
> reference, which cites systematic measurements by Richard Payne. The *shape* of
> the claim is corroborated by independent maker/teaching sources
> ([Prana](https://www.pranaflutes.com/professional-tuning/),
> [ATFlutes](https://atflutes.com/information/learning/native-american-style-flute-tuning)),
> but no specific number here should be trusted until read at source.

If the stretched octave is real it is the whole argument for GrandOrgue: a
sampler pitch-shifting one recording across a range cannot represent an
instrument whose octave isn't 2:1, and per-pipe `PitchTuning` can. If it isn't
real, GrandOrgue is merely convenient. **Spike S1, ahead of any code.**

## 3. Sample source — VCSL

[VCSL](https://github.com/sgossner/VCSL) is CC0 (public domain), professionally
recorded, on GitHub. Under `Aerophones/Edge-blown Aerophones`: Ball Whistle, four
Baroque Recorders (Soprano/Alto/Tenor/Bass), Ocarina Small, Ocarina Typical,
Pipe Organ, Renaissance Organ, Train Whistle.

Recorders are **duct flutes** — the same acoustic family as the NAF and the
dvojnice. CC0 means the derived ODF set redistributes with no friction.

Honest limitation: a recorder retuned to a NAF cents table is a recorder playing
NAF tuning — right skeleton, wrong timbre. Correct structure and intonation,
approximate voice.

### Measured (Baroque Soprano Recorder, `tools/analyze_samples.py`)

| Property | Measured |
|---|---|
| Format | 48 kHz stereo, 13 sustain + 13 staccato, 1 round robin |
| Coverage | A♯4 A♯5 C4 C5 C6 D4 D5 E4 E5 F♯4 F♯5 G♯4 G5 — **whole-tone spaced**, confirming VCSL's "usually wholetone" README note. Semitones need pitch-fill. |
| Duration | 9.0 – 14.5 s per note |
| Usable steady state | **4.5 – 10.6 s** |
| Pitch accuracy | **−0.6 to +6.2 cents** vs nominal (max abs 6.2) |

Pitch accuracy is the good news: VCSL's fidelity claim holds, so our tuning
offsets sit on a trustworthy baseline.

## 4. Loop authoring — the experiment log

Making a human-played recorder sustain loop seamlessly forever. Eight variants.

### What goes wrong

1. **Breath tremor.** The player's slow level wobble is baked into the sustain;
   looping it pulses once per loop. Raw loops gave 60-second render envelope
   **CV 0.037–0.303** (30% level swing at worst — grossly audible).
2. **Wrap discontinuity** at the splice.

### Two bugs worth not repeating

- An RMS envelope window **shorter than the pitch period** tracks the waveform,
  not the breath — "flattening" then mangles the tone. Windows must span ≥ 4
  periods. Now enforced by `dsp.envelope_hop()`.
- A naive crossfade **breaks integer-period alignment**, jogging the pitch at the
  wrap. The fix is to take crossfade material from *outside* the loop bounds so
  its length is preserved exactly.
- Blind autocorrelation on a near-sinusoidal recorder gives octave errors of
  +1200 / −1200 / −2600 cents. Seed detection from the filename's nominal note.

### A measurement bug that nearly hid the answer

The first wrap metric was `|loop[0] − loop[-1]| / RMS_amplitude`. That is wrong:
adjacent samples of any waveform differ by its **slope**, so even a perfect loop
scores nonzero, and the metric mostly measured frequency. It made the crossfade
look destructive and produced a false conclusion — *"envelope flattening and
seam crossfading fight each other; best joint result 1/13."*

Corrected to normalise by the loop's own typical sample-to-sample step
(`|loop[0] − loop[-1]| / RMS(diff(loop))`), validated against synthetic loops:
an exactly-integer-period sine scores **1.41** (pass) and one with a 0.09-sample
period rounding error scores **10.23** (fail) — 7× separation.

Under the corrected metric the picture inverted: **wrap is not the constraint at
all** (all 13 loops score 0.08–4.5 against a threshold of 3.0), and **envelope
pulsing is**.

### Result

Ordering matters, because flattening and crossfading each partly undo the other
and whichever runs last wins its metric. Flattening goes **last**: the crossfade
touches ~12 ms while the breath envelope spans the whole loop.

| Order | Notes passing both |
|---|---|
| flatten → crossfade last | 2 / 13 |
| **crossfade → flatten last** | **8 / 13** |
| flatten with linearly-detrended gain | 1 / 13 |

The detrend attempt aimed to stop flattening from re-opening the wrap by forcing
`gain[0] == gain[-1]`. It degraded CV badly (0.004–0.026 → 0.016–0.234):
subtracting a ramp from a *multiplicative* gain distorts the correction.

### Measure the envelope around the loop, not across it

The remaining wrap failures were not in the crossfade. They were in the
flattening gain, and the cause is that the envelope was measured on the loop as
an open segment while the loop is *heard* as a circle.

Measured open, the envelope's two ends have no reason to agree, and across the
thirteen recordings they disagree by 0.07–0.82 in log gain — a level ratio of
up to 2.2:1. The gain curve inherits that difference as a step sitting exactly
on the seam, scaling the last sample and the first by different amounts. Low
notes pay most: their adjacent samples differ least, and wrap is measured in
units of the loop's own typical sample-to-sample step.

Two ways to close it, both measured over all thirteen:

| Flattening gain | Wrap range | CV range | Passing both |
|---|---|---|---|
| envelope measured open | 0.08–4.54 | 0.004–0.026 | 8 / 13 |
| open, then endpoint ramp removed in the log domain | 0.13–1.56 | 0.024–0.234 | 0 / 13 |
| **envelope measured circularly** | **0.10–1.29** | **0.005–0.020** | **12 / 13** |

Removing the ramp works on the metric it targets and fails overall, because the
ramp it removes *is* the breath trend: taking it out closes the seam by leaving
the pulsing uncorrected. Measuring circularly — wrapping the segment around
itself before the RMS envelope, then using the interior — closes the seam
without leaving anything behind, because the envelope is then periodic by
construction and no correction is needed.

Weighting the loop search to prefer endpoints at matching levels, so the ramp
would be small to begin with, changes nothing once the envelope is circular
(12/13 at every weight tried from 0 to 2) and is not in the tool.

Final state of `tools/loopfind.py`: **12/13**, CV 0.005–0.020, wrap 0.10–1.29.
The single failure is C4 on CV, at 0.0203 against a 0.02 threshold.

### Decision: use LoopAuditioneer

[LoopAuditioneer](https://github.com/GrandOrgue/LoopAuditioneer) is GPLv3 and
maintained **in the GrandOrgue organisation itself**, for "evaluating, creating
and manipulating loops and cues and other properties of wav file metadata … for
sample production for virtual pipe organs like GrandOrgue." It does crossfading
in several modes, overlaid waveform inspection at the loop points, and **batch
processing** ([user guide](https://loopauditioneer.sourceforge.io/userguide.html)).

Loop points live in the WAV's own `smpl` metadata — what LoopAuditioneer writes
and GrandOrgue reads — so looping is a build-time asset step, not app code.
`tools/loopfind.py` stays as a dependency-light reference; `tools/loop_qa.py`
stays as the gate on whatever produced the loops.

## 5. Prior art

Drone generators are plentiful and all synth-based, melody-free:
[chromatone/drone](https://github.com/chromatone/drone) (tanpura/shruti),
[myNoise virtual shruti box](https://mynoise.net/NoiseMachines/shrutiBoxDroneGenerator.php),
[Diffusia](https://synthanatomy.com/2025/11/full-fx-media-diffusia-free-drone-synthesizer-plugin-for-macos-linux-and-windows.html)
(free, Linux, 6-voice drone synth), [Drone Quest](https://bark-instruments.itch.io/drone-quest).
Generative-ambient players such as [Generative.fm](https://generative.fm/) do
endless composition but no instrument modelling.
[Smule's Ocarina](https://en.wikipedia.org/wiki/Ocarina_(app)) is blown input, a
different thing entirely.

Nothing found combines a real-instrument drone-flute library at correct
non-equal intonation with breath-phrased generative melody on Linux.

## 6. Instrument sourcing

Multi-chambered flutes where one pipe drones are a real and widespread family
([double flute](https://en.wikipedia.org/wiki/Double_flute)). Evidence grading
for each candidate profile is in SPEC.md §15. Summary of what needs work:

- **NAF-style double and triple** — well documented by current makers
  ([Singing Tree](https://singingtreeflutes.com/pages/about-our-flutes),
  [Southern Cross](https://www.southerncrossflutes.com/native-american-flutes-shop/drone-flutes/),
  [Elemental triple](https://www.horizonsflutestore.com/products/elemental-flutes-triple-drones)).
  A modern maker tradition, not a historical one — label it as such.
- **Dvojnice** (Croatia/Serbia/Bosnia) and **kettősfurulya** (Transylvania /
  E. Hungary) — real, but English coverage is derivative. Wants native-language
  or ethnomusicological sourcing before profiling.
- **Fujara** — the instrument is solid (contrabass overtone fipple flute, 3
  holes, tabor-pipe class), but popular pages describing a "bass drone +
  secondary drone + melodic pipe" construction could not be confirmed in a
  credible source. Verify before profiling.
- **Ocarinas** — deferred. The multi-chamber ones found extend *range*, not
  drone. VCSL's CC0 ocarinas are available whenever that changes.

---

## 7. Spike results (SPEC §13)

All five spikes were run against GrandOrgue **3.17.3-1** (upstream AppImage,
newer than Ubuntu noble's packaged 3.13.1) and the VCSL Baroque Soprano
Recorder. Where a claim below cites a source file, it was read in the
GrandOrgue tree at that version rather than taken from documentation — the
secondary documentation turned out to be incomplete in ways that matter.

### S1 — Read the tuning sources: **negative result, and it changes §2**

The cents values §2 was built on could not be confirmed, and the direction of
the claim is contradicted by the sources that do exist.

| Source | What it actually contains |
|---|---|
| [flutetree.org MythPentatonic](https://www.flutetree.org/nature/MythPentatonic.html) | Reachable. Discusses pentatonic/diatonic/chromatic tuning conceptually. **No cents values of any kind.** |
| [Flutopedia `naf_tunings.htm`](https://www.flutopedia.com/naf_tunings.htm) | Scale steps given in **integer semitones** (`3-2-2-3-2` for the minor pentatonic). No cents table, no measurement table, no Payne citation, no statement about octave size. |
| [Flutopedia `tuners.htm`](https://www.flutopedia.com/tuners.htm) | One cents figure only, and it is about temperature: 1.7 cents per °F. |
| [ATFlutes](https://atflutes.com/information/learning/native-american-style-flute-tuning) | Frames tuning in equal temperament outright: "In equal temperament there are one hundred cents between each adjacent note." |
| [Southern Cross Flutes](https://www.southerncrossflutes.com/natural-tuning-vs-equal-temperament/) | Offers **just intonation** ("Natural Tuning") as an option on request, contrasted against equal temperament. Publishes no cents values. A just octave is 2:1. |
| [Prairie 2006, *Understanding the Acoustics of the NAF*](https://www.flutopedia.com/refs/Prairie_2006_UnderstandingAcousticsOfTheNAF.pdf) | The acoustics reference Flutopedia hosts. Uses 12-TET and the MIDI scale as its reference grid throughout. Treats octave deviation as a **defect to engineer out**: "A simple cylindrical flute will not play overblown notes in tune with those of the first register, so some modifications must be made", and "why do the octave notes usually play flat in a cylindrical flute?" |

The triple 280–330 / 185–220 / 1150–1250 cents appears **only in search-engine
AI summaries**, returned verbatim and identically for two differently-worded
queries, and on none of the primary pages. It should not be treated as a
measurement from anywhere.

**Conclusion.** Makers aim at a 2:1 octave and fight the flat second octave;
they do not cultivate a stretched one. Nothing found supports a stretched
octave, so the profile shipped here does not assert one. The one non-equal
tuning for a drone flute that a maker states on the record is **just
intonation**, and a drone instrument has an acoustic reason to want it: every
melody note sounds against a fixed root, where beating is audible in a way it
is not on a melody-only instrument. That is what `profiles/` uses, with
`tuning_origin = "maker-spec"`.

**Consequence for the GrandOrgue argument.** Per-pipe tuning is still the right
mechanism, but it is no longer *uniquely* required — a 2:1-octave scale is
expressible as a twelve-entry temperament, which many samplers support. See §2
of SPEC.md as revised.

### S2 — Pitch bend: **confirmed absent, now from primary source**

`GOMidiEvent::MidiType` (`src/grandorgue/midi/events/GOMidiEvent.h`) enumerates
`MIDI_NOTE`, `MIDI_AFTERTOUCH`, `MIDI_CTRL_CHANGE`, `MIDI_PGM_CHANGE`,
`MIDI_RPN`, `MIDI_NRPN` and several SysEx variants. **There is no pitch-bend
member**, so a bend message has no representation in the live MIDI path at all.
Status `0xE0` appears in exactly one place in the tree,
`midi/files/GOMidiFileReader.cpp` — the MIDI *file* reader, not live input.

Tremulants are amplitude-only as claimed: `GOTremulant` reads `AmpModDepth`,
`Period`, `StartRate`, `StopRate` and nothing pitch-related.

This upgrades SPEC §1 from forum-level hearsay to verified.

### S3 — Minimal ODF: **loads, after five corrections**

SPEC §4's illustrative ODF is structurally right and **not loadable**. What it
takes, established by loading candidates in GrandOrgue under Xvfb and reading
the error each time:

1. Four combination-store keys are required in `[Organ]` and appear in no
   tutorial: `DivisionalsStoreIntermanualCouplers`,
   `DivisionalsStoreIntramanualCouplers`, `DivisionalsStoreTremulants`,
   `GeneralsStoreDivisionalCouplers`. Upstream's own
   `src/tests/testing/resources/minimal.organ` is the authority here.
2. `[Manual001]` must *list* its stops — `Stop001=1`, `Stop002=2` — as well as
   count them. `NumberOfStops` alone fails.
3. **28 `Disp*` keys are required** even with nothing displayed, because
   `GOGUIHW1DisplayMetrics` reads them all with `required=true`. Omitting one
   fails the load. `DispScreenSizeHoriz` accepts `SMALL`/`MEDIUM`/`MEDIUM
   LARGE`/`LARGE` or a pixel count; colours accept `BLACK` or `#RRGGBB`.
4. The built-in console reads its own element counts from `[Organ]`;
   `NumberOfLabels` is the only one not already covered by a model-level key.
5. `[Organ]` takes `NumberOfRanks`. `NumberOfStops` at organ level is the
   *panel's* count, not the model's — the model's lives in `[Manual001]`.

Attribute names from §4 that are correct as written: `PitchTuning`,
`PitchCorrection`, `LoopCrossfadeLength`, `ReleaseCrossfadeLength`,
`NumberOfLogicalPipes` (1–192), `WindchestGroup`, `Pipe%03d`.

**`AcceptsRetuning` must be `N`.** A chamber's MIDI keys are scale-degree
indices, not pitches, so the shift a stock temperament would apply is the
distance from the sample's recorded note to an unrelated key number.
`GOSoundingPipe::Validate` rejects any pipe whose hypothetical retune exceeds
1800 cents, and with keys based at 36 every pipe measured −1800 to −2400 cents
and was rejected. It is also correct musically: the profile's cents table is
the instrument's temperament.

### S4 — Velocity: **yes, and it makes breath layers much cheaper**

`GOSoundingPipe` supports two independent velocity mechanisms:

- `MinVelocityVolume` / `MaxVelocityVolume` (rank or pipe) — continuous
  velocity-to-volume scaling, via `GOSoundProvider::SetVelocityParameter`.
- `Attack###AttackVelocity` (0–127) — a per-attack-sample velocity threshold.
  `GOSoundingPipe` stores it as `min_attack_velocity` and selects which attack
  fires from the note-on velocity.

So a breath layer can be a velocity band inside one Rank rather than a Stop
change. SPEC §5's constraint that "layer switches are only clean at note
boundaries" is a consequence of Stop-switching and does not apply: with
velocity, the layer is chosen per note, by the note-on itself.

### S5 — Loop authoring: **LoopAuditioneer is GUI-only; not needed**

LoopAuditioneer 0.13.0 exposes batch processing as a dialog
(`BatchProcessDialog` in the binary) and no command-line interface — launching
it with `--help` opens a window. It cannot be scripted.

It also is not required. GrandOrgue reads loop points from the WAV's own `smpl`
chunk (`GOWave::LoadSamplerChunk`, `WAVE_TYPE_SAMPLE`), and `tools/loopfind.py`
already writes that chunk. The struct is the standard one: nine `uint32` of
header (`dwManufacturer`, `dwProduct`, `dwSamplePeriod`, `dwMIDIUnityNote`,
`dwMIDIPitchFraction`, `dwSMPTEFormat`, `dwSMPTEOffset`, `cSampleLoops`,
`cbSamplerData`) followed by six `uint32` per loop.

Two bugs in `loopfind.py` surfaced only once GrandOrgue tried to load the
output, and both are easy to repeat:

- **Loop points had no pre-roll.** The file emitted the loop twice and pointed
  the loop at the *first* copy, starting at sample 0. GrandOrgue crossfades a
  loop against the samples *preceding* its start, so it reported "the loop 1 is
  ignored: not enough samples for crossfade before it's start", then "No valid
  loops exist in the file", and **every pipe failed to load**. Fixed by
  emitting the loop three times and pointing at the middle copy.
- **`dwMIDIUnityNote` was hardcoded to 60** for every note. GrandOrgue reads it
  back as the sample's recorded pitch (`GOSoundProviderWave`), so it silently
  mistunes any auto-tuned pipe built from the file. Fixed to the real note.

Neither changes the audio, so the QA gate still reports **8/13** with the same
CV and wrap figures — the loop search itself is unaffected.

### The organ sounded a constant tone with no MIDI at all

Recording the loaded organ with nothing sent to it produced a steady 932 Hz
tone, RMS 0.0101, flat for as long as it ran, while GrandOrgue's own toolbar
reported polyphony 0 and neither CC 123 nor CC 120 touched it.

Bisected under a PulseAudio null sink, one variable per run:

| Variant | Idle output |
|---|---|
| `-g`, no samples loaded | silence (RMS 0.000000) |
| GrandOrgue's own demo organ, samples loaded | silence |
| our organ, every staged sample zeroed | silence |
| our organ, melody samples zeroed, drone intact | **the tone** |
| our organ, `DefaultToEngaged=N` | silence |
| our organ, drone rank padded to two pipes | silence |

The cause is in `GOStop::IsForEffects`:

```cpp
/* if a stop only has 1 note, the note isn't actually controlled by a
 * manual, but will be on if the stop is on and off if the stop is off */
return (m_RankInfo.size() == 1 && m_RankInfo[0].Rank->GetPipeCount() == 1);
```

A one-rank, one-pipe stop is an **effects stop** — the zimbelstern case.
`GOStop::SetKeyState` returns early for it, so the pipe sounds while the stop is
engaged and the manual never gets a say. A droneless chamber has exactly one
note, so the drone rank hit this exactly, and `DefaultToEngaged=Y` meant it
sounded from the moment the organ loaded. Nothing in the MIDI vocabulary can
stop it, because no key is involved: only GrandOrgue's own Panic resets it.

The fix is to pad any rank below two pipes with a `DUMMY` entry, which
`odfgen.py` now does. Two measurement traps are worth recording alongside it:

- **The tone is not an octave high.** A naive FFT peak reads it as 932 Hz,
  which looks like A#5 against an `A#4_loop.wav` filename. Every VCSL recorder
  sample has its second harmonic 70–80 dB above its fundamental, so the peak
  bin is the octave for the source file, the loop, and GrandOrgue's output
  alike. This is the same trap §4 already documents; `dsp.detect_f0` seeded
  from the nominal note returns 466.05 Hz and is right.
- **Polyphony 0 is not evidence that nothing is sounding.** It counts keyed
  pipes, and an effects stop has none.

### Why no MIDI note produced sound, and what fixes it

Resolved: the app now plays through GrandOrgue, verified by recording the real
output device while the real player ran -- 28.7 s, peak 0.049, with the inhale
gaps visible as drops to ~0.0005. Three separate things were wrong, and one of
them was the diagnosis itself.

**1. The ODF never declared `MIDIInputNumber`.** GrandOrgue's bundled ODF
reference, Manual objects: *"MIDIInputNumber (integer 0-200, default: 0) ... 0
means no association. 1 maps to pedal, 2 to first manual."* Omitting it left the
manual associated with nothing, so no MIDI configuration could attach to it.
Note that 1 is the **pedal** -- a single-manual organ is 2, and its Initial MIDI
slot is `MidiInitial002`, not 001.

**2. The receiver's ranges were degenerate.** Exporting the settings through
**Audio/MIDI → MIDI Objects → Export** showed the manual already had a `Note`
receiver, with `high_key: 0` and `high_value: 0` -- a key range of 0..0 and a
velocity range of 1..0, matching nothing. `grandorgue-midi.yaml` in the repo is
the corrected file; import it through the same dialog.

**3. The tests were sending the wrong notes.** This is the one that cost the
most time. `Manual001` starts at `FirstAccessibleKeyMIDINoteNumber` = 36, and
the app sends 36..44 from the key manifest -- but every manual probe used
60..67, which is outside the manual's range. GrandOrgue received those events
and correctly ignored them, which looks exactly like an unbound receiver.
**Out-of-range notes fail silently and are indistinguishable from a
misconfigured receiver.** Check the manual's key range before concluding
anything about MIDI binding.

**Audio/MIDI → Log MIDI events** is the diagnostic that separates the cases: it
prints every arriving event, so "not received" and "received and dropped" stop
looking alike. Two attempts to seed the receiver by hand-writing the config file
failed before the exported YAML made the actual state visible.

### Where the binding is kept, and how long it lasts

Once made, the binding persists on its own. It is stored per organ in a
combination file at

    ~/Documents/GrandOrgue/Data/<HASH>-0.cmb

which is gzipped text; `zcat` it and the manual's receiver is a plain
`[Manual001]` block of `MIDIChannel001`, `MIDIEventType001`, key range and
velocity range. GrandOrgue writes it on clean exit, so driving **File → Save**
is not required — which matters, because that menu item resisted automation by
both `ctrl+s` and a synthetic click.

`~/Documents/GrandOrgue/Settings/` stays empty and is the wrong place to look;
searching it is what makes the binding look lost when it is not.

Measured: a load-and-exit cycle against a copy of a real GrandOrgue home
returned the same hash filename with the `[Manual001]` receiver byte-for-byte
intact, and it had already survived two regenerations of the ODF it belongs to.
The hash is therefore stable across ODF content changes.

What it is *not* is reproducible from outside GrandOrgue. It matches no SHA-1 of
the ODF's path or contents under any combination of encoding, length prefix and
terminator tried, so a prebuilt `.cmb` cannot be shipped to a machine that has
never made the binding. Nor can one be captured by loading the organ once: with
nothing bound, GrandOrgue writes no `.cmb` at all. The one-time import of
`grandorgue-midi.yaml` through **Audio/MIDI → MIDI Objects → Import** stays
manual; it just does not have to be repeated.

---

## 8. GrandOrgue runtime control, and reverb

Checked because SPEC's §3 "write-only device" had hardened into a stronger claim
than the evidence supported — that nothing about the instrument can change once
loaded. Write-only is true about **reading**; it says nothing about what
GrandOrgue itself can do at runtime.

### What can change while an organ is loaded

| Capability | Runtime? | Drivable by us? | Evidence |
|---|---|---|---|
| Panic (all sound off) | yes | **yes, MIDI** | "Added Midi listener for Panic button and Exit GO function", [CHANGELOG](https://github.com/GrandOrgue/grandorgue/blob/master/CHANGELOG.md) 3.15.0; help: "Panic button can also be fired by a MIDI message" |
| Exit, Memory Set | yes | yes, MIDI | help, MIDI objects |
| Temperament | yes — "The samples are retuned on the fly when playing. No additional disk storage is required." | **no** | [help/grandorgue.xml](https://github.com/GrandOrgue/grandorgue/blob/master/help/grandorgue.xml) |
| Voicing — amplitude, gain, tuning "at every level of the sample set from the whole organ level down to the individual pipe" | yes | **no** | help, Organ Settings dialog |
| Reload a regenerated ODF | yes — File → Reload, "reload the currently loaded sample set from disk" | **no** — menu/keyboard only | help |
| MIDI Tuning Standard / real-time retune | **no** | no | [discussion #1395](https://github.com/GrandOrgue/grandorgue/discussions/1395) — maintainer called runtime pitch modification "rather unorthodox regarding real pipe organs"; no implementation |

The help lists only **Panic, Exit and Memory Set** as application-level functions
with MIDI event assignment. Load, Open and Reload are not among them, so the
regenerate-and-reload path in SPEC §10.8 needs a human.

**Two design consequences, both taken.** Panic being a MIDI object gives the
stuck-drone failure mode a second lever independent of our note-offs (SPEC §9).
And the temperament engine makes intonation a runtime setting — so the ODF now
maps keys to real MIDI note numbers and keeps `AcceptsRetuning=Y`, rather than
packing pipes as scale-degree indices and being forced to `AcceptsRetuning=N`
(SPEC §4). The profile's cents table becomes the organ's original temperament;
GrandOrgue's stock temperaments are one menu away.

The limit of that, and it is a real one: a GrandOrgue temperament is twelve
offsets per octave, repeating, so it cannot express a stretched octave. If §2's
non-2:1 octave holds, it survives only in the original temperament.

> **Unverified, flagged.** A [report](https://github.com/GrandOrgue/grandorgue/issues/1351)
> that selecting any non-original temperament retunes the whole organ to
> a1 = 440 Hz came from a search summary, not the issue read at source. If true,
> a 432 profile must stay on the original temperament — which is where its own
> tuning lives anyway, so the design is the same either way.

### Reverb

GrandOrgue has a **built-in convolution reverb** — File → Settings → Reverb →
Enable Convolution Reverb, taking an impulse-response WAV, with gain, delay,
offset and tail-length settings. It is built on `zita-convolver`, Fons
Adriaensen's library — *the same engine* an external `jconvolver` would run, so
routing an external convolver buys routing flexibility, not sound quality.

Reported caveats, all forum/discussion level rather than help-documented:

- Minimum 1024 samples per buffer or it does not work.
- Gain wants roughly 0.05–0.2; higher distorts.
- Settings are **global, not per-organ**, and only take effect after closing and
  reopening the dialog.
- Toggling reverb while notes sound stops them on Linux.
- The UI carries a "not currently supported" warning although it functions.
- Best paired with **dry** samples — which VCSL's close-recorded recorders are.

Source: [discussion #975](https://github.com/GrandOrgue/grandorgue/discussions/975),
[discussion #625](https://github.com/GrandOrgue/grandorgue/discussions/625).
**Not confirmed against the help documentation** — a fetch of `help/grandorgue.xml`
for the Reverb tab failed on this environment's egress proxy. Verify the buffer
and gain figures before writing them into a launch script.

**Impulse responses.** The obvious source is the OpenAIR library (University of
York), which has church and cathedral surveys. **Its licence could not be
checked — `openair.hosted.york.ac.uk` is blocked by this environment's egress
proxy**, same as the tuning sources in §2. Do not ship any IR until the terms
are read at source. `zita-rev1` (algorithmic, Fons Adriaensen) sidesteps the
question entirely and is the safe default if licensing stalls.

**The finding that matters musically** is not which reverb but how long: SPEC §5
builds the whole performance on the drone *stopping* for breath, and a 5–6 s
cathedral tail fills the 0.3–1.6 s inhale gap and erases it. Start at 1.5–2.5 s
and trust your ears against `inhale_s`.

### External alternatives, if the built-in path disappoints

| Tool | Kind | Note |
|---|---|---|
| [zita-rev1](https://kokkinizita.linuxaudio.org/linuxaudio/) | algorithmic, JACK + LV2 | Fons Adriaensen; no IR licensing question; strong on sustained tone |
| [Dragonfly Reverb](https://michaelwillis.github.io/dragonfly-reverb/) | algorithmic, LV2/VST | Hall / Room / Plate / Early Reflections, on Freeverb3 |
| jconvolver | convolution, JACK | same `zita-convolver` engine as GrandOrgue's built-in |

All need a plugin host (`jalv`, `carla`) and JACK wiring — an extra process and
extra launch-script complexity that the built-in reverb avoids entirely.

---

## 9. The web GUI, measured against SPEC §10.12

Verified against the running engine: the API by direct request, the page in a
real browser. Numbers below are single measurements, not averages.

| # | Criterion | Result |
|---|---|---|
| 1 | Editing marks dirty and changes nothing audible; Revert restores | **Pass** — two edited weights marked dirty, `committed` unchanged, Revert restores from the committed baseline |
| 2 | A set applies entirely on one breath boundary, or not at all | **Pass** — polling at 20 Hz across the drain, **0** observations of a half-applied set |
| 3 | A root outside the mode is refused with a named field, nothing applied | **Pass** — 422 with `root: the drone chamber cannot sound this note`, `committed.root` unchanged, nothing queued |
| 4 | The countdown reaches zero within 250 ms of the drain | **Pass** — predicted 9.30 s, drained at 9.32 s, **12 ms** error |
| 5 | Closing the browser changes nothing audible; reopening shows current values | **Pass** — four breaths played with no page open; the reopened page showed the engine's committed set and no dirty fields |
| 6 | Killing the engine shows disconnected within 1 s and disables everything | **Pass** — banner at **50 ms**, every control disabled |
| 7 | Loopback only unless `--token`; the token is checked on every request | **Pass** — a non-loopback bind without a token raises; `/state` returns 403 with no token and with a wrong one |
| 8 | Ten minutes of polling shifts breath start times by < 5 ms | **Pass** — 73 breaths over 618 s against a headless run of the same seed: **worst drift 0.30 ms**, and every breath length identical |

Criterion 4's spinner path never triggered, so the "countdown hit zero first"
branch is written but unobserved.

The page was then rebuilt as one dense panel — parameters as single rows of
label, slider and value, no cards, no section headings. That is not only taste:
accenting every heading and control meant colour signalled nothing, so colour
now carries state only — amber for edited-not-submitted, green for sounding, red
for panic — and the transport reads as a transport by shape and position rather
than by a caption saying so. The panel went from roughly 1200 px tall to 210,
and the same eight criteria were re-run against it unchanged.

Two things the build changed, both from testing rather than from reading:

- **The page must serialise its own polls.** At 4 Hz, two `/state` requests can
  interleave, and the second can clear the state the first is about to read.
  That showed up as a false "settings changed underneath you" banner after the
  page's *own* submission drained.
- **Panic must not close the MIDI port.** `MidiOut.panic` is the exit path and
  is terminal by design; using it for the GUI's Panic button ended the
  performance rather than silencing it. `MidiOut.silence` is the mid-performance
  version, and `Controller.panic` stops the run and holds.

Not built, and not claimed: **replay from seed + session log**. The engine
appends every applied submission to a JSONL log as §10.9 requires, but nothing
reads it back, so SPEC §12 criterion 5's submission half has no implementation.
Mode and pulse have no controls either — the melody generator has no scale or
pulse model to drive (§8), so a widget for them would be a widget that does
nothing.
