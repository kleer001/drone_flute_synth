/* The breath cycle.
 *
 * The signature of a drone flute is that melody and drone share one breath.
 * Both release on the same event, so the whole instrument goes quiet at once --
 * an app that drones forever loses the instrument.
 *
 * Lung capacity sets how long a phrase wants to be; the meter decides where it
 * can end. A breath cycle -- sounding plus inhale -- is snapped to a whole
 * number of bars, so the beat runs unbroken through the silence and the next
 * phrase enters on a downbeat.
 *
 * A breath is planned whole and handed over as data rather than played from
 * here, so the same plan can be scheduled on the audio clock or inspected
 * without sounding. That is what makes the acceptance criteria testable.
 */
import { Phrasing, stability } from "./melody.js";
import { midiOf } from "./scales.js";
import { round } from "./rng.js";

export const BREATH_CLAMP_S = [3.0, 14.0];
export const INHALE_CLAMP_S = [0.3, 1.6];

// One blowing pressure, every breath. This player is an ideal one: it does not
// lean on a phrase or run out of air, so nothing here varies how hard it blows.
// A real duct flute could not vary it much anyway -- the windway is fixed, so
// air speed sets pitch and loudness together and a louder note is a sharper
// one. Modelling that faithfully would mean detuning to get louder, which is
// the opposite of what this instrument is for.
export const VELOCITY = 84;

// The shape of the breath itself: how long the tone takes to arrive after the
// player starts blowing, and to fall away when they stop. Every note in a
// breath rides this envelope.
export const BREATH_ATTACK_S = 0.25;
export const BREATH_RELEASE_S = 0.35;

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

/* The clock a performance runs on: a tempo and a bar length.
 *
 * Breaths resolve to bar lines rather than inventing a grid each time, so every
 * phrase in a performance is commensurable with every other one.
 *
 * The two halves come from different places. The bar belongs to the instrument
 * and lives in the profile; the tempo belongs to the mood, so changing mood
 * changes the beat and the GUI can move it live.
 *
 * The unit is the eighth note. Motif durations are whole units, and the
 * conventional values a phrase can use -- eighth through whole -- are counts of
 * them. */
const UNITS_PER_BEAT = 2;             // the beat is a quarter; the unit an eighth

export class Meter {
  constructor(bpm, beatsPerMeasure) {
    this.UNITS_PER_BEAT = UNITS_PER_BEAT;
    this.bpm = Number(bpm);
    this.beatsPerMeasure = Math.trunc(beatsPerMeasure);
    this.beatS = 60 / this.bpm;
    this.measureS = this.beatS * this.beatsPerMeasure;
    this.unitS = this.beatS / UNITS_PER_BEAT;
    this.unitsPerMeasure = this.beatsPerMeasure * UNITS_PER_BEAT;
  }
}

export class Breath {
  constructor(index, lengthS, inhaleS, bars, droneNotes, melodyNotes, role) {
    this.index = index;
    this.lengthS = lengthS;
    this.inhaleS = inhaleS;
    this.bars = bars;
    this.droneNotes = droneNotes;
    this.melodyNotes = melodyNotes;
    this.role = role;
  }
}

/* The notes that actually sounded, as one string. Grace notes decorate rather
   than sound, so they are not part of what makes two breaths the same -- and
   the redraw loop, the acceptance gate and the on-screen log all have to agree
   on that or they measure different things. */
export const noteSequence = (notes) =>
  notes.filter((n) => !(n.isGrace ?? n.grace)).map((n) => n.name).join(" ");

/* Plans breaths. Holds no audio state; the page turns plans into sound. */
export class Performer {
  constructor(profile, mood, rng, leadNotes, droneNotes, root,
              breathSpreadS, inhaleS) {
    this.profile = profile;
    this.mood = mood;
    this.rng = rng;
    this.breathSpreadS = breathSpreadS;
    this.inhaleS = inhaleS;
    this.droneNotes = droneNotes.slice();
    this._setNotes(leadNotes, root);
    // The motif lives here rather than in a single breath: restating it across
    // breaths is where the line gets its unity.
    this.phrasing = new Phrasing(rng, this.melodyNotes, this.root);
    this._index = 0;
    this._lastSequence = null;
  }

