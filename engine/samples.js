/* The recordings, in the two forms they come in.
 *
 * A sustained note is *looped*: one recording covers a whole breath, because
 * the loop points let it run as long as the player blows. A struck one is not
 * -- a frame drum hit is over when it is over -- and what makes a struck
 * sample sound played rather than triggered is having several recordings of
 * the same stroke and not reaching for the same one twice running.
 *
 * So there are two pools here, and they differ in what indexes them.
 * `SampleSet` is indexed by *pitch*: hand it a MIDI note and it finds the
 * nearest recording and the cents to reach it. `StrokeSet` is indexed by
 * *stroke and force*: hand it "hit" at velocity 96 and it finds the layer
 * recorded at about that force, then picks a variation that is not the one it
 * picked last.
 *
 * Neither knows where its files came from. VCSL's own names are irregular --
 * HDrumL_Hit_v2_rr1_Sum, Mid_ShakerDouble_Down_rr1, Cabasa1_Rub_v1_rr2_Mid --
 * so which file is which stroke is decided once, in the build step, and
 * written into the manifest. Nothing at runtime parses a recording's name.
 */
import { midiOf } from "./scales.js";
import { round } from "./rng.js";

/* The one channel carrying recorded pitch from the build step to the runtime:
   `tools/loopfind.py` writes files named for the fingering it recorded. */
export const LOOP_SUFFIX = "_loop.wav";

// The manifest describes every pool the page can load. It is generated from
// the directories, so a bump here means `tools/manifest.py` moved too.
const MANIFEST_VERSION = 2;

/* What the WAV container says about itself: its rate, and its loop points if
 * it has any.
 *
 * `decodeAudioData` keeps `fmt ` and `data` and throws every other chunk away,
 * including `smpl`, so anything the loop was authored around has to be read
 * from the bytes before decoding or it is simply lost.
 *
 * The chunk table is walked properly rather than scanned for the four bytes
 * "smpl": that string can occur inside sample data, and a false hit would be
 * read as a loop.
 *
 * A one-shot has no `smpl` chunk and wants none, so a missing one is reported
 * as `loop: null` rather than as an error. Whether that is a problem is the
 * caller's question, and `readLoopPoints` below is the caller that says yes.
 */
function readSampleInfo(buffer) {
  const view = new DataView(buffer);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1),
                                         view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let sampleRate = null, loop = null;
  let pos = 12;
  while (pos + 8 <= view.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === "smpl") {
      // 9 uint32 of header, then 6 uint32 per loop; start and end are the
      // third and fourth words of the first loop.
      const loops = view.getUint32(body + 28, true);
      if (loops >= 1) {
        loop = [view.getUint32(body + 36 + 8, true),
                view.getUint32(body + 36 + 12, true)];
      }
    }
    pos = body + size + (size % 2);          // chunks are word-aligned
  }
  if (sampleRate === null) throw new Error("no fmt chunk");
  return {
    sampleRate,
    loop: loop === null ? null
        : { loopStartS: loop[0] / sampleRate, loopEndS: loop[1] / sampleRate },
  };
}

/* Loop points for a recording that has to have them.
 *
 * A buffer whose loop points went missing does not error on its own -- it
 * plays once and stops -- so a sustained voice that lost them is a drone that
 * quietly gives up a second in. This is where that becomes loud instead. */
export function readLoopPoints(buffer, name = "sample") {
  const info = readSampleInfo(buffer);
  if (info.loop === null) {
    throw new Error(`${name}: no smpl chunk, so no loop points`);
  }
  return { ...info.loop, sampleRate: info.sampleRate };
}

/* ---- the manifest --------------------------------------------------------
 *
 * The browser cannot list a directory, so the pools have to be handed to it.
 * Read through one parser rather than indexed field by field at each call
 * site: the page and the acceptance gate have to agree about what a pool is,
 * and a second reader is one edit away from disagreeing.
 */

const isStr = (v) => typeof v === "string" && v.length > 0;

