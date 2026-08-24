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
import { BLOCK_BREATHS } from "./engine/song.js";
import { WASH_MIN_GAP } from "./engine/percussion.js";
import { Rng, round } from "./engine/rng.js";
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
/* Every gate says the same two things in the same two ways, and said them
   twice each -- once into `failures`, once to the console. */
const gate = (name, ok, pass, why) => {
  if (ok) { console.log(`PASS  ${name}: ${pass}`); return; }
  failures.push(`${name}: ${why}`);
  console.log(`FAIL  ${name}: ${why}`);
};
const same = (x, y) => x.lines.join("\n") === y.lines.join("\n");

// The manifest is generated; a stale one is a note the page silently loses.
const missing = onDisk.filter((f) => !listed.includes(f));
const phantom = listed.filter((f) => !onDisk.includes(f));
gate("manifest", !missing.length && !phantom.length,
     `lists all ${onDisk.length} recordings on disk`,
     [missing.length ? `${missing.join(", ")} on disk but unlisted` : "",
      phantom.length ? `${phantom.join(", ")} listed but absent` : ""]
       .filter(Boolean).join("; "));

gate("criterion 5", same(a, b),
     `same seed -> identical performance ` +
     `(${a.lines.reduce((n, l) => n + l.length, 0)} chars compared)`,
     `seed 1234 diverged at breath ${a.lines.findIndex((l, k) => l !== b.lines[k])}`);

gate("criterion 5b", !same(a, c), "a different seed performs differently",
     "seeds 1234 and 5678 performed alike");

let repeats = 0;
for (let i = 1; i < a.sequences.length; i++) {
  if (a.sequences[i] === a.sequences[i - 1]) repeats++;
}
gate("criterion 6", repeats === 0,
     `no two consecutive breaths identical (${a.sequences.length} breaths)`,
     `${repeats} consecutive repeats`);

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
gate("coverage", !bad.length,
     `${combos} key/scale/octave combinations all voiced, ` +
     `worst shift ${worstTune.toFixed(0)} cents at the recorded octave`,
     `${bad.length} broken: ${bad.slice(0, 3).join("; ")}`);

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
gate("rasterize", !tooClose && survived === 2,
     `${breaths} breaths, no onsets closer than ` +
     `${(MIN_ONSET_GAP_S * 1000).toFixed(0)}ms, structural notes never dropped`,
     tooClose ? `${tooClose} onsets too close` : "dropped a structural note");

