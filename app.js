/* The browser is the whole instrument: it plans the music and it makes the
   sound. Nothing is fetched but the loops themselves, so this runs from any
   static host.

   Everything is scheduled ahead of time against `AudioContext.currentTime`,
   never against a timer. setInterval drifts and stalls when the tab is busy;
   the audio clock does neither, which is why the drone does not wobble. The
   timer's only job is to ask "is there less than LOOKAHEAD_S of music
   scheduled?" often enough that the answer is never yes for long. */

const LOOKAHEAD_S = 4.0;      // keep this much music scheduled ahead
const TICK_MS = 250;

import { Instrument } from "./engine/instrument.js";
import { parseManifest, readLoopPoints } from "./engine/samples.js";
import { INSTRUMENT } from "./engine/profile.js";
import { CHOICE_PARAMS } from "./engine/moods.js";

let ctx = null;
let engine = null;            // the performance itself
let inst = null;              // what engine.describe() said
let loops = {};               // path -> {buffer, loopStartS, loopEndS}
let strokes = {};             // path -> AudioBuffer, one-shots
let running = false;
let cursor = 0;               // audio-clock time the next breath begins
let live = new Set();         // sources still sounding, for a clean stop
let history = [];
let working = {};             // what the performance tab shows
let applyAt = null;           // audio-clock time a submitted set starts sounding

// How quiet the recordings are is a fact about the sample set, so the figure
// lives with them; the limiter behind this stage catches the moments several
// notes and a long reverb tail land together.
const MAKEUP = INSTRUMENT.makeupGain;

// Loudness curve: the engine emits a 0-127 velocity, and this is the one place
// that becomes a gain. Written once so the drone and the lead keep the balance
// `voice_gain` encodes.
const ampFor = (velocity, gain) => Math.pow(velocity / 127, 1.4) * gain;

// the graph, built once
// Only the nodes an effect control reaches live out here; the rest are locals
// of `buildGraph`, which is the only thing that touches them.
let master = null, tone = null;
let convolver = null, preDelay = null, reverbReturn = null;
let delayNode = null, delayReturn = null, feedback = null, fbTone = null;
let bus = {};                 // channel name -> {input, sends: {reverb, delay}}

const LABELS = {
  notes_per_breath: "notes / breath", step_leap_ratio: "step : leap",
  ornament_rate: "ornament", cadence_strength: "cadence",
  wash_rate: "rain stick rate",
  register_bias: "register bias",
  call_response: "call / answer", bpm: "tempo",
  breath_mean_s: "breath mean", breath_spread_s: "breath spread",
  inhale_16ths: "inhale (16ths)",
  drum_density: "drum fill",
  // Not "cycle": the number stretches the motif's own rhythm, so bigger is a
  // longer figure and fewer strokes in a bar.
  rattle_scale: "rattle stretch", rattle_fill: "rattle fill",
};
const DECIMALS = {notes_per_breath: 1, breath_mean_s: 1, breath_spread_s: 1,
                  inhale_16ths: 0, bpm: 0, rattle_scale: 0};
// Tempo counts whole beats, the inhale whole sixteenths, and the rattle
// stretch whole augmentations.
const STEPS = {bpm: 1, inhale_16ths: 1, rattle_scale: 1};

/* Rooms. These live here rather than in the profile because they are not
   properties of the instrument -- the same flute can be played in any of
   them, and none of it reaches the engine.

   A room no longer carries a wet amount. How much of each instrument is in the
   room is a send, and the sends belong to the mixer. */
const ROOMS = {
  "dry":       {decay: 0.5, predelay: 0,   tone: 18000, verb: 0.35},
  "small room":{decay: 1.1, predelay: 8,   tone: 15000, verb: 0.55},
  "chapel":    {decay: 2.6, predelay: 22,  tone: 12000, verb: 0.65},
  "hall":      {decay: 4.2, predelay: 35,  tone: 10000, verb: 0.70},
  "cathedral": {decay: 6.5, predelay: 55,  tone: 8000,  verb: 0.75},
  "canyon":    {decay: 8.0, predelay: 110, tone: 6000,  verb: 0.80},
};
const ROOM_FIELDS = Object.keys(ROOMS.dry);