export function parseManifest(json) {
  const fail = (why) => { throw new Error(`manifest: ${why}`); };
  if (!json || typeof json !== "object") fail("not an object");
  if (json.version !== MANIFEST_VERSION) {
    fail(`version ${json.version}, expected ${MANIFEST_VERSION}` +
         ` -- regenerate with tools/manifest.py`);
  }

  const loops = json.loops;
  if (!loops || !isStr(loops.dir) || !Array.isArray(loops.files)) {
    fail("loops must have a dir and a files list");
  }
  for (const f of loops.files) {
    if (!isStr(f) || !f.endsWith(LOOP_SUFFIX)) fail(`loop ${f} is not a ${LOOP_SUFFIX}`);
  }
  if (!loops.files.length) fail("no loops listed");

  const percussion = {};
  const pools = json.percussion ?? {};
  if (typeof pools !== "object") fail("percussion must be an object of pools");
  for (const [name, pool] of Object.entries(pools)) {
    if (!pool || !isStr(pool.dir) || !Array.isArray(pool.samples)) {
      fail(`pool ${name} must have a dir and a samples list`);
    }
    percussion[name] = new StrokeSet(name, pool.dir, pool.samples);
  }

  return {
    version: json.version,
    loops: {
      dir: loops.dir,
      files: loops.files.slice(),
      paths: loops.files.map((f) => `${loops.dir}/${f}`),
    },
    percussion,
  };
}

/* ---- pitched, looped ---------------------------------------------------- */

export class SampleSet {
  /* `files` is the list of authored loop names, e.g. ["C4_loop.wav", ...]. */
  constructor(files, offset) {
    this.offset = Math.trunc(offset);
    this.byPitch = new Map();
    for (const name of files) {
      const written = name.slice(0, -LOOP_SUFFIX.length);
      this.byPitch.set(midiOf(written) + this.offset, name);
    }
    if (!this.byPitch.size) throw new Error("no loops in the manifest");
    this.pitches = [...this.byPitch.keys()].sort((a, b) => a - b);
  }

  /* [filename, cents] -- the nearest recording, and the shift to reach `midi`.
   *
   * The recordings are whole-tone spaced, so any pitch inside the recorded span
   * is at most 100 cents from one of them. Outside the span the shift grows by
   * an octave at a time, which is what lets a drone sit far below anything
   * anyone played. */
  voiceFor(midi) {
    let best = this.pitches[0];
    for (const p of this.pitches) {
      const d = Math.abs(p - midi) - Math.abs(best - midi);
      if (d < 0) best = p;
    }
    return [this.byPitch.get(best), (midi - best) * 100];
  }
}

/* ---- struck, one-shot, several of each ---------------------------------- */

export class StrokeSet {
  /* One percussion instrument: its strokes, the force layers each was
   * recorded at, and the variations inside a layer.
   *
   * `samples` is a flat list of {file, stroke, level, variant} -- flat because
   * the index below is derived from it, and a nested manifest would be a
   * second copy of a shape that can be computed. */
  constructor(name, dir, samples) {
    const fail = (why) => { throw new Error(`pool ${name}: ${why}`); };
    if (!Array.isArray(samples) || !samples.length) fail("no samples");
    this.name = name;
    this.dir = dir;

    this._byStroke = new Map();          // stroke -> level -> [path]
    this._measured = new Map();          // path -> what the build step measured
    const loudness = new Map();          // path -> body level, dB
    const strokeOf = new Map();          // path -> stroke
    for (const s of samples) {
      if (!s || !isStr(s.file) || !isStr(s.stroke)) {
        fail("every sample needs a file and a stroke");
      }
      if (!Number.isFinite(Number(s.level))) fail(`${s.file} has no numeric level`);
      if (!Number.isFinite(Number(s.loudness_db))) {
        fail(`${s.file} has no loudness_db -- regenerate with tools/manifest.py`);
      }
      const level = Number(s.level);
      if (!this._byStroke.has(s.stroke)) this._byStroke.set(s.stroke, new Map());
      const layers = this._byStroke.get(s.stroke);
      if (!layers.has(level)) layers.set(level, []);
      const path = `${dir}/${s.file}`;
      layers.get(level).push(path);
      loudness.set(path, Number(s.loudness_db));
      strokeOf.set(path, s.stroke);
      this._measured.set(path, { stroke: s.stroke, level,
                                 loudnessDb: Number(s.loudness_db),
                                 peak: Number(s.peak) });
    }
    // Sorted, so which variation a seed reaches does not depend on the order
    // the build step happened to walk the directory in.
    for (const layers of this._byStroke.values()) {
      for (const paths of layers.values()) paths.sort();
    }
    this.strokes = [...this._byStroke.keys()].sort();
    this._gain = this._level(loudness, strokeOf);
  }

