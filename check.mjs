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
import { readdirSync, readFileSync } from "node:fs";
import { Instrument } from "./engine/instrument.js";
import { noteSequence } from "./engine/breath.js";
import { LOOP_SUFFIX } from "./engine/samples.js";
import * as scales from "./engine/scales.js";

const BREATHS = 60;
const LOOPS_DIR = "loops";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function render(b) {
  const notes = b.notes.map((n) =>
    `${n.name}@${n.start_s.toFixed(6)}+${n.dur_s.toFixed(6)}` +
    `v${n.velocity}${n.grace ? "g" : ""}`).join(" ");
  return `${b.index} ${b.length_s.toFixed(6)} ${b.inhale_s.toFixed(6)} ` +
         `${b.layer} ${b.drones.join(",")} | ${notes}`;
}

function perform(files, opts) {
  const inst = new Instrument(files, opts);
  const lines = [], sequences = [];
  for (let i = 0; i < BREATHS; i++) {
    const b = inst.nextBreath();
    lines.push(render(b));
    sequences.push(noteSequence(b.notes));
  }
  return { lines, sequences };
}

// Read the manifest, because that is what the page reads. Scanning the
// directory instead would make this gate blind to the one failure the manifest
// exists to prevent -- a loop on disk that the page never learns about.
let files;
try {
  files = JSON.parse(readFileSync(`${LOOPS_DIR}/manifest.json`, "utf8")).files;
} catch (e) {
  console.error(`cannot read ${LOOPS_DIR}/manifest.json (${e.message}). ` +
                `Run tools/loopfind.py then tools/manifest.py, or ./run.sh --rebuild.`);
  process.exit(2);
}
const onDisk = readdirSync(LOOPS_DIR).filter((f) => f.endsWith(LOOP_SUFFIX));

const key = arg("key", "C"), mode = arg("mode", "minor");
const mood = arg("mood", "contemplative");
console.log(`samples : ${files.length} loops from ${LOOPS_DIR}`);
console.log(`key     : ${key} ${mode}`);
console.log(`mood    : ${mood}, ${BREATHS} breaths\n`);

const a = perform(files, { mood, seed: 1234, key, mode });
const b = perform(files, { mood, seed: 1234, key, mode });
const c = perform(files, { mood, seed: 5678, key, mode });

const failures = [];
const same = (x, y) => x.lines.join("\n") === y.lines.join("\n");

// The manifest is generated; a stale one is a note the page silently loses.
const missing = onDisk.filter((f) => !files.includes(f));
const phantom = files.filter((f) => !onDisk.includes(f));
if (!missing.length && !phantom.length) {
  console.log(`PASS  manifest: lists all ${onDisk.length} loops on disk`);
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
const probe = new Instrument(files, { mood, seed: 7, key: "C", mode: "minor" });
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

// A rejected parameter set must change nothing.
const guard = new Instrument(files, { mood, seed: 3, key: "C", mode: "minor" });
const before = JSON.stringify(guard.params);
let refused = false;
try { guard.update({ bpm: 999 }); } catch { refused = true; }
if (refused && JSON.stringify(guard.params) === before) {
  console.log("PASS  validation: an out-of-range value is refused and nothing is applied");
} else {
  failures.push("validation: a bad set was accepted or partially applied");
  console.log("FAIL  validation");
}

console.log();
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("engine-side acceptance criteria pass");