/* The mixer. One channel per instrument, each with a level and a send to each
   effect. `makeup` says whether the channel carries the sample set's makeup
   gain: the flute loops were recorded quietly and need it, the percussion was
   normalised at build time and does not.

   The defaults reproduce the balance the single wet/dry stage used to give,
   so turning the page on sounds the same as it did before it had a mixer. */
const SENDS = ["reverb", "delay"];
const MIX = {
  lead:   {label: "flute",      makeup: true,  level: 1.00, reverb: 0.35, delay: 0.18},
  drone:  {label: "drone",      makeup: true,  level: 1.00, reverb: 0.50, delay: 0.06},
  drum:   {label: "drum",       makeup: false, level: 0.90, reverb: 0.22, delay: 0.10},
  rattle: {label: "rattle",     makeup: false, level: 0.90, reverb: 0.18, delay: 0.06},
  wash:   {label: "rain stick", makeup: false, level: 0.50, reverb: 0.70, delay: 0.55},
};
const CHANNELS = Object.keys(MIX);

// The switches that are plain on/off rather than a value.
const TOGGLES = ["song", "drum", "rattle", "wash"];

/* One sixteenth, in seconds. The delay counts sixteenths rather than
   milliseconds so it stays in time when the tempo moves -- six of them is a
   dotted quarter, which lands between the beats instead of doubling them. The
   tempo belongs to the mood, so this follows a submitted set rather than being
   fixed when the graph is built. Every effect's own default sits on its
   control in the markup, which is the one place they are written. */
const sixteenthS = () => (inst ? inst.meter.sixteenth_s : 60 / 72 / 4);
const delaySeconds = () => parseFloat($("dtime").value) * sixteenthS();

const $ = (id) => document.getElementById(id);

/* ---------- transport ---------- */

/* The recordings are the only thing still fetched. Relative, so the page works
   from a project subpath as well as from a domain root.
 *
 * The manifest names two kinds of pool -- sustained loops and percussion
 * one-shots -- and is parsed through the engine's own reader rather than
 * indexed here, so the page and the acceptance gate cannot disagree about what
 * a pool is. */
async function loadManifest() {
  const res = await fetch("manifest.json");
  if (!res.ok) throw new Error(`manifest.json: ${res.status}`);
  return parseManifest(await res.json());
}

/* `loops/A#4_loop.wav` -> `loops/A%234_loop.wav`. An unescaped # is a
   fragment, so the request would arrive as `loops/A`. The file name is escaped
   and the separators are not, because they are the path. */
function urlFor(path) {
  const cut = path.lastIndexOf("/");
  return path.slice(0, cut + 1) + encodeURIComponent(path.slice(cut + 1));
}

/* ---------- the audio graph ----------

   Five channels, one per instrument. Each runs dry to the master and taps a
   send to each effect, which is what lets the drum sit close while the drone
   sits far back in the same room.

     lead ─┬────────────────────────────────────────────────┐
     drone ┤   ┌─ reverb send ─→ preDelay → convolver ──────┤
     drum ─┼───┤                                            ├→ master → tone
     rattle┤   └─ delay send ──→ delay ────────────────────┤      → limiter
     wash ─┘                      ↑        ↓                │
                                  └ fbTone ┘ (repeats darken)

   Tone sits after the master rather than before the sends, so a darker room
   darkens the whole mix, tails included. */

function buildGraph() {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = parseFloat($("tone").value);
  tone.Q.value = 0.7;
  tone.connect(limiter);

  master = ctx.createGain();
  master.gain.value = parseFloat($("master").value);
  master.connect(tone);

  // --- reverb return
  const reverbIn = ctx.createGain();
  preDelay = ctx.createDelay(0.5);
  preDelay.delayTime.value = parseFloat($("predelay").value) / 1000;
  convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = makeImpulse(parseFloat($("decay").value));
  reverbReturn = ctx.createGain();
  reverbReturn.gain.value = parseFloat($("verb").value);
  reverbIn.connect(preDelay).connect(convolver).connect(reverbReturn).connect(master);

  // --- delay return. The feedback path is legal because a DelayNode sits in
  // the loop; the filter in it is what makes each repeat darker than the last.
  const delayIn = ctx.createGain();
  // Sixteen sixteenths at the slowest tempo the engine allows is six seconds,
  // so the line has to be able to hold that much.
  delayNode = ctx.createDelay(7.0);
  delayNode.delayTime.value = delaySeconds();
  fbTone = ctx.createBiquadFilter();
  fbTone.type = "lowpass";
  fbTone.frequency.value = parseFloat($("dtone").value);
  fbTone.Q.value = 0.5;
  feedback = ctx.createGain();
  feedback.gain.value = parseFloat($("dfeed").value);
  delayReturn = ctx.createGain();
  delayReturn.gain.value = parseFloat($("dlevel").value);
  delayIn.connect(delayNode);
  delayNode.connect(fbTone).connect(feedback).connect(delayNode);
  delayNode.connect(delayReturn).connect(master);

  // --- channels
  const returns = { reverb: reverbIn, delay: delayIn };
  for (const name of CHANNELS) {
    const input = ctx.createGain();
    input.gain.value = channelGain(name);
    input.connect(master);
    const sends = {};
    for (const send of SENDS) {
      const g = ctx.createGain();
      g.gain.value = parseFloat($(`${name}-${send}`).value);
      input.connect(g).connect(returns[send]);
      sends[send] = g;
    }
    bus[name] = { input, sends };
  }
}

