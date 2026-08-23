/* Melody as motif and phrase, not as a random walk.
 *
 * An earlier version drew each breath fresh: a new random start, a drunkard's
 * walk over scale positions, and onsets drawn from a Beta distribution. It had
 * variety and no unity, so nothing was ever restated, nothing was recognisable,
 * and the line meandered. It also had no rhythmic spine -- every onset was an
 * independent real number, so there was no pulse to lean on.
 *
 * This version:
 *
 * - **A motif, repeated and varied.** A 3-5 note cell is stated, restated, and
 *   transformed (sequence, inversion, retrograde, augmentation, fragmentation).
 *   Unity comes from the repetition and variety from the transformation, rather
 *   than from fresh randomness each time.
 * - **A meter.** Every breath resolves to a bar line. Onsets fall on
 *   eighth-note positions and durations are conventional values -- eighth,
 *   quarter, dotted quarter, half, dotted half, whole -- so the line can be
 *   written down and read back. Accent follows the bar: downbeats are
 *   strongest, other beats next, offbeats weakest.
 * - **One arch, peaking late.** Statements are transposed to follow a contour
 *   that rises to a single climax in the back half and falls to the cadence.
 * - **Stable and active degrees.** Stability is measured against the drone,
 *   since the drone is the only harmony present: unison and fifth are rest
 *   points, thirds and sixths are softer ones, everything else wants to move.
 *   A phrase resolves onto a rest point instead of having the root pasted over
 *   its last note.
 * - **Gap-fill.** A leap opens a gap, and the next notes step back into it.
 * - **Ornaments between the structural notes.** The skeleton stays simple; the
 *   flourish is the personality.
 *
 * Everything random comes from the caller's Rng, so a seed reproduces a
 * performance exactly.
 *
 * This module knows nothing about keys, scales or pitches. It works on integer
 * *positions* in a note list, which is why a new scale costs it nothing.
 */
import { midiOf } from "./scales.js";
import { round, mod } from "./rng.js";

export const GRACE_S = 0.06;
// Conventional note values, in eighths, longest first: whole, dotted half,
// half, dotted quarter, quarter, eighth. A structural note is always one of
// these, so every phrase is notatable.
const NOTE_VALUES = [8, 6, 4, 3, 2, 1];
const ARTICULATION = 0.9;      // a note stops short of the next onset, so it breathes
const CLIMAX_AT = 0.68;        // one high point, in the back half

// Interval to the drone, in semitones, folded into an octave. Unison and fifth
// are where a phrase can come to rest; thirds and sixths are softer rest points.
const STRONG_REST = [0, 7];
const WEAK_REST = [3, 4, 8, 9];

export class Note {
  constructor(name, startS, durS, velocity, isGrace = false) {
    this.name = name;
    this.startS = startS;
    this.durS = durS;
    this.velocity = velocity;
    this.isGrace = isGrace;
  }
}

/* The longest conventional value that is no longer than `want` or `room`. */
export function fitValue(want, room) {
  const limit = Math.min(want, room);
  for (const value of NOTE_VALUES) if (value <= limit) return value;
  return 0;
}

/* 2 = strong rest, 1 = weak rest, 0 = active, per scale position. */
export function stability(notes, root) {
  const r = midiOf(root);
  return notes.map((name) => {
    const step = mod(midiOf(name) - r, 12);
    if (STRONG_REST.includes(step)) return 2;
    return WEAK_REST.includes(step) ? 1 : 0;
  });
}

// -- the motif and its transformations ------------------------------------
// Each is a pure function over a list of [step, units]: the cheapest and most
// principled way to earn variety from recombination.

export function newMotif(rng, mood) {
  const length = rng.choice([3, 3, 4, 4, 5]);
  const out = [];
  for (let i = 0; i < length; i++) {
    let step;
    if (i === 0) step = 0;
    else if (rng.random() < mood.step_leap_ratio) step = rng.choice([-1, 1, 1]);
    else step = rng.choice([-3, -2, 2, 3]);
    out.push([step, rng.choice([1, 1, 1, 2, 2, 3])]);
  }
  return out;
}

/* Tonal sequence: restate at another pitch level, along the scale. */
const transpose = (motif, by) =>
  motif.map(([s, d], i) => [i === 0 ? s + by : s, d]);

