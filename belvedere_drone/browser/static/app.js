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

// The VCSL sustains are quiet -- they peak between 0.02 and 0.13, and the C4
// the drone uses is the quietest of them. Played back at their own level the
// instrument is barely audible, so the mix gets a fixed makeup stage and a
// limiter behind it to catch the moments several notes and a long reverb tail
// land together.
const MAKEUP = 6.0;

// the graph, built once
let master = null, dryGain = null, wetGain = null, convolver = null,
    preDelay = null, tone = null, sum = null, limiter = null;

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

   voices -> tone -> [ dry ---------------------> ] sum -> makeup
                     [ wet -> preDelay -> conv -> ]           |
                              master -> limiter -> destination            */

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

  sum = ctx.createGain();
  sum.connect(master);

  tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = parseFloat($("tone").value);
  tone.Q.value = 0.7;

  dryGain = ctx.createGain();
  wetGain = ctx.createGain();
  preDelay = ctx.createDelay(0.5);
  convolver = ctx.createConvolver();
  convolver.normalize = true;

  tone.connect(dryGain).connect(sum);
  tone.connect(wetGain).connect(preDelay).connect(convolver).connect(sum);
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

function voice(chamber, noteName, at, dur, velocity) {
  const spec = inst.voices[chamber][noteName];
  const loop = inst.loops[spec.file];
  const src = ctx.createBufferSource();
  src.buffer = buffers[spec.file];
  src.loop = true;
  // The loop the sample was authored around, and the cents the profile says
  // this pipe is off equal temperament. Both arrive as-is: no conversion.
  src.loopStart = loop.loop_start_s;
  src.loopEnd = loop.loop_end_s;
  src.detune.value = spec.cents;

  const g = ctx.createGain();
  const amp = Math.pow(velocity / 127, 1.4) * inst.chamber_gain[chamber];
  const a = Math.min(0.012, dur / 3);
  const r = Math.min(0.09, dur / 3);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(amp, at + a);
  g.gain.setValueAtTime(amp, at + dur - r);
  g.gain.linearRampToValueAtTime(0, at + dur);

  src.connect(g).connect(tone);
  src.start(at);
  src.stop(at + dur + 0.02);
  live.push(src);
  src.onended = () => { live = live.filter((s) => s !== src); };
  return src;
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

  const droneSpec = inst.voices.drone[b.drone];
  const loop = inst.loops[droneSpec.file];
  const src = ctx.createBufferSource();
  src.buffer = buffers[droneSpec.file];
  src.loop = true;
  src.loopStart = loop.loop_start_s;
  src.loopEnd = loop.loop_end_s;
  src.detune.value = droneSpec.cents;
  const dg = ctx.createGain();
  dg.gain.value = Math.pow(b.drone_velocity / 127, 1.4)
                  * inst.chamber_gain.drone;
  src.connect(dg).connect(env);
  src.start(t0);
  src.stop(t0 + b.length_s + 0.05);
  live.push(src);
  src.onended = () => { live = live.filter((s) => s !== src); };

  for (const n of b.notes) {
    const at = t0 + n.start_s;
    const dur = Math.min(n.dur_s, b.length_s - n.start_s);
    if (dur <= 0.005) continue;
    const spec = inst.voices.melody[n.name];
    const lp = inst.loops[spec.file];
    const s = ctx.createBufferSource();
    s.buffer = buffers[spec.file];
    s.loop = true;
    s.loopStart = lp.loop_start_s;
    s.loopEnd = lp.loop_end_s;
    s.detune.value = spec.cents;
    const g = ctx.createGain();
    const amp = Math.pow(n.velocity / 127, 1.4) * inst.chamber_gain.melody;
    const a = Math.min(0.012, dur / 3), r = Math.min(0.06, dur / 3);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(amp, at + a);
    g.gain.setValueAtTime(amp, at + dur - r);
    g.gain.linearRampToValueAtTime(0, at + dur);
    s.connect(g).connect(env);
    s.start(at);
    s.stop(at + dur + 0.02);
    live.push(s);
    s.onended = () => { live = live.filter((x) => x !== s); };
  }

  cursor = t0 + b.length_s + b.inhale_s;
  remember(b, t0);
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

function remember(b, at) {
  history.unshift({b, at});
  history = history.slice(0, 8);
  const names = b.notes.filter((n) => !n.grace).map((n) => n.name).join(" ");
  $("log").textContent = history.map(({b}) =>
    `breath ${String(b.index).padStart(3)}  ${b.bars} bar  ` +
    `${b.length_s.toFixed(2)}s  ${b.layer.padEnd(6)} ${b.role.padEnd(18)} ` +
    b.notes.filter((n) => !n.grace).map((n) => n.name).join(" ")
  ).join("\n");
  $("now").textContent = `breath ${b.index} · ${b.bars} bar · ${b.layer} · ${names}`;
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

  const show = () => {
    out.textContent = Number(input.value).toFixed(DECIMALS[name] ?? 2);
    row.classList.toggle("edited",
      Math.abs(parseFloat(input.value) - inst.params[name]) > 1e-9);
  };
  input.addEventListener("input", show);
  input.addEventListener("change", () => {
    reshape({[name]: parseFloat(input.value)});
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

  $("mood").value = inst.params.mood;
  $("root").value = inst.params.root;
  if (document.activeElement !== $("seed")) $("seed").value = inst.params.seed;
  for (const row of document.querySelectorAll("[data-field]")) {
    const name = row.dataset.field;
    const input = row.querySelector("input");
    if (document.activeElement !== input) input.value = inst.params[name];
    row.querySelector("output").textContent =
      Number(inst.params[name]).toFixed(DECIMALS[name] ?? 2);
    row.classList.remove("edited");
  }
  $("meter").textContent =
    `${inst.meter.bpm} bpm · ${inst.meter.beats_per_measure}/4 · ` +
    `bar ${inst.meter.measure_s.toFixed(2)}s`;
}

/* Anything that shapes the music goes back to Python; the change lands on the
   next breath the page asks for, so the ones already scheduled play out. That
   is the same "applies on a breath boundary" the organ player has, without
   its submit gate -- this one is a toy and answers immediately. */
async function reshape(changes) {
  if (!inst) return;
  try {
    inst = await api("/performance", changes);
  } catch (err) {
    note(`refused: ${err.message}`);
    return;
  }
  describe();
  note("takes effect on the next breath");
}

/* ---------- wiring ---------- */

$("run").addEventListener("click", () => (running ? stop() : start()));
// Choosing a preset moves every weight it owns, tempo included.
$("mood").addEventListener("change", () => {
  const name = $("mood").value;
  reshape(Object.assign({mood: name}, inst.preset_weights[name] || {}));
});
$("root").addEventListener("change", () => reshape({root: $("root").value}));
$("seed").addEventListener("change",
  () => reshape({seed: parseInt($("seed").value, 10) || 0}));
$("reseed").addEventListener("click", () => {
  reshape({seed: Math.floor(Math.random() * 2 ** 31)});
});

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
const bind = (id, fn, fmt) => {
  const el = $(id), out = $(`${id}-out`);
  const apply = () => {
    const v = parseFloat(el.value);
    out.textContent = fmt(v);
    if (ctx) fn(v);
  };
  el.addEventListener("input", apply);
  apply();
};
bind("master",
     (v) => master.gain.setTargetAtTime(v * MAKEUP, ctx.currentTime, 0.02),
     (v) => v.toFixed(2));
bind("wet", (v) => setWet(v), (v) => v.toFixed(2));
bind("decay", (v) => { convolver.buffer = makeImpulse(v); },
     (v) => `${v.toFixed(1)} s`);
bind("predelay",
     (v) => preDelay.delayTime.setTargetAtTime(v / 1000, ctx.currentTime, 0.02),
     (v) => `${v.toFixed(0)} ms`);
bind("tone", (v) => tone.frequency.setTargetAtTime(v, ctx.currentTime, 0.05),
     (v) => `${(v / 1000).toFixed(1)} kHz`);

setInterval(fill, TICK_MS);