/* A channel's level, with the sample set's makeup folded in where the
   recordings need it. Reading the slider rather than storing it keeps one
   source for the value. */
function channelGain(name) {
  return parseFloat($(`${name}-level`).value) * (MIX[name].makeup ? MAKEUP : 1);
}

/* A synthesised impulse response: noise under an exponential decay, with the
   very front softened so the onset is not a click. Shipping an IR file would
   sound better and would also be an asset to license and carry; this is a
   knob that costs nothing and can be turned while the drone sounds. */
function makeImpulse(seconds) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
    }
    const head = Math.min(n, Math.floor(ctx.sampleRate * 0.004));
    for (let i = 0; i < head; i++) d[i] *= i / head;
  }
  return buf;
}

/* ---------- loading ---------- */

async function fetchRaw(path) {
  const res = await fetch(urlFor(path));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.arrayBuffer();
}

/* Only what is not already decoded, so switching a pool fetches that pool and
   nothing else. The promise is what is remembered rather than the buffer: a
   second submit while the first is still loading would otherwise re-fetch and
   re-decode everything it had not finished yet. */
const decoding = {};
function loadStrokes(paths) {
  return Promise.all(paths.map((path) => {
    if (path in strokes) return strokes[path];
    if (!(path in decoding)) {
      decoding[path] = fetchRaw(path)
        .then((raw) => ctx.decodeAudioData(raw))
        .then((buf) => (strokes[path] = buf));
    }
    return decoding[path];
  }));
}

async function loadBuffers() {
  await Promise.all([
    ...engine.loopFiles().map(async (path) => {
      const raw = await fetchRaw(path);
      // Read the loop points BEFORE decoding: decodeAudioData detaches the
      // buffer, and it discards the smpl chunk they live in either way.
      const points = readLoopPoints(raw, path);
      loops[path] = { ...points, buffer: await ctx.decodeAudioData(raw) };
    }),
    loadStrokes(engine.strokeFiles()),
  ]);
}

/* ---------- playing one note ---------- */

/* Every voice is the same thing: a loop from the sample set, at the pitch the
   engine asks for. loopStart/loopEnd are the smpl chunk's own points in
   seconds, and detune is in cents, so neither is converted here. */
function source(spec, at, until) {
  const loop = loops[spec.file];
  const src = ctx.createBufferSource();
  src.buffer = loop.buffer;
  src.loop = true;
  src.loopStart = loop.loopStartS;
  src.loopEnd = loop.loopEndS;
  src.detune.value = spec.cents;
  src.start(at);
  src.stop(until);
  live.add(src);
  src.onended = () => live.delete(src);
  return src;
}

/* One melody note: a voice under its own short envelope, so it starts and
   stops without a click inside the breath the caller is shaping. */
function voice(spec, at, dur, velocity, dest) {
  const g = ctx.createGain();
  const amp = ampFor(velocity, inst.voice_gain.lead);
  const a = Math.min(0.012, dur / 3), r = Math.min(0.06, dur / 3);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(amp, at + a);
  g.gain.setValueAtTime(amp, at + dur - r);
  g.gain.linearRampToValueAtTime(0, at + dur);
  source(spec, at, at + dur + 0.02).connect(g).connect(dest);
}

/* One strike. `gain` is the pool's levelling gain, so every recording of a
   stroke arrives at the same loudness and velocity alone shapes the rest. */
