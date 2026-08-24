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
import { rhythm, cycleUnits, washStroke, DRUM_POOL, RATTLE_POOL, WASH_POOL,
         DRUM_POOLS, RATTLE_POOLS, WASH_POOLS,
         WASH_MIN_GAP, WASH_VELOCITY } from "./percussion.js";

// The drone sits under the lead rather than beside it.
const VOICE_GAIN = { drone: 0.85, lead: 1.0 };

/* Percussion draws from its own random stream, not the melody's.
 *
 * Sharing one would mean that striking a drum consumed a number the phrase
 * generator was going to use, so turning percussion on would rewrite the tune
 * -- and a seed would no longer name one performance. The constant is
 * arbitrary; all it has to do is be one, so that the two streams are
 * reproducible from the same seed without ever being the same stream. */
const STRIKE_SEED_OFFSET = 0x5f356495;
// Likewise for the song arrangement, so toggling song mode does not change
// what the breaths themselves are.
const SONG_SEED_OFFSET = 0x2545f491;

export class Instrument {
  /* `manifest` is what `samples.parseManifest` returned: the loops, and the
     percussion pools if any have been authored. */
  constructor(manifest, { mood = "contemplative", seed = 1,
                          key = "C", mode = "minor",
                          song = false, songBlocks = 3, songRepeats = 2,
                          drum = false, rattle = false, wash = false } = {}) {
    this.loopDir = manifest.loops.dir;
    this.percussion = manifest.percussion ?? {};
    this.samples = new SampleSet(manifest.loops.files, INSTRUMENT.soundingOffset);
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
      song: song === true,
      song_blocks: Math.trunc(songBlocks),
      song_repeats: Math.trunc(songRepeats),
      drum: drum === true,
      rattle: rattle === true,
      wash: wash === true,
      drum_pool: DRUM_POOL,
      rattle_pool: RATTLE_POOL,
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
      // The path rather than the bare name, so a voice and a stroke are
      // addressed the same way and the page can key one table by both.
      out[scales.nameOf(m)] = { file: `${this.loopDir}/${file}`, cents };
    }
    return out;
  }

  /* Which files the voices actually reference, so the page loads only those. */
  loopFiles() {
    return [...new Set(Object.values(this.voices).map((v) => v.file))];
  }

  /* The pools the rhythm layers are currently set to. */
  get pools() {
    return { drum: this.params.drum_pool, rattle: this.params.rattle_pool,
             wash: WASH_POOL };
  }

  /* Which pools each layer could be set to: known to the stroke tables, and
     actually authored in this manifest. */
  get poolChoices() {
    const have = (names) => names.filter((n) => n in this.percussion);
    return { drum_pool: have(DRUM_POOLS), rattle_pool: have(RATTLE_POOLS),
             wash_pool: have(WASH_POOLS) };
  }

  /* Every file the layers that are switched on can reach. Switching a layer
     on or changing its pool changes this, so the page fetches what a submitted
     set needs before applying it rather than loading every pool up front. */
  strokeFiles() {
    const p = this.params;
    const want = [];
    if (p.drum === true) want.push(p.drum_pool);
    if (p.rattle === true) want.push(p.rattle_pool);
    if (p.wash === true) want.push(WASH_POOL);
    return this.poolFiles(want);
  }

  poolFiles(names) {
    const out = new Set();
    for (const name of names) {
      const pool = this.percussion[name];
      if (!pool) continue;
      for (const f of pool.files()) out.add(f);
    }
    return [...out].sort();
  }

  /* One recording of a stroke: {path, stroke, level}.
   *
   * The pool decides which force layer and which variation, because that is a
   * fact about what was recorded; this only supplies the stream it draws
   * from. */
  strike(pool, stroke, velocity) {
    const set = this.percussion[pool];
    if (!set) {
      const have = Object.keys(this.percussion).sort().join(", ") || "none";
      throw new Error(`no percussion pool ${pool}; have ${have}`);
    }
    const key = `${pool}|${stroke}`;
    const hit = set.pick(stroke, velocity, this._strikes, this._lastTake.get(key));
    this._lastTake.set(key, hit.path);
    return hit;
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
      // A new seed means "play something else", and that has to include which
      // recordings the percussion reaches for.
      this._strikes = new Rng(Math.trunc(p.seed) ^ STRIKE_SEED_OFFSET);
      this._songRng = new Rng(Math.trunc(p.seed) ^ SONG_SEED_OFFSET);
      this._clock = 0;
      this._lastTake = new Map();
      this._lastWash = -Infinity;
      this.performer = new Performer(
        INSTRUMENT, mood, new Rng(Math.trunc(p.seed)),
        lead, drones, root, p.breath_spread_s, p.inhale_s, this._song());
    } else {
      this.performer.retune({
        mood, root, leadNotes: lead, droneNotes: drones,
        breathSpreadS: p.breath_spread_s, inhaleS: p.inhale_s,
        song: this._song() });
    }
  }

  _song() {
    const p = this.params;
    return { on: p.song === true, blocks: Math.trunc(p.song_blocks),
             repeats: Math.trunc(p.song_repeats), rng: this._songRng };
  }

  /* Apply a partial parameter change. Throws on a bad set, changing nothing. */
  update(changes) {
    const unknown = Object.keys(changes).filter((k) => !(k in this.params));
    if (unknown.length) {
      throw new Error(`unknown parameter(s): ${unknown.sort().join(", ")}`);
    }
    const merged = { ...this.params, ...changes };
    const errors = moods.validateParams(merged);
    // Which pools exist is a fact about the manifest, so it is checked here
    // rather than in `moods`, which has never seen one.
    const choices = this.poolChoices;
    for (const field of ["drum_pool", "rattle_pool"]) {
      if (!choices[field].includes(merged[field])) {
        errors[field] = `must be one of ${choices[field].join(", ") || "none authored"}`;
      }
    }
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
      rhythm_fields: moods.RHYTHM_FIELDS,
      weight_fields: moods.WEIGHT_FIELDS,
      pools: this.pools,
      pool_choices: this.poolChoices,
      moods: Object.keys(moods.MOODS).sort(),
      preset_weights: moods.presetWeights(),
      keys: scales.NOTE_NAMES,
      modes: Object.keys(scales.MODES),
      drone_slots: moods.DRONE_SLOTS,
      drone_semitones: moods.DRONE_SEMITONES,
      meter: { bpm: meter.bpm, beats_per_measure: meter.beatsPerMeasure,
               beat_s: meter.beatS, measure_s: meter.measureS },
      voices: this.voices,
      // What was recorded for each pool: its strokes, the force layers each
      // was captured at, and how many variations back a layer. The page needs
      // this to build a control before it has loaded a single sample.
      percussion: Object.fromEntries(Object.entries(this.percussion)
        .map(([name, pool]) => [name, pool.describe()])),
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
    const p = this.params;
    const meter = this.performer.meter;
    const layers = rhythm({
      motif: plan.motif, notes: plan.melodyNotes, meter,
      lengthS: plan.lengthS, inhaleS: plan.inhaleS, clock: this._clock,
      drum: p.drum === true && !!this.percussion[p.drum_pool],
      rattle: p.rattle === true && !!this.percussion[p.rattle_pool],
      drumDensity: Number(p.drum_density), rattleScale: Math.trunc(p.rattle_scale),
      drumPool: p.drum_pool, rattlePool: p.rattle_pool,
    });
    this._clock += cycleUnits(meter, plan.lengthS, plan.inhaleS);
    layers.wash = this._wash(plan.index);
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
      // The pattern is decided here; which recording sounds it is drawn from
      // the strike stream, so a repeated block drums the same figure without
      // playing the same takes.
      pulses: {
        drum: layers.drum.map((h) => this._voiceStrike(p.drum_pool, h)),
        rattle: layers.rattle.map((h) => this._voiceStrike(p.rattle_pool, h)),
        wash: layers.wash.map((h) => this._voiceStrike(WASH_POOL, h)),
      },
    };
  }

  /* At most one wash, and rarely. It is a texture rather than a pulse: eight
     seconds of grains that outlast the breath they start in, so two close
     together read as one smear. */
  _wash(index) {
    const p = this.params;
    if (p.wash !== true || !this.percussion[WASH_POOL]) return [];
    if (index - this._lastWash < WASH_MIN_GAP) return [];
    if (this._strikes.random() >= Number(p.wash_rate)) return [];
    this._lastWash = index;
    return [{ startS: 0, stroke: washStroke(WASH_POOL), velocity: WASH_VELOCITY }];
  }

  _voiceStrike(pool, hit) {
    const { path, gain } = this.strike(pool, hit.stroke, hit.velocity);
    return { start_s: hit.startS, stroke: hit.stroke,
             velocity: hit.velocity, file: path, gain };
  }
}
