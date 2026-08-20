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

Ordering still matters, because flattening and crossfading each partly undo the
other and whichever runs last wins its metric. But now that wrap has headroom and
CV does not, flattening should go **last**:

| Order | Notes passing both |
|---|---|
| flatten → crossfade last | 2 / 13 |
| **crossfade → flatten last** | **8 / 13** |
| flatten with linearly-detrended gain | 1 / 13 |

The detrend attempt aimed to stop flattening from re-opening the wrap by forcing
`gain[0] == gain[-1]`. It degraded CV badly (0.004–0.026 → 0.016–0.234):
subtracting a ramp from a *multiplicative* gain distorts the correction. Any
periodic-gain scheme needs to work in the log domain. Not pursued.

Final state of `tools/loopfind.py`: **8/13**, CV 0.004–0.026 (mostly ~0.006),
wrap 0.08–4.5. The five failures are four marginal wrap misses (3.0–4.5) and one
CV miss (C4, 0.026).

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

## 7. GrandOrgue runtime control, and reverb

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

**Two design consequences.** Panic being a MIDI object gives the stuck-drone
failure mode a second lever independent of our note-offs (SPEC §9). And the
temperament engine means intonation *could* be a runtime control if the ODF
opted into retuning — which our scale-degree key mapping currently forbids via
`AcceptsRetuning=N` (see §7 of this file). That is SPEC spike S6.

> **Unverified, flagged.** A [report](https://github.com/GrandOrgue/grandorgue/issues/1351)
> that selecting any non-original temperament retunes the whole organ to
> a1 = 440 Hz came from a search summary, not the issue read at source. If true
> it collides with the 432 option in SPEC §8. Confirm during S6.

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
cathedral tail fills the 0.3–1.6 s inhale gap and erases it. Spike S8.

### External alternatives, if the built-in path disappoints

| Tool | Kind | Note |
|---|---|---|
| [zita-rev1](https://kokkinizita.linuxaudio.org/linuxaudio/) | algorithmic, JACK + LV2 | Fons Adriaensen; no IR licensing question; strong on sustained tone |
| [Dragonfly Reverb](https://michaelwillis.github.io/dragonfly-reverb/) | algorithmic, LV2/VST | Hall / Room / Plate / Early Reflections, on Freeverb3 |
| jconvolver | convolution, JACK | same `zita-convolver` engine as GrandOrgue's built-in |

All need a plugin host (`jalv`, `carla`) and JACK wiring — an extra process and
extra launch-script complexity that the built-in reverb avoids entirely.