  /* Which pitches exist is the caller's business: they come from the key and
     the mode, not from anything this module knows. */
  _setNotes(leadNotes, root) {
    this.root = root;
    this.melodyNotes = leadNotes.slice().sort((a, b) => midiOf(a) - midiOf(b));
  }

  /* The bar comes from the instrument, the tempo from the mood.
   *
   * Derived rather than stored: a stored copy has to be refreshed by hand every
   * time the mood changes, and a refresh that is forgotten is a tempo control
   * that silently stops working. */
  get meter() {
    return new Meter(this.mood.bpm, this.profile.beatsPerMeasure);
  }

  /* Change how the player plays without losing where it is.
   *
   * Rebuilding would hand back a Performer seeded afresh: the random stream
   * would replay from the top, the motif under development would be discarded
   * and the breath count would restart. */
  retune({ mood, root, leadNotes, droneNotes, breathSpreadS, inhaleS } = {}) {
    if (mood != null) this.mood = mood;
    if (breathSpreadS != null) this.breathSpreadS = breathSpreadS;
    if (inhaleS != null) this.inhaleS = inhaleS;
    if (droneNotes != null) this.droneNotes = droneNotes.slice();
    // Stability is measured from the notes against the root, so it has to be
    // rebuilt whenever either of them moves -- a stale table would rate the new
    // scale's degrees by the old scale's intervals.
    if (leadNotes != null || root != null) {
      this._setNotes(leadNotes ?? this.melodyNotes, root ?? this.root);
      this.phrasing.notes = this.melodyNotes;
      this.phrasing.root = this.root;
      this.phrasing.stability = stability(this.melodyNotes, this.root);
    }
  }

  /* Fit one breath cycle to whole bars, in beats.
   *
   * The cycle -- sounding plus inhale -- is a whole number of bars, so the next
   * phrase begins on a downbeat and the beat runs unbroken through the silence.
   * The player breathes on the last beats of the bar, which is where a wind
   * player breathes. */
  _snap(meter, soundTargetS, inhaleTargetS) {
    const measures = Math.max(1, round((soundTargetS + inhaleTargetS) / meter.measureS));
    const cycleBeats = measures * meter.beatsPerMeasure;
    let inhaleBeats = Math.max(1, round(inhaleTargetS / meter.beatS));
    // Leave the phrase at least two beats to sound in.
    inhaleBeats = Math.min(inhaleBeats, Math.max(1, cycleBeats - 2));
    return [(cycleBeats - inhaleBeats) * meter.beatS, inhaleBeats * meter.beatS,
            measures];
  }

  /* Plan one breath. Never repeats the previous note sequence. */
  nextBreath() {
    // Invariant for the whole breath, and the getter rebuilds it on each read.
    const meter = this.meter;
    const [length, inhale, bars] = this._snap(meter,
      clamp(this.rng.gauss(this.mood.breath_mean_s, this.breathSpreadS), BREATH_CLAMP_S),
      clamp(this.rng.gauss(this.inhaleS, 0.2), INHALE_CLAMP_S));

    // Redraw rather than mutate: mutating a phrase to force a difference would
    // bias the note distribution in a way that is hard to reason about.
    // Redrawing keeps the walk's statistics intact.
    let notes, sequence;
    for (let i = 0; i < 8; i++) {
      notes = this.phrasing.breath(this.mood, meter, length, VELOCITY);
      sequence = noteSequence(notes);
      if (sequence !== this._lastSequence) break;
    }
    this._lastSequence = sequence;

    this._index += 1;
    return new Breath(this._index, length, inhale, bars,
                      this.droneNotes, notes,
                      this.phrasing.lastRole);   // call or answer, for display
  }
}
