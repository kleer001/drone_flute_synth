"use strict";
/* The browser is the instrument here. Python plans a breath and hands it over;
   this schedules it on the audio clock.

   Everything is scheduled ahead of time against `AudioContext.currentTime`,
   never against a timer. setInterval drifts and stalls when the tab is busy;
   the audio clock does neither, which is why the drone does not wobble. The
   timer's only job is to ask "is there less than LOOKAHEAD_S of music
   scheduled?" often enough that the answer is never yes for long. */

const LOOKAHEAD_S = 4.0;      // keep this much music scheduled ahead
const TICK_MS = 250;

let ctx = null;
let inst = null;              // what /instrument said
let buffers = {};             // file name -> AudioBuffer
let running = false;
let cursor = 0;               // audio-clock time the next breath begins
let live = [];                // sources still sounding, for a clean stop
let history = [];
let working = {};             // what the performance tab shows
let applyAt = null;           // audio-clock time a submitted set starts sounding

// The VCSL sustains are quiet -- they peak between 0.02 and 0.13, and the C4
// the drone uses is the quietest of them. Played back at their own level the
// instrument is barely audible, so the mix gets a fixed makeup stage and a
// limiter behind it to catch the moments several notes and a long reverb tail
// land together.
const MAKEUP = 6.0;

// the graph, built once
let master = null, dryGain = null, wetGain = null, convolver = null,
    preDelay = null, tone = null, limiter = null;

const LABELS = {
  notes_per_breath: "notes / breath", step_leap_ratio: "step : leap",
  ornament_rate: "ornament", cadence_strength: "cadence",
  register_bias: "register bias", sweep_depth: "sweep depth",
  pushed_bias: "pushed bias", trill_rate: "trill",
  call_response: "call / answer", bpm: "tempo",
  breath_mean_s: "breath mean", breath_spread_s: "breath spread",
  inhale_s: "inhale gap",
};
const DECIMALS = {notes_per_breath: 1, breath_mean_s: 1, breath_spread_s: 1,
                  inhale_s: 2, bpm: 0};
const STEPS = {bpm: 1};      // tempo counts whole beats, not half ones

/* Rooms. These live here rather than in the profile because they are not
   properties of the instrument -- the same flute can be played in any of
   them, and none of it reaches the engine. */
const ROOMS = {
  "dry":       {wet: 0.04, decay: 0.5, predelay: 0,  tone: 18000},
  "small room":{wet: 0.18, decay: 1.1, predelay: 8,  tone: 15000},
  "chapel":    {wet: 0.32, decay: 2.6, predelay: 22, tone: 12000},
  "hall":      {wet: 0.42, decay: 4.2, predelay: 35, tone: 10000},
  "cathedral": {wet: 0.52, decay: 6.5, predelay: 55, tone: 8000},
  "canyon":    {wet: 0.62, decay: 8.0, predelay: 110, tone: 6000},
};
const ROOM_FIELDS = ["wet", "decay", "predelay", "tone"];

const $ = (id) => document.getElementById(id);

/* ---------- transport ---------- */

async function api(path, body) {
  const opts = body === undefined
    ? {} : {method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body)};
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ---------- the audio graph ----------

   voices -> tone -> [ dry --------------------> ] master -> limiter
                     [ wet -> preDelay -> conv -> ]              -> destination */

