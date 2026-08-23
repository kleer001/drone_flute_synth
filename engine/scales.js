/* Keys and scales: which pitches a mode offers, in any key.
 *
 * A scale is a set of semitone offsets from the tonic, and a key is a pitch
 * class. Everything else follows by arithmetic -- there is no per-note table to
 * author and nothing to keep in sync with a sample set.
 *
 * The generator downstream works on *positions* in a note list, not on
 * pitches, so changing key or mode means handing it a different list. That is
 * the whole mechanism: the melody engine never learns what a mode is.
 */
import { mod } from "./rng.js";

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F",
                           "F#", "G", "G#", "A", "A#", "B"];

const SEMITONE = {};
NOTE_NAMES.forEach((n, i) => { SEMITONE[n] = i; });

// Semitone offsets from the tonic. Seven-note modes first, then the smaller
// sets, which behave differently in the generator: fewer notes per octave means
// a step covers more ground, so the same motif ranges wider.
export const MODES = {
  "major": [0, 2, 4, 5, 7, 9, 11],
  "minor": [0, 2, 3, 5, 7, 8, 10],            // aeolian, the natural minor
  "dorian": [0, 2, 3, 5, 7, 9, 10],           // minor with a raised sixth
  "phrygian": [0, 1, 3, 5, 7, 8, 10],         // the dark one, flat second
  "lydian": [0, 2, 4, 6, 7, 9, 11],           // major with a raised fourth
  "mixolydian": [0, 2, 4, 5, 7, 9, 10],       // major with a flat seventh
  "locrian": [0, 1, 3, 5, 6, 8, 10],          // diminished fifth; unstable
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "minor pentatonic": [0, 3, 5, 7, 10],
  "major pentatonic": [0, 2, 4, 7, 9],
  "blues": [0, 3, 5, 6, 7, 10],
  "whole tone": [0, 2, 4, 6, 8, 10],          // no tonic pull at all
};

/* 'F#4' -> 66. Throws on an unparseable name rather than guessing. */
export function midiOf(note) {
  const body = note.slice(0, -1);
  const octave = note.slice(-1);
  if (!(body in SEMITONE) || !/^\d$/.test(octave)) {
    throw new Error(`unparseable note name: ${note}`);
  }
  return (Number(octave) + 1) * 12 + SEMITONE[body];
}

/* 60 -> 'C4'. The inverse of midiOf. */
export function nameOf(midi) {
  return NOTE_NAMES[mod(midi, 12)] + (Math.floor(midi / 12) - 1);
}

/* 'F#' or 'F#4' -> 6. */
export function pitchClass(name) {
  const body = /\d$/.test(name) ? name.slice(0, -1) : name;
  if (!(body in SEMITONE)) {
    throw new Error(`unknown note ${name}; have ${NOTE_NAMES.join(", ")}`);
  }
  return SEMITONE[body];
}

export function get(mode) {
  if (!(mode in MODES)) {
    throw new Error(`unknown mode ${mode}; have ${Object.keys(MODES).join(", ")}`);
  }
  return MODES[mode];
}

/* Every MIDI pitch of `key` `mode` between low and high, ascending.
 *
 * Bounded by a range rather than counted in octaves, because the range is a
 * property of the sample set and the note count is not: a pentatonic yields
 * five notes per octave and a seven-note mode seven, and both should span the
 * same playable register. */
export function pitches(key, mode, low, high) {
  const steps = new Set(get(mode));
  const tonic = pitchClass(key);
  const out = [];
  for (let m = low; m <= high; m++) {
    if (steps.has(mod(m - tonic, 12))) out.push(m);
  }
  return out;
}

export function names(key, mode, low, high) {
  return pitches(key, mode, low, high).map(nameOf);
}

/* The MIDI span a drone octave can reach, given a semitone range.
 *
 * The widest a slot can go is the top pitch class of the octave plus the range,
 * and the narrowest is the bottom of it minus the range. Derived here rather
 * than at the call site, so the voice table and the drone pitches cannot end up
 * disagreeing about what is reachable. */
export function droneSpan(octave, [lo, hi]) {
  const base = (octave + 1) * 12;
  return [base + lo, base + 11 + hi];
}

/* MIDI pitches for the enabled drone slots.
 *
 * A slot is a semitone offset from the tonic placed in `octave`, so a fifth is
 * +7 in every mode and a drone can sit deliberately outside the scale.
 * Duplicates are dropped -- two slots on the same pitch would just be one drone
 * at double gain. */
export function dronePitches(key, octave, slots) {
  const base = (octave + 1) * 12 + pitchClass(key);
  const out = [];
  for (const slot of slots) {
    if (!slot.on) continue;
    const m = base + Math.trunc(slot.semitones);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}
