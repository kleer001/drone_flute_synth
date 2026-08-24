/* The performance parameter set: named weights, their bounds, validation.
 *
 * A macro over a weights table, not a model. The numbers are a starting point
 * to tune by ear; nothing here is derived from measurement and nothing should
 * be described as if it were.
 *
 * A mood is the bulk of what a performance is, but not all of it -- key, mode,
 * seed, the drone slots and the two breath fields sit alongside the weights.
 * `NUMERIC_PARAMS` and `validateParams` cover the whole set, because a client
 * submits it whole.
 */
import { BREATH_CLAMP_S, INHALE_CLAMP_S } from "./breath.js";
import * as scales from "./scales.js";

// Tempo is part of a mood, not of the instrument: a mood that asks for more
// notes in a breath needs a faster beat to fit them, and one that asks for
// stillness needs a slower one. `bpm` is the quarter note.
//
// Written as labelled fields rather than a positional row: thirteen unlabelled
// numbers per mood is a transcription error waiting to happen, and a row that
// disagreed with its own key would go unnoticed because `get` looks up by key
// while everything downstream reads `name`. The key is stamped in below, so
// the two cannot drift.
const PRESETS = {
  "contemplative": { notes_per_breath: 4, step_leap_ratio: 0.80, ornament_rate: 0.10,
    cadence_strength: 0.70, register_bias: 0.0,
    breath_mean_s: 8.0, call_response: 0.55, bpm: 72, phrase_shape: [3.0, 3.0] , drum_density: 0.4, rattle_scale: 3, wash_rate: 0.15 },
  "mourning": { notes_per_breath: 3, step_leap_ratio: 0.85, ornament_rate: 0.15,
    cadence_strength: 0.85, register_bias: -0.2,
    breath_mean_s: 9.0, call_response: 0.65, bpm: 56, phrase_shape: [2.0, 4.0] , drum_density: 0.3, rattle_scale: 3, wash_rate: 0.2 },
  "pastoral": { notes_per_breath: 6, step_leap_ratio: 0.70, ornament_rate: 0.20,
    cadence_strength: 0.55, register_bias: 0.1,
    breath_mean_s: 7.0, call_response: 0.50, bpm: 88, phrase_shape: [3.0, 3.0] , drum_density: 0.45, rattle_scale: 2, wash_rate: 0.1 },
  "ceremonial": { notes_per_breath: 5, step_leap_ratio: 0.60, ornament_rate: 0.15,
    cadence_strength: 0.75, register_bias: 0.2,
    breath_mean_s: 7.5, call_response: 0.75, bpm: 66, phrase_shape: [4.0, 2.0] , drum_density: 0.55, rattle_scale: 2, wash_rate: 0.12 },
  "restless": { notes_per_breath: 11, step_leap_ratio: 0.45, ornament_rate: 0.40,
    cadence_strength: 0.25, register_bias: 0.4,
    breath_mean_s: 5.0, call_response: 0.35, bpm: 120, phrase_shape: [2.0, 2.0] , drum_density: 0.35, rattle_scale: 2, wash_rate: 0.05 },
  "sleep": { notes_per_breath: 2, step_leap_ratio: 0.92, ornament_rate: 0.02,
    cadence_strength: 0.90, register_bias: -0.3,
    breath_mean_s: 11.0, call_response: 0.30, bpm: 48, phrase_shape: [2.0, 4.0] , drum_density: 0.25, rattle_scale: 4, wash_rate: 0.25 },
};

export const MOODS = Object.fromEntries(
  Object.entries(PRESETS).map(([name, weights]) => [name, { name, ...weights }]));

export function get(name) {
  const key = String(name).toLowerCase();
  if (!(key in MOODS)) {
    throw new Error(`unknown mood ${name}; have ${Object.keys(MOODS).join(", ")}`);
  }
  return MOODS[key];
}

// The parameter set the control surface edits, with the range each is held to.
// The page reads these rather than repeating them, so there is one source for
// a bound.
export const NUMERIC_PARAMS = {
  notes_per_breath: [1.0, 14.0],
  step_leap_ratio: [0.0, 1.0],
  ornament_rate: [0.0, 1.0],
  cadence_strength: [0.0, 1.0],
  register_bias: [-1.0, 1.0],
  call_response: [0.0, 1.0],
  bpm: [40.0, 160.0],
  breath_mean_s: BREATH_CLAMP_S,
  breath_spread_s: [0.0, 5.0],
  inhale_s: INHALE_CLAMP_S,
  // Which octaves the tune plays in, as a shift on the recorded span. Down is
  // roomier than up: the recordings are a soprano recorder, so lifting them an
  // octave gets shrill fast while dropping them just sounds like a bigger pipe.
  lead_octave: [-2, 1],
  song_blocks: [2, 6],
  song_repeats: [1, 4],
  drum_density: [0.0, 1.0],
  rattle_scale: [1, 4],
  wash_rate: [0.0, 0.5],
};