// A rejected parameter set must change nothing.
const guard = new Instrument(manifest, { mood, seed: 3, key: "C", mode: "minor" });
const before = JSON.stringify(guard.params);
let refused = false;
try { guard.update({ bpm: 999 }); } catch { refused = true; }
gate("validation", refused && JSON.stringify(guard.params) === before,
     "an out-of-range value is refused and nothing is applied",
     "a bad set was accepted or partially applied");

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
        const { path } = pool.pick(stroke, v, new Rng(v + 1), null);
        if (!own.has(path)) unreachable.push(`${name}/${stroke} v${v} -> ${path}`);
      }
    }
  }
  // What the page is told to fetch is exactly what the layers that are on can
  // reach for -- no more (5 MB of unplayed washes) and no less.
  const off = new Instrument(manifest, { mood, seed: 3, key, mode });
  if (off.strokeFiles().length) unreachable.push("layers off still asked for files");
  const want = manifest.percussion.cabasa.files().sort().join(" ");
  const pending = { drum: true, drum_pool: "cabasa", rattle: false, wash: false };
  if (off.strokeFiles(pending).join(" ") !== want) {
    unreachable.push("strokeFiles() did not answer for a pending set");
  }
  off.update(pending);
  if (off.strokeFiles().join(" ") !== want) {
    unreachable.push("strokeFiles() did not follow the selected pool");
  }

  gate("pools", !unreachable.length,
       `${pools.reduce((n, [, p]) => n + p.strokes.length, 0)} strokes across ` +
       `${pools.length} pools, every velocity 0-127 voiced, ` +
       `all ${strokeCount} files reachable`,
       `${unreachable.length} unreachable: ${unreachable[0]}`);

  // The softest velocity reaches the softest layer and the loudest the
  // loudest, or a recorded layer is one nothing can ever ask for.
  const unusedLayers = [];
  for (const [name, pool] of pools) {
    for (const stroke of pool.strokes) {
      const layers = pool.levels(stroke);
      const lo = pool.pick(stroke, 0, new Rng(1), null).level;
      const hi = pool.pick(stroke, 127, new Rng(1), null).level;
      if (lo !== layers[0] || hi !== layers[layers.length - 1]) {
        unusedLayers.push(`${name}/${stroke}: 0->${lo}, 127->${hi}, have ${layers.join(",")}`);
      }
    }
  }
  gate("layers", !unusedLayers.length,
       "velocity 0 and 127 reach the softest and loudest recorded layer",
       unusedLayers[0]);

  // Levelling a stroke's layers is what keeps the middle of the velocity
  // range from being a step. VCSL recorded the frame drum 15 dB apart, and
  // `pick` crosses between those layers at velocity 64.
  const steps = [], clipped = [];
  let worst = 0;
  for (const [name, pool] of pools) {
    const byStroke = new Map();
    for (const path of pool.files()) {
      const { stroke, loudnessDb, peak } = pool.measured(path);
      const gain = pool.gainFor(path);
      // Levelling multiplies the whole recording, transient included.
      const after = peak * gain;
      if (after > 1.0) clipped.push(`${path} -> ${after.toFixed(2)}`);
      if (!byStroke.has(stroke)) byStroke.set(stroke, []);
      byStroke.get(stroke).push(
        { raw: loudnessDb, levelled: loudnessDb + 20 * Math.log10(gain) });
    }
    for (const [stroke, taken] of byStroke) {
      const span = (key) => Math.max(...taken.map((t) => t[key])) -
                            Math.min(...taken.map((t) => t[key]));
      worst = Math.max(worst, span("raw"));
      const levelled = span("levelled");
      if (levelled > 0.5) steps.push(`${name}/${stroke} still ${levelled.toFixed(1)} dB apart`);
    }
  }
  gate("levelling", !steps.length && !clipped.length,
       `every recording of a stroke within 0.5 dB after gain ` +
       `(worst spread before: ${worst.toFixed(1)} dB), nothing clips`,
       steps.length ? steps[0] : `clips: ${clipped[0]}`);

  // A round robin that can repeat is not one. Two identical onsets running is
  // the sound of a sampler rather than a player, which is the whole reason
  // several recordings of one stroke were authored.
  const repeated = [];
  for (const [name, pool] of pools) {
    for (const stroke of pool.strokes) {
      const layers = pool.levels(stroke);
      for (const level of layers) {
        if (pool.variants(stroke, level) < 2) continue;
        const rng = new Rng(4242);
        // Velocity that lands on this layer, so the draw exercises it.
        const v = Math.round((layers.indexOf(level) / Math.max(1, layers.length - 1)) * 127);
        let last = null;
        for (let i = 0; i < 200; i++) {
          const { path } = pool.pick(stroke, v, rng, last);
          if (path === last) { repeated.push(`${name}/${stroke} l${level}`); break; }
          last = path;
        }
      }
    }
  }
  gate("round robin", !repeated.length,
       "200 strikes, no recording used twice running",
       `${repeated[0]} repeated`);

  // The one that decides whether percussion can be added at all: it draws from
  // its own stream, so striking must not consume a number the phrase generator
  // was going to use. If this fails, turning a drum on rewrites the melody and
  // a seed no longer names one performance.
  const run = (layers) => {
    const inst = new Instrument(manifest, { mood, seed: 31337, key, mode });
    if (layers) inst.update({ drum: true, rattle: true });
    const notes = [], hits = [];
    for (let i = 0; i < 40; i++) {
      const b = inst.nextBreath();
      notes.push(noteSequence(b.notes));
      for (const l of Object.values(b.pulses)) for (const h of l) hits.push(h.file);
    }
    return { notes: notes.join("|"), hits };
  };
  const quiet = run(false), loud = run(true), again = run(true);
  const undisturbed = quiet.notes === loud.notes;
  const reproducible = loud.hits.join(" ") === again.hits.join(" ");
  gate("streams", undisturbed && reproducible && loud.hits.length > 0,
       `${loud.hits.length} strikes over 40 breaths changed no note, ` +
       `and reproduced from the seed`,
       !undisturbed ? "striking altered the melody"
                    : "strikes did not reproduce from the seed");
}