function strike(hit, at, dest) {
  const buffer = strokes[hit.file];
  if (!buffer) throw new Error(`no buffer for ${hit.file}`);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = ampFor(hit.velocity, hit.gain);
  src.connect(g).connect(dest);
  src.start(at);
  live.add(src);
  src.onended = () => live.delete(src);
}

/* ---------- playing one breath ---------- */

/* The breath envelope, on its own gain stage. Lead and drone each get one
   rather than sharing: they rise and fall together, which is the instrument's
   whole argument, but they are separate channels in the mixer and a shared
   node could only reach one of them. */
function breathEnv(t0, lengthS, dest) {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(1, t0 + inst.attack_s);
  env.gain.setValueAtTime(1, t0 + lengthS - inst.release_s);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + lengthS);
  env.connect(dest);
  return env;
}

function scheduleBreath(b) {
  const t0 = cursor;

  // Up to three drones share one gain stage, scaled by 1/sqrt(n): three voices
  // at full level would be three times the drone the settings ask for, and the
  // limiter would spend the whole breath pulling it back down.
  if (b.drones.length) {
    const env = breathEnv(t0, b.length_s, bus.drone.input);
    const drone = ctx.createGain();
    drone.gain.value = ampFor(b.drone_velocity, inst.voice_gain.drone)
                       / Math.sqrt(b.drones.length);
    drone.connect(env);
    for (const name of b.drones) {
      source(inst.voices[name], t0, t0 + b.length_s + 0.05).connect(drone);
    }
  }

  const lead = breathEnv(t0, b.length_s, bus.lead.input);
  for (const n of b.notes) {
    const at = t0 + n.start_s;
    const dur = Math.min(n.dur_s, b.length_s - n.start_s);
    if (dur <= 0.005) continue;
    voice(inst.voices[n.name], at, dur, n.velocity, lead);
  }

  // Not under a breath envelope: the rattle runs on through the inhale, and the
  // drum is answering the tune rather than riding its breath.
  for (const [layer, hits] of Object.entries(b.pulses)) {
    for (const hit of hits) strike(hit, t0 + hit.start_s, bus[layer].input);
  }

  cursor = t0 + b.length_s + b.inhale_s;
  remember(b);
}

/* ---------- the lookahead loop ---------- */

let filling = false;
async function fill() {
  if (!running || filling) return;
  filling = true;
  try {
    while (running && cursor < ctx.currentTime + LOOKAHEAD_S) {
      scheduleBreath(engine.nextBreath());
    }
  } catch (err) {
    note(`stopped: ${err.message}`);
    stop();
  } finally {
    filling = false;
  }
}

/* ---------- display ---------- */

const sounded = (b) =>
  b.notes.filter((n) => !n.grace).map((n) => n.name).join(" ");

function remember(b) {
  history = [b, ...history].slice(0, 8);
  $("log").textContent = history.map((h) =>
    `breath ${String(h.index).padStart(3)}  ${h.bars} bar  ` +
    `${h.length_s.toFixed(2)}s  ${h.role.padEnd(18)} ` +
    sounded(h)).join("\n");
  $("now").textContent =
    `breath ${b.index} · ${b.bars} bar · ${sounded(b)}`;
}

function note(msg) { $("note").textContent = msg; }

/* ---------- start / stop ---------- */

async function start() {
  if (running) return;
  if (!ctx) {
    // An AudioContext may only begin from a gesture, so everything that needs
    // one is built here rather than at load.
    ctx = new AudioContext();
    note("loading recordings…");
    const manifest = await loadManifest();
    const url = new URLSearchParams(location.search);
    engine = new Instrument(manifest, {
      mood: url.get("mood") || "contemplative",
      key: url.get("key") || "C",
      mode: url.get("mode") || "minor",
      seed: Number(url.get("seed")) || Math.floor(Math.random() * 2 ** 31),
      song: url.get("song") === "1",
      songBlocks: Number(url.get("blocks")) || 3,
      songRepeats: Number(url.get("repeats")) || 2,
      drum: url.get("drum") === "1",
      rattle: url.get("rattle") === "1",
      wash: url.get("wash") === "1",
    });
    inst = engine.describe();
    await loadBuffers();
    buildGraph();
    describe();
  }
  await ctx.resume();
  running = true;
  // The notice has done its job the moment they press play. Optional, because
  // start() runs again on every un-stop and the notice is only there once.
  $("firstrun")?.remove();
  cursor = ctx.currentTime + 0.15;
  $("run").textContent = "■";
  $("lamp").classList.add("on");
  note("");
  fill();
}