// What counts as the mood, in its order. `breath_mean_s` and `bpm` are among
// them, so the breath panel owns only spread and inhale -- two controls writing
// one value would make it ambiguous which one won.
export const MOOD_WEIGHTS = ["notes_per_breath", "step_leap_ratio",
  "ornament_rate", "cadence_strength", "register_bias",
  "call_response", "bpm", "breath_mean_s",
  "drum_density", "rattle_scale", "wash_rate"];

// The parameters the head row gives their own control -- a menu, a text box, a
// stepper. Some are numeric all the same: `lead_octave` has a range like any
// weight, it just reads better as a nudge than as a slider with four stops.
export const CHOICE_PARAMS = ["mood", "key", "mode", "seed", "lead_octave",
                              "song", "song_blocks", "song_repeats",
                              "drum", "rattle", "wash",
                              "drum_pool", "rattle_pool"];

// Mood weights, but shown with the rhythm controls rather than among the ones
// that shape the tune.
export const RHYTHM_FIELDS = ["drum_density", "rattle_scale", "wash_rate"];
export const WEIGHT_FIELDS = MOOD_WEIGHTS.filter((w) => !RHYTHM_FIELDS.includes(w));

// The numeric parameters left over: not a mood weight, not on a menu. Derived
// rather than restated, so a new parameter cannot go missing from the page --
// but it does mean a numeric parameter belongs on a menu or in this block, and
// nowhere else.
export const BREATH_FIELDS = Object.keys(NUMERIC_PARAMS).filter(
  (k) => !MOOD_WEIGHTS.includes(k) && !CHOICE_PARAMS.includes(k)
      && !RHYTHM_FIELDS.includes(k));

// Three drone voices, each an optional semitone offset from the tonic. Two
// octaves either way is deliberately wide: a drone far below the lead is the
// point of the instrument.
export const DRONE_SLOTS = 3;
export const DRONE_SEMITONES = [-24, 24];

/* Root sounding, a fifth and an octave-down staged but silent. */
export function defaultDrones() {
  return [{ on: true, semitones: 0 },
          { on: false, semitones: 7 },
          { on: false, semitones: -12 }];
}

/* Every preset's weight set, so a client can offer preset switching. */
export function presetWeights() {
  const out = {};
  for (const [name, preset] of Object.entries(MOODS)) {
    out[name] = {};
    for (const w of MOOD_WEIGHTS) out[name][w] = Number(preset[w]);
  }
  return out;
}

/* A Mood built from live weights, keeping the named preset's phrase shape.
 * `phrase_shape` is a pair rather than a scalar, so it has no slider and stays
 * whatever the preset chose. */
export function fromWeights(name, weights) {
  const preset = get(name);
  const out = { name, phrase_shape: preset.phrase_shape };
  for (const w of MOOD_WEIGHTS) out[w] = Number(weights[w]);
  return out;
}

/* Whole-set validation. Returns {field: reason}; empty means valid. */
export function validateParams(params) {
  const errors = {};
  for (const [name, [lo, hi]] of Object.entries(NUMERIC_PARAMS)) {
    const value = Number(params[name]);
    if (params[name] === undefined || params[name] === null || Number.isNaN(value)) {
      errors[name] = "must be a number";
      continue;
    }
    if (!(value >= lo && value <= hi)) {
      errors[name] = `must be between ${lo} and ${hi}`;
    }
  }
  try { scales.pitchClass(params.key ?? ""); }
  catch { errors.key = `must be a note name, one of ${scales.NOTE_NAMES.join(", ")}`; }
  try { scales.get(params.mode ?? ""); }
  catch (e) { errors.mode = e.message; }
  try { get(params.mood ?? ""); }
  catch (e) { errors.mood = e.message; }

  const drones = params.drones;
  if (!Array.isArray(drones) || drones.length !== DRONE_SLOTS) {
    errors.drones = `must be a list of ${DRONE_SLOTS} slots`;
  } else {
    const [lo, hi] = DRONE_SEMITONES;
    drones.forEach((slot, i) => {
      if (!slot || typeof slot !== "object"
          || !("on" in slot) || !("semitones" in slot)) {
        errors[`drones[${i}]`] = "must have 'on' and 'semitones'";
        return;
      }
      const step = Number(slot.semitones);
      if (!Number.isFinite(step)) {
        errors[`drones[${i}]`] = "semitones must be a whole number";
      } else if (step < lo || step > hi) {
        errors[`drones[${i}]`] = `semitones must be ${lo} to ${hi}`;
      }
    });
  }

  if (!Number.isFinite(Number(params.seed))) {
    errors.seed = "must be a whole number";
  }
  for (const flag of ["song", "drum", "rattle", "wash"]) {
    if (typeof params[flag] !== "boolean") errors[flag] = "must be true or false";
  }
  return errors;
}