/* Mirror the contour: every rise becomes the same fall. */
const invert = (motif) => motif.map(([s, d]) => [-s, d]);

const retrograde = (motif) => motif.slice().reverse();

const augment = (motif) => motif.map(([s, d]) => [s, d * 2]);

const diminish = (motif) => motif.map(([s, d]) => [s, Math.max(1, Math.floor(d / 2))]);

/* Keep a sub-segment and let it stand for the whole. */
function fragment(motif, rng) {
  if (motif.length <= 2) return motif;
  const n = rng.randint(2, motif.length - 1);
  const start = rng.randint(0, motif.length - n);
  return motif.slice(start, start + n);
}

const TRANSFORMS = {
  "repeat": (m) => m,
  "sequence": (m, rng) => transpose(m, rng.choice([-2, -1, 1, 2])),
  "invert": invert,
  "retrograde": retrograde,
  "augment": augment,
  "diminish": diminish,
  "fragment": fragment,
};
const TRANSFORM_NAMES = Object.keys(TRANSFORMS);
// Repetition is what makes a motif recognisable, so it is weighted highest;
// without it the transformations have nothing to vary from.
const TRANSFORM_WEIGHTS = [4, 3, 2, 2, 1, 1, 2];

// An answer is a reply, not development: restating the call higher, mirroring
// it, or running it backwards all read as a response to what was just said.
// Augmentation and diminution stretch material rather than answer it.
const ANSWER_TRANSFORMS = ["sequence", "invert", "retrograde", "fragment"];
const ANSWER_WEIGHTS = [3, 3, 2, 2];

// Developing variation: a restated call is varied, not photocopied. Returning
// the cell verbatim made every call breath in a run sound the same -- unity
// with nothing developing, which is monotony wearing a different hat.
const RESTATE_TRANSFORMS = ["repeat", "sequence", "fragment", "diminish"];
const RESTATE_WEIGHTS = [2, 4, 2, 1];

/* 0 at the phrase edges, 1 at the climax -- a rise and a longer fall. */
function arch(position) {
  if (position <= CLIMAX_AT) return position / CLIMAX_AT;
  return Math.max(0, (1 - position) / (1 - CLIMAX_AT));
}

export class Phrasing {
  /* Carries the motif between breaths, which is where unity comes from. */
  constructor(rng, notes, root) {
    this.rng = rng;
    this.notes = notes;
    this.root = root;
    this.stability = stability(notes, root);
    this.motif = null;         // the current pair's cell
    this.callMotif = null;     // what the answer must quote
    this.base = null;          // the cell this breath is working with
    this.relation = "new";     // how this breath relates to the last
    this.statements = 0;
    // Breaths alternate roles: a call that leaves the line open, then an
    // answer that ornaments it and resolves. Tension and release as a
    // phrase-pair, with the breath as the phrase.
    this.role = "call";
    this.lastRole = "call";
  }

  // -- helpers ------------------------------------------------------------

  _restPositions() {
    const found = [];
    this.stability.forEach((s, i) => { if (s >= 2) found.push(i); });
    return found.length ? found : this.notes.map((_, i) => i);
  }

  _clamp(pos) {
    return Math.max(0, Math.min(this.notes.length - 1, pos));
  }

  /* Reflect off the ends of the range instead of pinning against them.
   *
   * Clamping makes a line stick: every downward step at position 0 lands on
   * position 0 again, and the phrase repeats one note until the motif turns
   * around. Reflecting keeps it moving and mimics what a player does at the
   * end of the instrument's range -- turn back. */
  _fold(pos) {
    const top = this.notes.length - 1;
    if (top <= 0) return 0;
    while (pos < 0 || pos > top) pos = pos < 0 ? -pos : 2 * top - pos;
    return pos;
  }