function stop() {
  running = false;
  for (const s of live) { try { s.stop(); } catch (e) { /* already done */ } }
  live.clear();
  $("run").textContent = "▶";
  $("lamp").classList.remove("on");
  $("now").textContent = "";
}

/* One row of the performance panel. Dragging writes the working copy and
   redraws; nothing reaches the engine until Submit. */
function paramRow(name) {
  const [lo, hi] = inst.ranges[name];
  const row = document.createElement("div");
  row.className = "param";
  row.dataset.field = name;

  const label = document.createElement("label");
  label.htmlFor = `s-${name}`;
  label.textContent = LABELS[name] || name;
  const input = document.createElement("input");
  Object.assign(input, {type: "range", id: `s-${name}`, min: lo, max: hi,
                        step: STEPS[name] ?? ((hi - lo) > 6 ? 0.5 : 0.01)});
  const out = document.createElement("output");

  input.addEventListener("input", () => {
    working[name] = parseFloat(input.value);
    renderParams();
  });
  row.append(label, input, out);
  return row;
}

/* A minus/plus pair.
 *
 * Holding a button repeats, because the drone range is 48 steps wide and a
 * control that needs 48 clicks to cross is not a control. The repeat is armed
 * on pointerdown and cancelled from `window`, so releasing over a button that
 * just disabled itself at the end of the range still stops it.
 *
 * `click` fires for keyboard activation too, which would double-step a mouse
 * press; `detail === 0` is the way to tell a keyboard click from a real one. */