// ---- song mode ---------------------------------------------------------
{
  const BLOCKS = 3, REPEATS = 2, SECTIONS = 4;
  const section = BLOCKS * REPEATS * BLOCK_BREATHS;
  const play = (seed) => {
    const inst = new Instrument(manifest, { mood, seed, key, mode });
    inst.update({ song: true, song_blocks: BLOCKS, song_repeats: REPEATS });
    const out = [];
    for (let i = 0; i < section * SECTIONS; i++) {
      const b = inst.nextBreath();
      const [label, role] = b.role.split(" ");
      out.push({ label, role, seq: noteSequence(b.notes),
                 len: b.length_s, bars: b.bars });
    }
    return out;
  };
  const song = play(2718), again = play(2718), other = play(1618);
  const bad = [];

  // A block repeats verbatim, or it is not a repeat. Labels restart each
  // section, so the key has to carry which section it belongs to.
  const byBlock = new Map();
  song.forEach((b, i) => {
    const k = `s${Math.floor(i / section)}|${b.label}|${i % BLOCK_BREATHS}`;
    if (!byBlock.has(k)) byBlock.set(k, new Set());
    byBlock.get(k).add(`${b.seq}|${b.len}|${b.bars}`);
  });
  for (const [k, v] of byBlock) if (v.size > 1) bad.push(`${k} varies across repeats`);

  // The pair holds together: every block plays call then answer.
  song.forEach((b, i) => {
    const want = i % BLOCK_BREATHS === 0 ? "call" : "answer";
    if (!b.role.startsWith(want)) bad.push(`breath ${i} is ${b.role}, expected ${want}`);
  });

  // No block follows itself, and each appears exactly `repeats` times.
  for (let s0 = 0; s0 < SECTIONS; s0++) {
    const blocks = song.slice(s0 * section, (s0 + 1) * section)
                       .filter((_, i) => i % BLOCK_BREATHS === 0).map((b) => b.label);
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i] === blocks[i - 1]) bad.push(`section ${s0}: ${blocks[i]} follows itself`);
    }
    const tally = {};
    for (const b of blocks) tally[b] = (tally[b] ?? 0) + 1;
    const counts = Object.values(tally);
    if (counts.length !== BLOCKS || counts.some((c) => c !== REPEATS)) {
      bad.push(`section ${s0}: ${JSON.stringify(tally)}, wanted ${BLOCKS}x${REPEATS}`);
    }
  }

  // Sections are new material, not the same three blocks relabelled.
  const firstTwo = [0, 1].map((s0) =>
    song.slice(s0 * section, (s0 + 1) * section).map((b) => b.seq).sort().join("|"));
  if (firstTwo[0] === firstTwo[1]) bad.push("section 1 reused section 0's material");

  // Criterion 6 has to survive: repeating pairs must not put two identical
  // breaths side by side.
  for (let i = 1; i < song.length; i++) {
    if (song[i].seq === song[i - 1].seq) bad.push(`breaths ${i - 1},${i} identical`);
  }

  const key6 = (s0) => s0.map((b) => `${b.label}${b.role}${b.seq}`).join("|");
  if (key6(song) !== key6(again)) bad.push("same seed produced a different song");
  if (key6(song) === key6(other)) bad.push("a different seed produced the same song");

  const forms = [];
  for (let s0 = 0; s0 < SECTIONS; s0++) {
    forms.push(song.slice(s0 * section, (s0 + 1) * section)
                   .filter((_, i) => i % BLOCK_BREATHS === 0).map((b) => b.label).join(""));
  }
  gate("song", !bad.length,
       `${SECTIONS} sections of ${section} breaths (${forms.join(" ")}), ` +
       `pairs intact, repeats verbatim, no block twice running`, bad[0]);
}