  /* Choose the material this breath works with.
   *
   * Two levels of unity. Across a pair, an **answer quotes its call**: it is
   * always a transformation of the call's own cell, never fresh material, so
   * the two breaths are demonstrably talking about the same thing. Across
   * pairs, the rule of three -- a pair's material is reused about three times
   * before anything new is invented. */
  beginBreath(mood, answering) {
    if (answering && this.callMotif !== null) {
      const pick = this.rng.choices(ANSWER_TRANSFORMS, ANSWER_WEIGHTS);
      this.base = TRANSFORMS[pick](this.callMotif, this.rng);
      this.relation = pick;
    } else {
      if (this.motif === null || this.statements >= this.rng.choice([2, 2, 3])) {
        this.motif = newMotif(this.rng, mood);
        this.statements = 0;
        this.base = this.motif;
        this.relation = "new";
      } else {
        this.statements += 1;
        const pick = this.rng.choices(RESTATE_TRANSFORMS, RESTATE_WEIGHTS);
        this.base = TRANSFORMS[pick](this.motif, this.rng);
        this.relation = pick;
      }
      // The answer replies to what was actually just played, not to the
      // canonical cell it came from.
      this.callMotif = this.base;
    }
    return this.base;
  }

  /* A later statement inside one breath: vary the breath's own cell. */
  _restate() {
    const pick = this.rng.choices(TRANSFORM_NAMES, TRANSFORM_WEIGHTS);
    return TRANSFORMS[pick](this.base, this.rng);
  }

  // -- ornaments ----------------------------------------------------------