function stepper(onStep) {
  const wrap = document.createElement("span");
  wrap.className = "stepper";
  for (const [label, by, cls] of [["\u2212", -1, "down"], ["+", 1, "up"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    let hold = null, repeat = null;
    const stop = () => {
      clearTimeout(hold); clearInterval(repeat);
      hold = repeat = null;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      onStep(by);
      hold = setTimeout(() => { repeat = setInterval(() => onStep(by), 60); }, 400);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    });
    b.addEventListener("click", (e) => { if (e.detail === 0) onStep(by); });
    wrap.appendChild(b);
  }
  return wrap;
}

/* One drone slot. The interval is in semitones from the tonic, so +7 is a fifth
   in every scale and a slot can sit deliberately outside the one being played. */
const INTERVALS = ["root", "m2", "M2", "m3", "M3", "4th", "TT", "5th",
                   "m6", "M6", "m7", "M7", "8ve"];

/* Short enough to fit the value column without wrapping. Inside an octave the
   interval has a name worth reading; beyond one, the semitone count is the
   clearer thing to show. */
function intervalName(semitones) {
  if (semitones === 0) return "root";
  const sign = semitones < 0 ? "\u2212" : "+";
  const n = Math.abs(semitones);
  return n <= 12 ? sign + INTERVALS[n] : `${sign}${n} st`;
}

function droneRow(i) {
  const row = document.createElement("div");
  row.className = "param";
  row.dataset.drone = i;
  row.innerHTML =
    `<label><input type="checkbox" class="on"> drone ${i + 1}</label>` +
    `<output></output>`;
  const box = row.querySelector(".on");
  box.addEventListener("change", () => {
    working.drones[i].on = box.checked; renderParams();
  });
  row.insertBefore(stepper((by) => nudge(working.drones[i], "semitones", by,
                                         inst.drone_semitones)),
                   row.querySelector("output"));
  return row;
}

/* Move a value by one step, held inside its range. Both steppers clamp the
   same way, so neither can put the engine into a set it would refuse. */
function nudge(holder, field, by, [lo, hi]) {
  holder[field] = Math.max(lo, Math.min(hi, holder[field] + by));
  renderParams();
}

let built = false;
function describe() {
  // The heading names the instrument, which is five voices; what the lead is
  // voiced from is a fact about the recordings, so it is credited with them.
  $("prov").textContent = inst.provenance;
  $("prov").title = inst.sampleNote;      // the long form, on hover

  if (!built) {
    const m = $("mood");
    for (const name of inst.moods) m.appendChild(new Option(name, name));
    for (const k of inst.keys) $("key").appendChild(new Option(k, k));
    for (const k of inst.modes) $("mode").appendChild(new Option(k, k));
    $("keys-row").insertBefore(
      stepper((by) => nudge(working, "lead_octave", by, inst.ranges.lead_octave)),
      $("lead_octave"));
    for (const name of ["song_blocks", "song_repeats"]) {
      $(`${name}-row`).insertBefore(
        stepper((by) => nudge(working, name, by, inst.ranges[name])), $(name));
    }
    for (const name of TOGGLES) {
      $(name).addEventListener("change", () => {
        working[name] = $(name).checked; renderParams();
      });
    }
    for (const field of Object.keys(inst.pool_choices)) {
      const sel = $(field);
      for (const name of inst.pool_choices[field]) {
        sel.appendChild(new Option(name.replace(/_/g, " "), name));
      }
      sel.addEventListener("change", () => {
        working[field] = sel.value; renderParams();
      });
    }
    for (const name of inst.rhythm_fields) $("rhythm").appendChild(paramRow(name));
    for (let i = 0; i < inst.drone_slots; i++) {
      $("drones").appendChild(droneRow(i));
    }
    for (const name of inst.weight_fields) $("weights").appendChild(paramRow(name));
    for (const name of inst.breath_fields) $("breath").appendChild(paramRow(name));
    built = true;
  }

  working = structuredClone(inst.params);
  renderParams();
  // The delay counts sixteenths and a submitted set can move the tempo, so the
  // line is retimed and its readout redrawn against the new beat.
  setRoom.dtime(parseFloat($("dtime").value));
  $("meter").textContent =
    `${inst.meter.bpm} bpm · ${inst.meter.beats_per_measure}/4 · ` +
    `bar ${inst.meter.measure_s.toFixed(2)}s`;
}

function isDirty(name) {
  const a = working[name], b = inst.params[name];
  // `drones` is a list of slots, so a shallow compare would call it clean
  // whenever a slot changed. Compare what it renders to instead.
  if (name === "drones") return JSON.stringify(a) !== JSON.stringify(b);
  return typeof b === "number"
    ? Math.abs(parseFloat(a) - b) > 1e-9 : String(a) !== String(b);
}

const anyDirty = () =>
  inst !== null && Object.keys(inst.params).some(isDirty);

/* Grey out whichever button has nowhere left to go, so the range is visible
   without having to walk into it. */
function ends(row, value, [lo, hi]) {
  row.querySelector(".stepper .down").disabled = value <= lo;
  row.querySelector(".stepper .up").disabled = value >= hi;
}

/* The working copy on screen, and whether it differs from what is sounding.
   Runs on every slider event, so each dirty flag is computed once rather than
   once per row -- `isDirty("drones")` serialises the slot list to compare it. */
function renderParams() {
  $("mood").value = working.mood;
  $("key").value = working.key;
  $("mode").value = working.mode;
  // U+2212, matching the minus the drone intervals use in the same column.
  const oct = working.lead_octave;
  $("lead_octave").textContent =
    oct > 0 ? `+${oct}` : String(oct).replace("-", "\u2212");
  ends($("keys-row"), oct, inst.ranges.lead_octave);
  if (document.activeElement !== $("seed")) $("seed").value = working.seed;
  for (const name of TOGGLES) $(name).checked = working[name] === true;
  for (const field of Object.keys(inst.pool_choices)) $(field).value = working[field];
  $("drum_pool").disabled = !working.drum;
  $("rattle_pool").disabled = !working.rattle;
  $("rhythm").classList.toggle("off",
    !working.drum && !working.rattle && !working.wash);
  for (const name of ["song_blocks", "song_repeats"]) {
    $(name).textContent = String(working[name]);
    ends($(`${name}-row`), working[name], inst.ranges[name]);
    $(`${name}-row`).classList.toggle("off", !working.song);
  }
  const dronesDirty = isDirty("drones");
  for (const row of document.querySelectorAll("[data-drone]")) {
    const slot = working.drones[row.dataset.drone];
    row.querySelector(".on").checked = slot.on;
    row.querySelector("output").textContent = intervalName(slot.semitones);
    ends(row, slot.semitones, inst.drone_semitones);
    row.classList.toggle("off", !slot.on);
    row.classList.toggle("edited", dronesDirty);
  }
  for (const row of document.querySelectorAll("[data-field]")) {
    const name = row.dataset.field;
    const input = row.querySelector("input");
    if (document.activeElement !== input) input.value = working[name];
    row.querySelector("output").textContent =
      Number(working[name]).toFixed(DECIMALS[name] ?? 2);
    row.classList.toggle("edited", isDirty(name));
  }
  // Several of these share a row -- key, scale and octave are one line, and a
  // layer sits beside its pool -- so the row is marked from whether *any* of
  // its parameters is dirty. Toggling per parameter would let the last one
  // read clear the mark the first one set.
  const editedRows = new Map();
  for (const name of CHOICE_PARAMS) {
    const row = $(name).closest(".param");
    editedRows.set(row, (editedRows.get(row) ?? false) || isDirty(name));
  }
  for (const [row, edited] of editedRows) row.classList.toggle("edited", edited);
  const dirty = anyDirty();
  $("submit").disabled = !dirty;
  $("revert").disabled = !dirty;
  renderStatus(dirty);
}

/* The page owns the schedule, so it knows exactly when a submitted set starts
   sounding: at the end of what is already scheduled. */
function renderStatus(dirty = anyDirty()) {
  const el = $("status");
  if (applyAt === null) {
    el.className = "status";
    el.textContent = dirty ? "Unsubmitted changes." : "";
    return;
  }
  const left = applyAt - (ctx ? ctx.currentTime : 0);
  if (left <= 0) { applyAt = null; el.className = "status"; el.textContent = "";
                   return; }
  el.className = "status pending";
  el.textContent = `Applies in ${Math.ceil(left)} s`;
}

/* The whole working set is applied at once, so a performance never runs
   half-changed -- a key from the new set under a phrase drawn for the old one.
   It lands on the next breath the page asks for, which is why the breaths
   already scheduled play out first. */
async function submit() {
  if (!inst || !anyDirty()) return;
  const pending = structuredClone(working);
  try {
    // Before the set is applied, not after: the scheduler may ask for a breath
    // the moment `update` returns, and a strike with no buffer is an error.
    // The engine answers what the pending set needs, so the layer-to-pool rule
    // is not written out a second time here.
    if (ctx) await loadStrokes(engine.strokeFiles(pending));
    inst = engine.update(pending);
  } catch (err) {
    note(`refused: ${err.message}`);
    return;
  }
  // Breaths already scheduled play out first, so the set starts sounding
  // where the schedule currently ends.
  applyAt = running ? cursor : null;
  // `update` returned the new description, so `describe` resets the working
  // copy from it -- it already equals `pending`.
  describe();
  note("");
}

function revert() {
  working = structuredClone(inst.params);
  renderParams();
  note("");
}

/* ---------- wiring ---------- */

$("run").addEventListener("click", () => (running ? stop() : start()));
// Choosing a mood moves every weight it owns, tempo included -- still only in
// the working copy, so nothing sounds different until Submit.
$("mood").addEventListener("change", () => {
  const name = $("mood").value;
  Object.assign(working, {mood: name}, inst.preset_weights[name] || {});
  renderParams();
});
$("key").addEventListener("change", () => {
  working.key = $("key").value; renderParams();
});
$("mode").addEventListener("change", () => {
  working.mode = $("mode").value; renderParams();
});
$("seed").addEventListener("input", () => {
  working.seed = parseInt($("seed").value, 10) || 0; renderParams();
});
$("reseed").addEventListener("click", () => {
  working.seed = Math.floor(Math.random() * 2 ** 31);
  $("seed").value = working.seed;
  renderParams();
});
$("submit").addEventListener("click", submit);
$("revert").addEventListener("click", revert);

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("on", t === tab);
    }
    for (const s of document.querySelectorAll("[data-panel]")) {
      s.hidden = s.dataset.panel !== tab.dataset.tab;
    }
  });
}

