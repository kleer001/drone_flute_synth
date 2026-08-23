/* One performance, and the parameter set that shapes it.
 *
 * This is the seam the page talks to. It owns the parameters, validates a whole
 * set at once, and hands out one breath at a time. It knows nothing about Web
 * Audio: a breath is data, and turning it into sound is the page's job.
 */
import { Performer, VELOCITY, BREATH_ATTACK_S,
         BREATH_RELEASE_S } from "./breath.js";
import { Rng } from "./rng.js";
import { SampleSet } from "./samples.js";
import { INSTRUMENT } from "./profile.js";
import * as moods from "./moods.js";
import * as scales from "./scales.js";

// The drone sits under the lead rather than beside it.
const VOICE_GAIN = { drone: 0.85, lead: 1.0 };

export class Instrument {
  constructor(files, { mood = "contemplative", seed = 1,
                       key = "C", mode = "minor" } = {}) {
    this.samples = new SampleSet(files, INSTRUMENT.soundingOffset);
    this.leadLow = scales.midiOf(INSTRUMENT.leadLow);
    this.leadHigh = scales.midiOf(INSTRUMENT.leadHigh);

    // Every pitch the instrument can reach, voiced once at startup: the sample
    // set is fixed, so which recording serves which pitch cannot change.
    this.voices = this._readVoices();

    const preset = moods.get(mood);
    this.params = { ...moods.presetWeights()[preset.name] };
    Object.assign(this.params, {
      mood: preset.name,
      seed: Math.trunc(seed),
      key, mode,
      lead_octave: 0,
      drones: moods.defaultDrones(),
      breath_spread_s: INSTRUMENT.breathSpreadS,
      inhale_s: INSTRUMENT.inhaleS,
    });
    this._apply(true);
  }

  /* {note: {file, cents}} for every pitch the instrument can reach.
   *
   * One flat table rather than one per chamber: with key and mode as controls,
   * which pitches are lead and which are drone changes with the settings, but
   * how a pitch is *voiced* never does. */
  _readVoices() {
    const [droneLow, droneHigh] =
      scales.droneSpan(INSTRUMENT.droneOctave, moods.DRONE_SEMITONES);
    // Voiced once, so the table has to cover every octave the lead can be
    // shifted to, not just the one it starts in.
    const [octLo, octHi] = moods.NUMERIC_PARAMS.lead_octave;
    const low = Math.min(this.leadLow + 12 * octLo, droneLow);
    const high = Math.max(this.leadHigh + 12 * octHi, droneHigh);
    const out = {};
    for (let m = low; m <= high; m++) {
      const [file, cents] = this.samples.voiceFor(m);
      out[scales.nameOf(m)] = { file, cents };
    }
    return out;
  }

  /* Which files the voices actually reference, so the page loads only those. */
  loopFiles() {
    return [...new Set(Object.values(this.voices).map((v) => v.file))];
  }

  /* [lead note names, drone note names, tonic] for the current key and mode. */
  _notes() {
    const p = this.params;
    const shift = 12 * Math.trunc(p.lead_octave);
    const lead = scales.names(p.key, p.mode,
                              this.leadLow + shift, this.leadHigh + shift);
    const drones = scales.dronePitches(p.key, INSTRUMENT.droneOctave, p.drones)
                         .map(scales.nameOf);
    // The tonic anchors stability, and it only has to name the right pitch
    // class -- `stability` folds the interval into an octave.
    const root = `${p.key}${INSTRUMENT.droneOctave}`;
    return [lead, drones, root];
  }

  /* Hand the current parameters to the performer.
   *
   * `restart` builds a fresh one, which replays the random stream from the top
   * and discards the motif under development; otherwise the performer is
   * retuned in place and keeps where it is. Both paths derive the same things
   * from the same parameters, so they share this. */
  _apply(restart) {
    const p = this.params;
    const [lead, drones, root] = this._notes();
    const mood = moods.fromWeights(p.mood, p);
    if (restart) {
      this.performer = new Performer(
        INSTRUMENT, mood, new Rng(Math.trunc(p.seed)),
        lead, drones, root, p.breath_spread_s, p.inhale_s);
    } else {
      this.performer.retune({
        mood, root, leadNotes: lead, droneNotes: drones,
        breathSpreadS: p.breath_spread_s, inhaleS: p.inhale_s });
    }
  }

  /* Apply a partial parameter change. Throws on a bad set, changing nothing. */
  update(changes) {
    const unknown = Object.keys(changes).filter((k) => !(k in this.params));
    if (unknown.length) {
      throw new Error(`unknown parameter(s): ${unknown.sort().join(", ")}`);
    }
    const merged = { ...this.params, ...changes };
    const errors = moods.validateParams(merged);
    const keys = Object.keys(errors).sort();
    if (keys.length) {
      throw new Error(keys.map((k) => `${k}: ${errors[k]}`).join("; "));
    }
    // A new seed means "play something else", so it starts over. Everything
    // else reshapes the performance from where it is. Either way the breaths
    // already scheduled play out.
    const restart = Math.trunc(merged.seed) !== Math.trunc(this.params.seed);
    this.params = merged;
    this._apply(restart);
    return this.describe();
  }

  describe() {
    const meter = this.performer.meter;
    return {
      profile: INSTRUMENT.display,
      provenance: INSTRUMENT.provenance,
      sampleNote: INSTRUMENT.sampleNote,
      params: structuredClone(this.params),
      ranges: moods.NUMERIC_PARAMS,
      mood_weights: moods.MOOD_WEIGHTS,
      breath_fields: moods.BREATH_FIELDS,
      moods: Object.keys(moods.MOODS).sort(),
      preset_weights: moods.presetWeights(),
      keys: scales.NOTE_NAMES,
      modes: Object.keys(scales.MODES),
      drone_slots: moods.DRONE_SLOTS,
      drone_semitones: moods.DRONE_SEMITONES,
      meter: { bpm: meter.bpm, beats_per_measure: meter.beatsPerMeasure,
               beat_s: meter.beatS, measure_s: meter.measureS },
      voices: this.voices,
      // The breath envelope belongs to the breath, not to the page, so the
      // numbers come from there rather than being restated in the audio graph.
      attack_s: BREATH_ATTACK_S,
      release_s: BREATH_RELEASE_S,
      voice_gain: VOICE_GAIN,
    };
  }

  /* Plan one breath. Advances the performance -- asking twice gets two
     different breaths, which is what an endless performance means. */
  nextBreath() {
    const plan = this.performer.nextBreath();
    return {
      index: plan.index,
      length_s: plan.lengthS,
      inhale_s: plan.inhaleS,
      bars: plan.bars,
      role: plan.role,
      drones: plan.droneNotes.slice(),
      drone_velocity: VELOCITY,
      notes: plan.melodyNotes.map((n) => ({
        name: n.name, start_s: n.startS, dur_s: n.durS,
        velocity: n.velocity, grace: n.isGrace })),
    };
  }
}
