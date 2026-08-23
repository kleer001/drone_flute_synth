/* Acceptance gate for the music engine.
 *
 *     node check.mjs [--key C] [--mode minor] [--mood contemplative]
 *
 * The sister of `tools/loop_qa.py`: that one gates the samples, this one gates
 * the performance. Neither opens an audio device, because neither needs to --
 * what is being checked is a plan, and a plan is data.
 *
 * A breath is compared whole rather than by its note names alone. Two
 * performances that name the same pitches but place them differently in the bar
 * are different performances, and a gate that could not tell them apart would
 * pass a timing regression without noticing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Instrument } from "./engine/instrument.js";
import { noteSequence } from "./engine/breath.js";
import { rasterize, MIN_ONSET_GAP_S } from "./engine/melody.js";
import { LOOP_SUFFIX, parseManifest } from "./engine/samples.js";
import { Rng } from "./engine/rng.js";
import * as scales from "./engine/scales.js";

const BREATHS = 60;
const MANIFEST = "manifest.json";
const LOOPS_DIR = "loops";
const STROKES_DIR = "strokes";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function render(b) {
  const notes = b.notes.map((n) =>
    `${n.name}@${n.start_s.toFixed(6)}+${n.dur_s.toFixed(6)}` +
    `v${n.velocity}${n.grace ? "g" : ""}`).join(" ");
  return `${b.index} ${b.length_s.toFixed(6)} ${b.inhale_s.toFixed(6)} ` +
         `${b.drones.join(",")} | ${notes}`;
}

function perform(manifest, opts) {
  const inst = new Instrument(manifest, opts);
  const lines = [], sequences = [];
  for (let i = 0; i < BREATHS; i++) {
    const b = inst.nextBreath();
    lines.push(render(b));
    sequences.push(noteSequence(b.notes));
  }
  return { lines, sequences };
}

// Read the manifest, because that is what the page reads. Scanning the
// directories instead would make this gate blind to the one failure the
// manifest exists to prevent -- a recording on disk the page never learns
// about, or one listed that is not there.
let manifest;
try {
  manifest = parseManifest(JSON.parse(readFileSync(MANIFEST, "utf8")));
} catch (e) {
  console.error(`cannot read ${MANIFEST} (${e.message}). ` +
                `Run tools/manifest.py, or ./run.sh --rebuild.`);
  process.exit(2);
}
const files = manifest.loops.files;
const pools = Object.entries(manifest.percussion);

const listOf = (dir, keep) =>
  existsSync(dir) ? readdirSync(dir).filter(keep).map((f) => `${dir}/${f}`) : [];
const onDisk = [
  ...listOf(LOOPS_DIR, (f) => f.endsWith(LOOP_SUFFIX)),
  ...listOf(STROKES_DIR, (f) => f.endsWith(".wav")),
];
const listed = [
  ...manifest.loops.paths,
  ...pools.flatMap(([, pool]) => pool.files()),
];

const key = arg("key", "C"), mode = arg("mode", "minor");
const mood = arg("mood", "contemplative");
const strokeCount = pools.reduce((n, [, p]) => n + p.files().length, 0);
console.log(`samples : ${files.length} loops from ${LOOPS_DIR}, ` +
            `${strokeCount} one-shots in ${pools.length} pools from ${STROKES_DIR}`);
console.log(`key     : ${key} ${mode}`);
console.log(`mood    : ${mood}, ${BREATHS} breaths\n`);

const a = perform(manifest, { mood, seed: 1234, key, mode });
const b = perform(manifest, { mood, seed: 1234, key, mode });
const c = perform(manifest, { mood, seed: 5678, key, mode });

const failures = [];
const same = (x, y) => x.lines.join("\n") === y.lines.join("\n");

// The manifest is generated; a stale one is a note the page silently loses.
const missing = onDisk.filter((f) => !listed.includes(f));
const phantom = listed.filter((f) => !onDisk.includes(f));
if (!missing.length && !phantom.length) {
  console.log(`PASS  manifest: lists all ${onDisk.length} recordings on disk`);
} else {
  const why = [missing.length ? `${missing.join(", ")} on disk but unlisted` : "",
               phantom.length ? `${phantom.join(", ")} listed but absent` : ""]
    .filter(Boolean).join("; ");
  failures.push(`manifest: ${why}`);
  console.log(`FAIL  manifest: ${why}`);
}

if (same(a, b)) {
  const chars = a.lines.reduce((n, l) => n + l.length, 0);
  console.log(`PASS  criterion 5: same seed -> identical performance (${chars} chars compared)`);
} else {
  const i = a.lines.findIndex((l, k) => l !== b.lines[k]);
  failures.push(`criterion 5: seed 1234 diverged at breath ${i}`);
  console.log(`FAIL  criterion 5: diverged at breath ${i}`);
}

if (!same(a, c)) {
  console.log("PASS  criterion 5b: a different seed performs differently");
} else {
  failures.push("criterion 5b: seeds 1234 and 5678 performed alike");
  console.log("FAIL  criterion 5b");
}

let repeats = 0;
for (let i = 1; i < a.sequences.length; i++) {
  if (a.sequences[i] === a.sequences[i - 1]) repeats++;
}
if (repeats === 0) {
  console.log(`PASS  criterion 6: no two consecutive breaths identical (${a.sequences.length} breaths)`);
} else {
  failures.push(`criterion 6: ${repeats} consecutive repeats`);
  console.log(`FAIL  criterion 6: ${repeats} consecutive repeats`);
}

// Every key, scale and octave has to yield a playable list, and every note in
// it has to have a voice. A note the voice table does not cover is not an
// error -- it is `undefined` reaching an AudioParam several layers down.
let combos = 0, worstTune = 0, bad = [];
const probe = new Instrument(manifest, { mood, seed: 7, key: "C", mode: "minor" });
const [octLo, octHi] = probe.describe().ranges.lead_octave;
for (const k of scales.NOTE_NAMES) {
  for (const m of Object.keys(scales.MODES)) {
    for (let o = octLo; o <= octHi; o++) {
      const shift = 12 * o;
      const names = scales.names(k, m, probe.leadLow + shift, probe.leadHigh + shift);
      if (!names.length) { bad.push(`${k} ${m} oct ${o} is empty`); continue; }
      for (const n of names) {
        // Read the voice table the page is handed, not the lookup behind it.
        const v = probe.voices[n];
        if (!v) { bad.push(`${k} ${m} oct ${o}: no voice for ${n}`); continue; }
        if (o === 0) worstTune = Math.max(worstTune, Math.abs(v.cents));
      }
      combos++;
    }
  }
}
if (!bad.length) {
  console.log(`PASS  coverage: ${combos} key/scale/octave combinations all voiced, ` +
              `worst shift ${worstTune.toFixed(0)} cents at the recorded octave`);
} else {
  failures.push(`coverage: ${bad.length} broken: ${bad.slice(0, 3).join("; ")}`);
  console.log(`FAIL  coverage: ${bad.slice(0, 3).join("; ")}`);
}

// The rasterizer may thin decoration but must never touch the tune, and must
// leave nothing stacked on the same instant.
let tooClose = 0, breaths = 0;
const raster = new Instrument(manifest, { mood, seed: 99, key: "C", mode: "minor" });
for (let i = 0; i < 200; i++) {
  const b = raster.nextBreath();
  breaths++;
  for (let k = 1; k < b.notes.length; k++) {
    if (b.notes[k].start_s - b.notes[k - 1].start_s < MIN_ONSET_GAP_S - 1e-9) tooClose++;
  }
}
// and directly: structural notes survive the pass untouched
const N = (start, grace) => ({ startS: start, isGrace: grace, name: "x" });
const pile = [N(0, false), N(0, true), N(0.01, true), N(0.02, false), N(0.5, true)];
const survived = rasterize(pile).filter((n) => !n.isGrace).length;
if (!tooClose && survived === 2) {
  console.log(`PASS  rasterize: ${breaths} breaths, no onsets closer than ` +
              `${(MIN_ONSET_GAP_S * 1000).toFixed(0)}ms, structural notes never dropped`);
} else {
  const why = tooClose ? `${tooClose} onsets too close` : `dropped a structural note`;
  failures.push(`rasterize: ${why}`);
  console.log(`FAIL  rasterize: ${why}`);
}

// A rejected parameter set must change nothing.
const guard = new Instrument(manifest, { mood, seed: 3, key: "C", mode: "minor" });
const before = JSON.stringify(guard.params);
let refused = false;
try { guard.update({ bpm: 999 }); } catch { refused = true; }
if (refused && JSON.stringify(guard.params) === before) {
  console.log("PASS  validation: an out-of-range value is refused and nothing is applied");
} else {
  failures.push("validation: a bad set was accepted or partially applied");
  console.log("FAIL  validation");
}

// ---- percussion --------------------------------------------------------
//
// A pool is not a scale: nothing here is derived by arithmetic, so what has to
// be checked is that every stroke can actually be reached, that a round robin
// really rotates, and above all that reaching for one cannot disturb the tune.
if (!pools.length) {
  console.log("SKIP  percussion: no pools authored (run tools/oneshot.py)");
} else {
  // Every stroke, at every velocity, returns a recording the pool owns.
  const unreachable = [];
  for (const [name, pool] of pools) {
    const own = new Set(pool.files());
    for (const stroke of pool.strokes) {
      for (let v = 0; v <= 127; v += 1) {
        const { path } = pool.pick(stroke, v, new Rng(v + 1));
        if (!own.has(path)) unreachable.push(`${name}/${stroke} v${v} -> ${path}`);
      }
    }
  }
  // What the instrument says it needs and what the pools hold are the same
  // set, or the page would fetch a file nothing plays -- or miss one it does.
  const reachable = probe.strokeFiles().join(" ");
  const authored = pools.flatMap(([, pool]) => pool.files()).sort().join(" ");
  if (reachable !== authored) unreachable.push("strokeFiles() disagrees with the pools");

  if (!unreachable.length) {
    const strokes = pools.reduce((n, [, p]) => n + p.strokes.length, 0);
    console.log(`PASS  pools: ${strokes} strokes across ${pools.length} pools, ` +
                `every velocity 0-127 voiced, all ${probe.strokeFiles().length} files reachable`);
  } else {
    failures.push(`pools: ${unreachable.length} unreachable: ${unreachable[0]}`);
    console.log(`FAIL  pools: ${unreachable[0]}`);
  }

  // The softest velocity reaches the softest layer and the loudest the
  // loudest, or a recorded layer is one nothing can ever ask for.
  const unusedLayers = [];
  for (const [name, pool] of pools) {
    for (const stroke of pool.strokes) {
      const layers = pool.levels(stroke);
      const lo = pool.pick(stroke, 0, new Rng(1)).level;
      const hi = pool.pick(stroke, 127, new Rng(1)).level;
      if (lo !== layers[0] || hi !== layers[layers.length - 1]) {
        unusedLayers.push(`${name}/${stroke}: 0->${lo}, 127->${hi}, have ${layers.join(",")}`);
      }
    }
  }
  if (!unusedLayers.length) {
    console.log("PASS  layers: velocity 0 and 127 reach the softest and loudest recorded layer");
  } else {
    failures.push(`layers: ${unusedLayers[0]}`);
    console.log(`FAIL  layers: ${unusedLayers[0]}`);
  }

  // A round robin that can repeat is not one. Two identical onsets running is
  // the sound of a sampler rather than a player, which is the whole reason
  // several recordings of one stroke were authored.
  const repeated = [];
  for (const [name, pool] of pools) {
    for (const stroke of pool.strokes) {
      for (const level of pool.levels(stroke)) {
        if (pool.variants(stroke, level) < 2) continue;
        const rng = new Rng(4242);
        // Velocity that lands on this layer, so the draw exercises it.
        const layers = pool.levels(stroke);
        const v = Math.round((layers.indexOf(level) / Math.max(1, layers.length - 1)) * 127);
        let last = null;
        for (let i = 0; i < 200; i++) {
          const { path } = pool.pick(stroke, v, rng);
          if (path === last) { repeated.push(`${name}/${stroke} l${level}`); break; }
          last = path;
        }
      }
    }
  }
  if (!repeated.length) {
    console.log("PASS  round robin: 200 strikes, no recording used twice running");
  } else {
    failures.push(`round robin: ${repeated[0]} repeated`);
    console.log(`FAIL  round robin: ${repeated[0]} repeated`);
  }

  // The one that decides whether percussion can be added at all: it draws from
  // its own stream, so striking must not consume a number the phrase generator
  // was going to use. If this fails, turning a drum on rewrites the melody and
  // a seed no longer names one performance.
  const [poolName, poolSet] = pools[0];
  const stroke = poolSet.strokes[0];
  const plain = new Instrument(manifest, { mood, seed: 31337, key, mode });
  const struck = new Instrument(manifest, { mood, seed: 31337, key, mode });
  const quiet = [], loud = [], hits = [];
  for (let i = 0; i < 40; i++) {
    quiet.push(noteSequence(plain.nextBreath().notes));
    const b = struck.nextBreath();
    // Strike as often as a rhythm layer would, between planning breaths.
    for (let k = 0; k < 8; k++) hits.push(struck.strike(poolName, stroke, 40 + 8 * k).path);
    loud.push(noteSequence(b.notes));
  }
  const undisturbed = quiet.join("|") === loud.join("|");
  // and the strikes themselves reproduce from the seed
  const again = new Instrument(manifest, { mood, seed: 31337, key, mode });
  const hits2 = [];
  for (let i = 0; i < 40; i++) {
    again.nextBreath();
    for (let k = 0; k < 8; k++) hits2.push(again.strike(poolName, stroke, 40 + 8 * k).path);
  }
  const reproducible = hits.join(" ") === hits2.join(" ");
  if (undisturbed && reproducible) {
    console.log(`PASS  streams: ${hits.length} strikes changed no note of 40 breaths, ` +
                `and reproduced from the seed`);
  } else {
    const why = !undisturbed ? "striking altered the melody"
                             : "strikes did not reproduce from the seed";
    failures.push(`streams: ${why}`);
    console.log(`FAIL  streams: ${why}`);
  }
}

console.log();
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("engine-side acceptance criteria pass");