function buildGraph() {
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  master = ctx.createGain();
  master.gain.value = parseFloat($("master").value) * MAKEUP;
  master.connect(limiter);

  tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = parseFloat($("tone").value);
  tone.Q.value = 0.7;

  dryGain = ctx.createGain();
  wetGain = ctx.createGain();
  preDelay = ctx.createDelay(0.5);
  convolver = ctx.createConvolver();
  convolver.normalize = true;

  tone.connect(dryGain).connect(master);
  tone.connect(wetGain).connect(preDelay).connect(convolver).connect(master);
  setWet(parseFloat($("wet").value));
  preDelay.delayTime.value = parseFloat($("predelay").value) / 1000;
  convolver.buffer = makeImpulse(parseFloat($("decay").value));
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

function setWet(v) {
  // Equal-power, so moving the control changes the room and not the level.
  wetGain.gain.value = Math.sin(v * Math.PI / 2);
  dryGain.gain.value = Math.cos(v * Math.PI / 2);
}

/* ---------- loading ---------- */

async function loadBuffers() {
  const names = Object.keys(inst.loops);
  const got = await Promise.all(names.map(async (name) => {
    // A#4_loop.wav and friends: an unescaped # is a fragment, so the
    // request would arrive as /loops/A.
    const res = await fetch(`/loops/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return ctx.decodeAudioData(await res.arrayBuffer());
  }));
  names.forEach((n, i) => { buffers[n] = got[i]; });
}

/* ---------- playing one note ---------- */

/* Every voice is the same thing: a loop from the sample set, at the pitch the
   profile asks for. loopStart/loopEnd are the smpl chunk's own points and
   detune is the cents table's own value, so neither is converted here. */
function source(spec, at, until) {
  const loop = inst.loops[spec.file];
  const src = ctx.createBufferSource();
  src.buffer = buffers[spec.file];
  src.loop = true;
  src.loopStart = loop.loop_start_s;
  src.loopEnd = loop.loop_end_s;
  src.detune.value = spec.cents;
  src.start(at);
  src.stop(until);
  live.push(src);
  src.onended = () => { live = live.filter((s) => s !== src); };
  return src;
}

/* One melody note: a voice under its own short envelope, so it starts and
   stops without a click inside the breath the caller is shaping. */
function voice(spec, at, dur, velocity, dest) {
  const g = ctx.createGain();
  const amp = Math.pow(velocity / 127, 1.4) * inst.chamber_gain.melody;
  const a = Math.min(0.012, dur / 3), r = Math.min(0.06, dur / 3);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(amp, at + a);
  g.gain.setValueAtTime(amp, at + dur - r);
  g.gain.linearRampToValueAtTime(0, at + dur);
  source(spec, at, at + dur + 0.02).connect(g).connect(dest);
}

/* ---------- playing one breath ---------- */

function scheduleBreath(b) {
  const t0 = cursor;

  // The drone runs the whole breath, under the shared breath envelope: both
  // chambers rise and fall together, which is the instrument's whole argument.
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(1, t0 + inst.attack_s);
  env.gain.setValueAtTime(1, t0 + b.length_s - inst.release_s);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + b.length_s);
  env.connect(tone);

  const drone = ctx.createGain();
  drone.gain.value = Math.pow(b.drone_velocity / 127, 1.4)
                     * inst.chamber_gain.drone;
  source(inst.voices.drone[b.drone], t0, t0 + b.length_s + 0.05)
    .connect(drone).connect(env);

  for (const n of b.notes) {
    const at = t0 + n.start_s;
    const dur = Math.min(n.dur_s, b.length_s - n.start_s);
    if (dur <= 0.005) continue;
    voice(inst.voices.melody[n.name], at, dur, n.velocity, env);
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
      scheduleBreath(await api("/breath"));
    }
  } catch (err) {
    note(`lost the server: ${err.message}`);
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
    `${h.length_s.toFixed(2)}s  ${h.layer.padEnd(6)} ${h.role.padEnd(18)} ` +
    sounded(h)).join("\n");
  $("now").textContent =
    `breath ${b.index} · ${b.bars} bar · ${b.layer} · ${sounded(b)}`;
}

function note(msg) { $("note").textContent = msg; }

/* ---------- start / stop ---------- */

async function start() {
  if (running) return;
  if (!ctx) {
    // An AudioContext may only begin from a gesture, so everything that needs
    // one is built here rather than at load.
    ctx = new AudioContext();
    note("loading loops…");
    inst = await api("/instrument");
    await loadBuffers();
    buildGraph();
    describe();
  }
  await ctx.resume();
  running = true;
  cursor = ctx.currentTime + 0.15;
  $("run").textContent = "■";
  $("lamp").classList.add("on");
  note("");
  fill();
}

function stop() {
  running = false;
  for (const s of live) { try { s.stop(); } catch (e) { /* already done */ } }
  live = [];
  $("run").textContent = "▶";
  $("lamp").classList.remove("on");
  $("now").textContent = "";
}

/* One row of the performance panel. Display follows the drag; the engine is
   told on release, so a slider does not post thirty times on the way. */
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

let built = false;
function describe() {
  document.title = inst.profile;
  $("title").textContent = inst.profile;
  $("prov").textContent = inst.provenance;

  if (!built) {
    const m = $("mood");
    for (const name of inst.moods) m.appendChild(new Option(name, name));
    const r = $("root");
    for (const n of inst.drone_notes) r.appendChild(new Option(n, n));
    for (const name of inst.mood_weights) $("weights").appendChild(paramRow(name));
    for (const name of inst.breath_fields) $("breath").appendChild(paramRow(name));
    built = true;
  }

  working = Object.assign({}, inst.params);
  renderParams();
  $("meter").textContent =
    `${inst.meter.bpm} bpm · ${inst.meter.beats_per_measure}/4 · ` +
    `bar ${inst.meter.measure_s.toFixed(2)}s`;
}

function isDirty(name) {
  const a = working[name], b = inst.params[name];
  return typeof b === "number"
    ? Math.abs(parseFloat(a) - b) > 1e-9 : String(a) !== String(b);
}

const anyDirty = () =>
  inst !== null && Object.keys(inst.params).some(isDirty);

/* The working copy on screen, and whether it differs from what is sounding. */
function renderParams() {
  $("mood").value = working.mood;
  $("root").value = working.root;
  if (document.activeElement !== $("seed")) $("seed").value = working.seed;
  for (const row of document.querySelectorAll("[data-field]")) {
    const name = row.dataset.field;
    const input = row.querySelector("input");
    if (document.activeElement !== input) input.value = working[name];
    row.querySelector("output").textContent =
      Number(working[name]).toFixed(DECIMALS[name] ?? 2);
    row.classList.toggle("edited", isDirty(name));
  }
  for (const name of ["mood", "root", "seed"]) {
    $(name).closest(".param").classList.toggle("edited", isDirty(name));
  }
  const dirty = anyDirty();
  $("submit").disabled = !dirty;
  $("revert").disabled = !dirty;
  renderStatus();
}

/* The page owns the schedule, so it knows exactly when a submitted set starts
   sounding: at the end of what is already scheduled. */
function renderStatus() {
  const el = $("status");
  if (applyAt === null) {
    el.className = "status";
    el.textContent = anyDirty() ? "Unsubmitted changes." : "";
    return;
  }
  const left = applyAt - (ctx ? ctx.currentTime : 0);
  if (left <= 0) { applyAt = null; el.className = "status"; el.textContent = "";
                   return; }
  el.className = "status pending";
  el.textContent = `Applies in ${Math.ceil(left)} s`;
}

/* Anything that shapes the music goes back to Python; the change lands on the
   next breath the page asks for, so the ones already scheduled play out. That
   is the same "applies on a breath boundary" the organ player has, without
   its submit gate -- this one is a toy and answers immediately. */
async function submit() {
  if (!inst || !anyDirty()) return;
  const pending = Object.assign({}, working);
  try {
    inst = await api("/performance", pending);
  } catch (err) {
    note(`refused: ${err.message}`);
    return;
  }
  // Breaths already scheduled play out first, so the set starts sounding
  // where the schedule currently ends.
  applyAt = running ? cursor : null;
  describe();
  working = pending;
  renderParams();
  note("");
}

function revert() {
  working = Object.assign({}, inst.params);
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
$("root").addEventListener("change", () => {
  working.root = $("root").value; renderParams();
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

// Audio controls are ours and need no round trip, so they move while it sounds.
const bind = (id, fn, fmt, onRelease = false) => {
  const el = $(id), out = $(`${id}-out`);
  const show = () => { out.textContent = fmt(parseFloat(el.value)); };
  const apply = () => { if (ctx) fn(parseFloat(el.value)); };
  el.addEventListener("input", onRelease ? show : () => { show(); apply(); });
  if (onRelease) el.addEventListener("change", apply);
  show();
};
bind("master",
     (v) => master.gain.setTargetAtTime(v * MAKEUP, ctx.currentTime, 0.02),
     (v) => v.toFixed(2));
bind("wet", (v) => setWet(v), (v) => v.toFixed(2));
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

const roomSel = $("preset");
for (const name of Object.keys(ROOMS)) roomSel.appendChild(new Option(name, name));
function applyRoom() {
  const room = ROOMS[roomSel.value];
  for (const f of ROOM_FIELDS) {
    $(f).value = room[f];
    $(f).dispatchEvent(new Event("input"));
    $(f).dispatchEvent(new Event("change"));
  }
}
roomSel.addEventListener("change", applyRoom);
// Through the same path as any other choice, so ROOMS is the only place a
// room is written down and the select cannot label one thing while the
// sliders say another.
roomSel.value = "chapel";
applyRoom();

setInterval(fill, TICK_MS);
setInterval(renderStatus, 250);