  /* A playback gain per recording, bringing every recording of one stroke to
   * a common loudness. Not a change to the files: they keep the levels the
   * pool was normalised to, and this is applied when one is struck.
   *
   * Two things were making velocity a staircase rather than a ramp, and both
   * are level differences that were never meant to carry meaning.
   *
   * Across layers: VCSL recorded the frame drum at two forces about 15 dB
   * apart in body level, and `pick` crosses between them at the middle of the
   * velocity range, so velocity 63 and velocity 65 differed by 15 dB.
   *
   * Within a layer: the two round-robin takes of one stroke differ by up to
   * 5.4 dB, which is larger than a whole step of the velocity curve. Two
   * strikes at the *same* velocity would land 5 dB apart, and a sweep came out
   * non-monotone -- measurably, velocity 32 sounded quieter than velocity 24.
   *
   * Neither is dynamics. Dynamics are supplied continuously by the velocity
   * curve the caller applies. What a layer is worth is its *timbre* -- a hard
   * strike is brighter and rings longer -- and what a round robin is worth is
   * that no two onsets are identical. Both survive levelling untouched;
   * only the accident of how loud the take happened to be does not.
   *
   * Levelling is within a stroke, never across strokes. A muted hit really is
   * quieter than an open one, and flattening that would erase the difference
   * between two strokes rather than between two takes of one.
   *
   * The reference is the loudest recording, so quieter ones are boosted.
   * Measured on the frame drum: the takes being lifted carry 39-43 dB of
   * signal to noise, and a boost moves signal and noise together, so they
   * still carry 39-43 dB afterwards.
   */
  _level(loudness, strokeOf) {
    const ref = new Map();
    for (const [path, db] of loudness) {
      const stroke = strokeOf.get(path);
      ref.set(stroke, Math.max(ref.get(stroke) ?? -Infinity, db));
    }
    const gain = new Map();
    for (const [path, db] of loudness) {
      gain.set(path, Math.pow(10, (ref.get(strokeOf.get(path)) - db) / 20));
    }
    return gain;
  }

  /* What the build step measured for one recording: its body level and its
     peak. Held here so nothing else has to open the manifest a second way to
     find out how loud a recording is. */
  measured(path) {
    const m = this._measured.get(path);
    if (m === undefined) throw new Error(`pool ${this.name}: no recording ${path}`);
    return m;
  }

  /* The levelling gain for one recording. */
  gainFor(path) {
    const g = this._gain.get(path);
    if (g === undefined) throw new Error(`pool ${this.name}: no recording ${path}`);
    return g;
  }

  /* Every file this pool can reach, so the page loads only what it needs. */
  files() {
    const out = new Set();
    for (const layers of this._byStroke.values()) {
      for (const paths of layers.values()) for (const p of paths) out.add(p);
    }
    return [...out].sort();
  }

  /* The force layers a stroke was recorded at, softest first. */
  levels(stroke) {
    const layers = this._byStroke.get(stroke);
    if (!layers) {
      throw new Error(`pool ${this.name} has no stroke ${stroke}; ` +
                      `have ${this.strokes.join(", ")}`);
    }
    return [...layers.keys()].sort((a, b) => a - b);
  }

  /* How many variations back a given stroke and layer. */
  variants(stroke, level) {
    return this._byStroke.get(stroke).get(level).length;
  }

  /* One recording of `stroke` at `velocity` (0-127), as {path, level, gain}.
   *
   * `last` is the path this caller used for this stroke previously. It is
   * passed in rather than remembered here because a pool is shared by every
   * performance built from one manifest, and where a round robin has got to is
   * a fact about a performance -- kept here, two players would deal each other
   * their takes and a seed would stop naming one performance.
   *
   * The layer is found by spreading the recorded layers evenly across the
   * velocity range rather than by reading the numbers VCSL used: the frame
   * drum has layers 2 and 3 and no layer 1, so anything keyed on the recorded
   * number would leave the bottom of the range unplayable.
   *
   * The variation is drawn from that layer excluding the one used last, which
   * is the whole point of a round robin -- two identical onsets in a row is
   * the sound of a sampler rather than a player. Where a layer holds two
   * recordings that is strict alternation; where it holds more it is a walk
   * that never repeats itself immediately.
   */
  pick(stroke, velocity, rng, last = null) {
    const layers = this.levels(stroke);
    const v = Math.max(0, Math.min(127, Number(velocity)));
    if (!Number.isFinite(v)) throw new Error(`velocity ${velocity} is not a number`);
    const level = layers[round((v / 127) * (layers.length - 1))];
    const paths = this._byStroke.get(stroke).get(level);
    const choices = paths.length > 1 ? paths.filter((p) => p !== last) : paths;
    const path = rng.choice(choices);
    return { path, stroke, level, gain: this.gainFor(path) };
  }

}