// ---- rhythm layers -----------------------------------------------------
{
  const inst = new Instrument(manifest, { mood, seed: 808, key, mode });
  inst.update({ drum: true, rattle: true });
  const d = inst.describe();
  const unitS = d.meter.unit_s;
  const owned = new Set(inst.strokeFiles());
  const bad = [];
  let doubled = 0, drumHits = 0, rattleHits = 0, pastInhale = 0;
  const BREATHS_HERE = 60;

  for (let i = 0; i < BREATHS_HERE; i++) {
    const b = inst.nextBreath();
    const onsets = new Set(b.notes.filter((n) => !n.grace)
      .map((n) => round(n.start_s / unitS)));
    for (const h of b.pulses.drum) {
      drumHits++;
      if (onsets.has(round(h.start_s / unitS))) doubled++;
      if (!owned.has(h.file)) bad.push(`drum reached ${h.file}, not in strokeFiles()`);
      if (h.start_s > b.length_s + 1e-9) bad.push(`drum hit past the breath`);
    }
    for (const h of b.pulses.rattle) {
      rattleHits++;
      if (!owned.has(h.file)) bad.push(`rattle reached ${h.file}, not in strokeFiles()`);
      // The breath sounds for u0..units-1, so the first inhale unit lands
      // exactly on length_s.
      if (h.start_s >= b.length_s - 1e-9) pastInhale++;
      if (h.start_s > b.length_s + b.inhale_s + 1e-9) bad.push(`rattle hit past the cycle`);
    }
  }
  if (doubled) bad.push(`${doubled} drum hits doubled a tune onset`);
  if (!pastInhale) bad.push("the rattle never played through an inhale");
  if (!drumHits || !rattleHits) bad.push("a layer produced nothing");

  // Song mode: a repeated block drums the same figure, on different takes.
  const song = new Instrument(manifest, { mood, seed: 808, key, mode });
  song.update({ song: true, drum: true, rattle: true });
  const byBlock = new Map();
  for (let i = 0; i < 12; i++) {
    const b = song.nextBreath();
    const k = `${b.role}|${i % 2}`;
    const figure = b.pulses.drum.map((h) => `${h.start_s.toFixed(4)}${h.stroke}`).join(" ");
    const takes = b.pulses.drum.map((h) => h.file).join(" ");
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push({ figure, takes });
  }
  let repeatedBlocks = 0, sameTakes = 0;
  for (const [k, seen] of byBlock) {
    if (seen.length < 2) continue;
    repeatedBlocks++;
    if (seen[0].figure !== seen[1].figure) bad.push(`${k} drummed a different figure on repeat`);
    if (seen[0].takes && seen[0].takes === seen[1].takes) sameTakes++;
  }
  if (!repeatedBlocks) bad.push("no block repeated inside the section");

  // Every pool a selector offers has to resolve every stroke its role asks
  // for, or choosing it is an error several layers down.
  const choices = inst.describe().pool_choices;
  const tried = [];
  for (const [field, names] of Object.entries(choices)) {
    for (const name of names) {
      const probe2 = new Instrument(manifest, { mood, seed: 55, key, mode });
      probe2.update({ drum: true, rattle: true, [field]: name });
      const loadable = new Set(probe2.strokeFiles());
      let hits = 0;
      for (let i = 0; i < 12; i++) {
        const b = probe2.nextBreath();
        for (const l of Object.values(b.pulses)) {
          for (const h of l) {
            hits++;
            if (!loadable.has(h.file)) bad.push(`${field}=${name} reached an unloadable ${h.file}`);
          }
        }
      }
      if (!hits) bad.push(`${field}=${name} produced no hits`);
      tried.push(`${field}=${name}`);
    }
  }

  // The wash is a texture, not a pulse: at most one per breath, never closer
  // than WASH_MIN_GAP breaths, and reproducible.
  const washRun = (seed) => {
    const w = new Instrument(manifest, { mood: "sleep", seed, key, mode });
    w.update({ wash: true });
    const at = [];
    for (let i = 0; i < 200; i++) {
      const b = w.nextBreath();
      if (b.pulses.wash.length > 1) bad.push("more than one wash in a breath");
      if (b.pulses.wash.length) at.push(b.index);
    }
    return at;
  };
  const washA = washRun(4242), washB = washRun(4242), washC = washRun(99);
  for (let i = 1; i < washA.length; i++) {
    if (washA[i] - washA[i - 1] < WASH_MIN_GAP) {
      bad.push(`washes ${washA[i - 1]} and ${washA[i]} closer than ${WASH_MIN_GAP} breaths`);
    }
  }
  if (!washA.length) bad.push("the wash never fired in 200 breaths");
  if (washA.join(",") !== washB.join(",")) bad.push("the wash did not reproduce from the seed");
  if (washA.join(",") === washC.join(",")) bad.push("a different seed washed identically");

  gate("pools/roles", !bad.length,
       `${tried.length} selectable pools all voiced (${tried.join(", ")})`, bad[0]);
  if (!bad.length) {
    console.log(`PASS  wash: ${washA.length} in 200 breaths, ` +
                `never closer than ${WASH_MIN_GAP}, reproducible`);
    console.log(`PASS  rhythm: ${drumHits} drum and ${rattleHits} rattle hits over ${BREATHS_HERE} ` +
                `breaths, 0 doubled the tune, ${pastInhale} rattle hits fell in an inhale`);
    console.log(`PASS  rhythm/song: ${repeatedBlocks} repeated blocks drummed the same figure, ` +
                `${repeatedBlocks - sameTakes} of them on different takes`);
  }
}

console.log();
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("engine-side acceptance criteria pass");