  /* Shake with the upper neighbour, then resolve onto the main note.
   *
   * The shakes are grace: they decorate, and the note the motif asked for is
   * the resolution, which lands on a grid position with a conventional value of
   * its own. A trill therefore never moves the skeleton. */
  _trill(pos, startS, velocity, unitS, held) {
    const upper = this._fold(pos + 1);
    const tail = held >= 6 ? 2 : 1;            // units the resolution keeps
    const shakeUnits = held - tail;
    const shakeS = shakeUnits * unitS;
    const n = Math.max(2, shakeUnits * 4);     // four shakes to the unit
    const rate = shakeS / n;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(new Note(this.notes[i % 2 === 0 ? pos : upper],
                        startS + i * rate, rate,
                        i % 2 === 0 ? velocity : Math.max(1, Math.trunc(velocity * 0.9)),
                        true));
    }
    out.push(new Note(this.notes[pos], startS + shakeS,
                      tail * unitS * ARTICULATION, velocity));
    return out;
  }

  /* Grace notes leaning into the beat, ahead of the structural note.
   *
   * They borrow from the silence before the note rather than from the note
   * itself, so the skeleton keeps both its grid position and its written
   * value. That is what a grace note is. */
  _ornament(pos, startS, velocity) {
    const kind = this.rng.choices(["grace", "mordent", "turn"], [3, 2, 2]);
    const shape = kind === "grace" ? [this.rng.choice([-1, 1])]
                : kind === "mordent" ? [0, -1] : [1, 0, -1];
    const lead = GRACE_S * shape.length;
    if (startS < lead) return [];
    return shape.map((offset, i) =>
      new Note(this.notes[this._clamp(pos + offset)],
               startS - lead + i * GRACE_S, GRACE_S,
               Math.max(1, Math.trunc(velocity * 0.85)), true));
  }

  /* A fast scalar dash filling the gap before a structural note. */
  _runInto(fromPos, toPos, arriveS, unitS, velocity) {
    const span = toPos - fromPos;
    const steps = [];
    for (let i = 1; i < Math.abs(span); i++) {
      steps.push(fromPos + (span > 0 ? 1 : -1) * i);
    }
    if (!steps.length) return [];
    const rate = Math.min(0.09, unitS / Math.max(2, steps.length));
    const first = arriveS - rate * steps.length;
    if (first < 0) return [];
    return steps.map((p, i) =>
      new Note(this.notes[this._clamp(p)], first + i * rate, rate,
               Math.max(1, Math.trunc(velocity * 0.8)), true));
  }

  // -- one breath ---------------------------------------------------------

  breath(mood, meter, breathLenS, layerVelocity) {
    const rng = this.rng;
    if (!this.notes.length) throw new Error("no playable notes");

    // Call and answer: the call sits lower, stays plainer and tends to leave
    // the phrase open; the answer climbs, decorates and resolves.
    const answering = this.role === "answer";
    const contrast = mood.call_response;
    const ornRate = Math.min(1, mood.ornament_rate *
      (answering ? 1 + 0.9 * contrast : 1 - 0.7 * contrast));
    const trillRate = Math.min(1, mood.trill_rate *
      (answering ? 1 + contrast : 1 - 0.8 * contrast));
    const cadenceP = Math.min(1, mood.cadence_strength *
      (answering ? 1 + contrast : 1 - contrast));

    // The breath is a whole number of beats, so this division is exact.
    const units = Math.max(2, round(breathLenS / meter.unitS));
    const unitS = meter.unitS;
    // notes_per_breath sets how much of the breath carries notes; the rest is
    // silence the phrase can breathe in.
    const budget = Math.max(2, Math.min(units,
      round(mood.notes_per_breath * 1.4)));

    const span = Math.max(1.5, (this.notes.length - 1) * 0.45);
    const centre = (this.notes.length - 1) * (0.5 + mood.register_bias * 0.35)
                 + span * (answering ? 0.5 : -0.5) * contrast;

    const base = this.beginBreath(mood, answering);
    let firstStatement = true;

    const scheduled = [];
    let pos = this._clamp(round(centre));
    let at = 0;                                // position, in units
    let placed = 0;

    while (at < units && placed < budget) {
      const motif = firstStatement ? base : this._restate();
      firstStatement = false;
      // Follow the arch: transpose this statement toward the contour.
      const target = centre + span * (arch(at / units) * 2 - 1) * 0.55;
      pos = this._fold(round(target));

      for (let [step, dur] of motif) {
        if (at >= units || placed >= budget) break;
        const leap = Math.abs(step) > 1;
        // Gap-fill: after a leap, the ear wants stepwise motion back.
        if (leap && scheduled.length && rng.random() < 0.7) {
          step = step > 0 ? -1 : 1;
        }
        const prevPos = pos;
        pos = this._fold(pos + step);

        const startS = at * unitS;
        const held = fitValue(dur, units - at);
        if (held === 0) break;
        const durS = held * unitS * ARTICULATION;

        // Metric hierarchy, from the bar rather than from the phrase: a
        // downbeat is the strong position, other beats are next, and anything
        // between beats is weakest.
        let accent;
        if (at % meter.unitsPerMeasure === 0) accent = 1.0;
        else if (at % meter.UNITS_PER_BEAT === 0) accent = 0.94;
        else accent = 0.86;
        const sweep = 1 - mood.sweep_depth * Math.abs(2 * (at / units) - 1);
        const velocity = Math.max(1, Math.min(127,
          round(layerVelocity * sweep * accent)));

        if (Math.abs(pos - prevPos) > 2 && rng.random() < ornRate) {
          scheduled.push(...this._runInto(prevPos, pos, startS, unitS, velocity));
        }
        if (held >= 4 && rng.random() < trillRate) {
          scheduled.push(...this._trill(pos, startS, velocity, unitS, held));
        } else {
          if (rng.random() < ornRate) {
            scheduled.push(...this._ornament(pos, startS, velocity));
          }
          scheduled.push(new Note(this.notes[pos], startS, durS, velocity));
        }
        at += held;
        placed += 1;
      }

      at += rng.choice([1, 1, 2]);             // breathe between statements
    }

    // Cadence: land on a rest point rather than overwriting with the root.
    // A call is meant to stay open, so it resolves far less often.
    if (scheduled.length && rng.random() < cadenceP) {
      const rests = this._restPositions();
      // First maximum wins on a tie, so grace notes sharing an onset with the
      // structural note they decorate cannot steal the cadence.
      let last = null;
      for (const n of scheduled) {
        if (n.isGrace) continue;
        if (last === null || n.startS > last.startS) last = n;
      }
      if (last !== null) {
        let home = rests[0];
        for (const p of rests) {
          if (Math.abs(p - pos) < Math.abs(home - pos)) home = p;
        }
        last.name = this.notes[home];
        // A cadence wants length: give it a half note where the breath still
        // has room for one, never less than it already had, and never more than
        // is left -- a written value the phrase runs out of time for is not a
        // value it has.
        const room = units - round(last.startS / unitS);
        last.durS = Math.max(last.durS, fitValue(4, room) * unitS * ARTICULATION);
      }
    }

    this.lastRole = `${this.role}:${this.relation}`;
    this.role = answering ? "call" : "answer";
    // Stable sort, so a grace note stays ahead of the note it decorates when
    // the two share an onset.
    scheduled.sort((a, b) => a.startS - b.startS);
    return scheduled;
  }
}