/* ---------- mixer ---------- */

// A strip is a level and one send per effect, in that order.
const MIX_FIELDS = ["level", ...SENDS];
// A level can be pushed past unity; a send is a fraction of the channel.
const mixMax = (field) => (field === "level" ? 1.5 : 1);

function mixStrip(name) {
  const row = document.createElement("div");
  row.className = "mixrow";
  const title = document.createElement("span");
  title.className = "mixname";
  title.textContent = MIX[name].label;
  row.appendChild(title);
  for (const field of MIX_FIELDS) {
    const id = `${name}-${field}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.className = "sr";
    label.textContent = `${MIX[name].label} ${field}`;
    const input = document.createElement("input");
    Object.assign(input, {type: "range", id, min: 0, max: mixMax(field),
                          step: 0.01, value: MIX[name][field]});
    const out = document.createElement("output");
    out.id = `${id}-out`;
    row.append(label, input, out);
  }
  return row;
}

/* Built from MIX rather than written out, so a channel cannot exist in the
   graph without a strip to move it. The strips go into the document first and
   are wired second, because `bind` finds its control by id. */
function buildMixer() {
  const grid = $("mixer");
  for (const name of CHANNELS) grid.appendChild(mixStrip(name));
  for (const name of CHANNELS) {
    for (const field of MIX_FIELDS) {
      bind(`${name}-${field}`, (v) => {
        const param = field === "level" ? bus[name].input.gain
                                        : bus[name].sends[field].gain;
        param.setTargetAtTime(field === "level" ? channelGain(name) : v,
                              ctx.currentTime, 0.02);
      }, (v) => v.toFixed(2));
    }
  }
}

// Audio controls are ours and need no round trip, so they move while it sounds.
const setRoom = {};       // id -> set the slider and apply it, without a gesture
const bind = (id, fn, fmt, onRelease = false) => {
  const el = $(id), out = $(`${id}-out`);
  const show = () => { out.textContent = fmt(parseFloat(el.value)); };
  // `master` rather than `ctx`: the context exists while the recordings are
  // still loading, and the nodes do not.
  const apply = () => { if (master) fn(parseFloat(el.value)); };
  el.addEventListener("input", onRelease ? show : () => { show(); apply(); });
  if (onRelease) el.addEventListener("change", apply);
  show();
  setRoom[id] = (v) => { el.value = v; show(); apply(); };
};
buildMixer();
bind("master", (v) => master.gain.setTargetAtTime(v, ctx.currentTime, 0.02),
     (v) => v.toFixed(2));
bind("verb", (v) => reverbReturn.gain.setTargetAtTime(v, ctx.currentTime, 0.02),
     (v) => v.toFixed(2));
// Only on release: makeImpulse fills sampleRate * seconds random samples, so
// at the slider's top a single drag would build ~200 MB of impulse response
// on the thread that is also feeding the scheduler.
bind("decay", (v) => { convolver.buffer = makeImpulse(v); },
     (v) => `${v.toFixed(1)} s`, true);
bind("predelay",
     (v) => preDelay.delayTime.setTargetAtTime(v / 1000, ctx.currentTime, 0.02),
     (v) => `${v.toFixed(0)} ms`);
bind("tone", (v) => tone.frequency.setTargetAtTime(v, ctx.currentTime, 0.05),
     (v) => `${(v / 1000).toFixed(1)} kHz`);
// The delay time glides rather than jumps: a step in a delay line is a pitch
// jump in whatever is still sounding in it.
bind("dtime", () => delayNode.delayTime.setTargetAtTime(delaySeconds(), ctx.currentTime, 0.08),
     (v) => {
       const ms = v * sixteenthS() * 1000;
       return `${v} \u00b7 ${ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}`;
     });
bind("dfeed", (v) => feedback.gain.setTargetAtTime(v, ctx.currentTime, 0.02),
     (v) => v.toFixed(2));
bind("dtone", (v) => fbTone.frequency.setTargetAtTime(v, ctx.currentTime, 0.05),
     (v) => `${(v / 1000).toFixed(1)} kHz`);
bind("dlevel", (v) => delayReturn.gain.setTargetAtTime(v, ctx.currentTime, 0.02),
     (v) => v.toFixed(2));

const roomSel = $("preset");
for (const name of Object.keys(ROOMS)) roomSel.appendChild(new Option(name, name));
function applyRoom() {
  const room = ROOMS[roomSel.value];
  for (const f of ROOM_FIELDS) setRoom[f](room[f]);
}
roomSel.addEventListener("change", applyRoom);
// Through the same path as any other choice, so ROOMS is the only place a
// room is written down and the select cannot label one thing while the
// sliders say another.
roomSel.value = "chapel";
applyRoom();

setInterval(fill, TICK_MS);
// Only the countdown moves on its own; dirty state changes go through
// renderParams, which redraws the line itself.
setInterval(() => { if (applyAt !== null) renderStatus(); }, 250);
