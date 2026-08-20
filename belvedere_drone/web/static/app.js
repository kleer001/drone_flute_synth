"use strict";
/* The page holds a working copy; the engine holds the truth (SPEC §10.6).
   Polls update the committed baseline only, so a field you are editing is
   never overwritten underneath you. */

const POLL_MS = 250;
const TOKEN = new URLSearchParams(location.search).get("token");

const LABELS = {
  notes_per_breath: "Notes per breath",
  step_leap_ratio: "Step : leap ratio",
  ornament_rate: "Ornament rate",
  cadence_strength: "Cadence strength",
  register_bias: "Register bias",
  sweep_depth: "Dynamic sweep depth",
  pushed_bias: "'Pushed' layer bias",
  breath_mean_s: "Breath mean (s)",
  breath_spread_s: "Breath spread (s)",
  inhale_s: "Inhale gap (s)",
};
const BREATH_FIELDS = ["breath_spread_s", "inhale_s"];

const $ = (id) => document.getElementById(id);

let committed = null;     // engine truth, refreshed by every poll
let working = {};         // what this page shows
let ranges = {};
let built = false;
let runId = null;
let inFlight = null;
let drainAt = null;       // performance.now() ms when the pending set lands
let clashHeld = false;    // user chose "keep editing" over a remote change
let offline = false;
let mySubmission = null;  // so our own set draining is not read as a clash
let polling = false;      // one poll at a time: two interleaved polls raced
let presetWeights = {};
let weightNames = [];

/* ---------- transport ---------- */

async function api(path, body) {
  const opts = { method: body === undefined ? "GET" : "POST",
                 headers: {} };
  if (TOKEN) opts.headers["X-Token"] = TOKEN;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* ---------- building the form ---------- */

function slider(name) {
  const [lo, hi] = ranges[name];
  const step = (hi - lo) > 6 ? 0.5 : 0.01;
  const label = document.createElement("label");
  label.dataset.field = name;
  label.innerHTML =
    `${LABELS[name] || name} <output></output>` +
    `<input type="range" min="${lo}" max="${hi}" step="${step}">`;
  const input = label.querySelector("input");
  input.addEventListener("input", () => {
    working[name] = parseFloat(input.value);
    render();
  });
  return label;
}

/* §10.7: moving any weight makes the set no longer the named preset. The
   engine still needs a real preset name -- phrase_shape has no slider and
   comes from it -- so "Custom" is a display state, not a value we submit. */
function isCustom() {
  const preset = presetWeights[working.mood];
  if (!preset) return false;
  return weightNames.some(
    (n) => Math.abs(parseFloat(working[n]) - preset[n]) > 1e-9);
}

function build(state) {
  ranges = state.ranges;
  $("display").textContent = state.readonly.display;
  $("provenance").textContent = state.readonly.provenance;

  const root = $("root");
  root.innerHTML = "";
  for (const note of state.readonly.drone_notes) {
    root.appendChild(new Option(note, note));
  }
  root.addEventListener("change", () => { working.root = root.value; render(); });

  presetWeights = state.preset_weights;
  weightNames = state.mood_weights;
  const mood = $("mood");
  mood.innerHTML = "";
  for (const name of state.presets) mood.appendChild(new Option(name, name));
  const custom = new Option("Custom (edited weights)", "custom");
  custom.disabled = true;
  mood.appendChild(custom);
  mood.addEventListener("change", () => {
    // Choosing a preset overwrites all eight weights (§10.7). Still a
    // working-copy edit: nothing sounds different until Submit.
    if (mood.value === "custom") return;
    working.mood = mood.value;
    Object.assign(working, presetWeights[mood.value] || {});
    render();
  });

  $("weights").innerHTML = "";
  for (const name of state.mood_weights) $("weights").appendChild(slider(name));
  $("breath").innerHTML = "";
  for (const name of BREATH_FIELDS) $("breath").appendChild(slider(name));

  $("seed").addEventListener("input", (e) => {
    working.seed = e.target.value; render();
  });
  $("reseed").addEventListener("click", () => {
    working.seed = String(Math.floor(Math.random() * 2 ** 31));
    $("seed").value = working.seed;
    render();
  });

  const ro = $("ro");
  ro.innerHTML = "";
  for (const [k, v] of [["Profile", state.readonly.profile_id],
                        ["Concert reference", state.readonly.concert_a_hz + " Hz"],
                        ["Tuning origin", state.readonly.tuning_origin],
                        ["ODF", state.readonly.odf_path]]) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    ro.append(dt, dd);
  }
  built = true;
}

/* ---------- rendering ---------- */

function isDirty(name) {
  if (!committed) return false;
  const a = working[name], b = committed[name];
  if (typeof b === "number") return Math.abs(parseFloat(a) - b) > 1e-9;
  return String(a) !== String(b);
}

function anyDirty() {
  return Object.keys(committed || {}).some(isDirty);
}

function render() {
  if (!built || !committed) return;
  const locked = offline || inFlight !== null;

  $("root").value = working.root;
  $("mood").value = isCustom() ? "custom" : working.mood;
  if (document.activeElement !== $("seed")) $("seed").value = working.seed;

  for (const label of document.querySelectorAll("[data-field]")) {
    const name = label.dataset.field;
    const input = label.querySelector("input");
    if (document.activeElement !== input) input.value = working[name];
    label.querySelector("output").textContent =
      Number(working[name]).toFixed(name === "notes_per_breath" ? 1 : 2);
    label.classList.toggle("dirty", isDirty(name));
    input.disabled = locked;
  }
  for (const [id, field] of [["root", "root"], ["mood", "mood"], ["seed", "seed"]]) {
    const el = $(id);
    el.disabled = locked;
    el.parentElement.classList.toggle("dirty", isDirty(field));
  }
  $("reseed").disabled = locked;

  const dirty = anyDirty();
  $("submit").disabled = locked || !dirty;
  $("revert").disabled = locked || !dirty;
  $("regenerate").disabled = offline;
  $("runbtn").disabled = offline;
  $("level").disabled = offline;
  $("panic").disabled = offline;

  renderStatus();
}

function renderStatus() {
  const el = $("status");
  if (inFlight === null) {
    el.className = "status";
    el.textContent = anyDirty() ? "Unsubmitted changes." : "";
    return;
  }
  el.className = "status pending";
  const left = drainAt === null ? null : (drainAt - performance.now()) / 1000;
  if (left === null || left <= 0) {
    // §10.5: when the countdown runs out and the set has not drained, an
    // indeterminate spinner is the honest display.
    el.innerHTML = '<span class="spinner"></span>Applying…';
  } else {
    el.textContent = `Applies in ${Math.ceil(left)} s`;
  }
}

/* ---------- polling ---------- */

async function poll() {
  // At 4 Hz a slow response would otherwise let two polls interleave, and the
  // second could clear the state the first is about to read.
  if (polling) return;
  polling = true;
  try {
    await pollOnce();
  } finally {
    polling = false;
  }
}

async function pollOnce() {
  let state;
  try {
    const res = await api("/state");
    if (!res.ok) throw new Error(res.status);
    state = res.data;
  } catch (err) {
    setOffline(true);
    return;
  }
  setOffline(false);

  if (runId !== null && state.run_id !== runId) { location.reload(); return; }
  runId = state.run_id;

  if (!built) {
    build(state);
    committed = state.committed;
    working = Object.assign({}, state.committed);
  } else {
    const changedRemotely =
      committed && JSON.stringify(committed) !== JSON.stringify(state.committed);
    // Our own submission draining changes `committed` too. That is not another
    // tab, so it must not raise the clash banner.
    const drainedMine = mySubmission !== null && inFlight === mySubmission
                        && state.in_flight === null;
    if (drainedMine) mySubmission = null;
    const wasDirty = anyDirty();
    committed = state.committed;
    if (changedRemotely && wasDirty && !clashHeld && !drainedMine) {
      $("clash").hidden = false;
    } else if (changedRemotely && !wasDirty) {
      working = Object.assign({}, state.committed);
      $("clash").hidden = true;
      clashHeld = false;
    }
  }

  inFlight = state.in_flight;
  drainAt = state.next_drain_in === null
    ? null : performance.now() + state.next_drain_in * 1000;
  if (inFlight === null) clashHeld = false;

  if (document.activeElement !== $("level")) $("level").value = state.master_level;
  $("level-out").textContent = state.master_level;
  $("runbtn").textContent = state.running ? "Stop" : "Start";
  $("engine-line").textContent =
    `breath ${state.breath_index} · seed ${state.seed} · run ${state.run_id}`;
  render();
}

function setOffline(value) {
  if (offline === value) return;
  offline = value;
  $("disconnected").hidden = !value;
  document.body.classList.toggle("offline", value);
  render();
}

/* ---------- actions ---------- */

$("submit").addEventListener("click", async () => {
  $("errors").hidden = true;
  const res = await api("/submit", working);
  if (res.status === 422) {
    const box = $("errors");
    box.hidden = false;
    box.replaceChildren(...Object.entries(res.data.errors).flatMap(([f, why]) => {
      const name = document.createElement("strong");
      name.textContent = f;
      return [name, document.createTextNode(`: ${why}`),
              document.createElement("br")];
    }));
    return;
  }
  mySubmission = res.data.submission_id;
  $("clash").hidden = true;
  poll();
});

$("revert").addEventListener("click", () => {
  working = Object.assign({}, committed);
  $("errors").hidden = true;
  render();
});

$("runbtn").addEventListener("click", async () => {
  await api($("runbtn").textContent === "Stop" ? "/stop" : "/start", {});
  poll();
});
$("panic").addEventListener("click", () => api("/panic", {}));
$("level").addEventListener("input", (e) => {
  $("level-out").textContent = e.target.value;
  api("/level", { value: parseInt(e.target.value, 10) });
});

$("regenerate").addEventListener("click", async () => {
  const res = await api("/regenerate", {});
  const note = $("regen-note");
  if (!res.ok) { note.textContent = "Regenerate failed."; return; }
  const path = document.createElement("code");
  path.textContent = res.data.odf_path;
  note.replaceChildren(
    document.createTextNode("Regenerated ODF written to "), path,
    document.createTextNode(". Press File → Reload in GrandOrgue, then restart " +
      "the player. Sound stops while the sample set loads, and the drone " +
      "will break."));
});

$("keep-editing").addEventListener("click", () => {
  clashHeld = true; $("clash").hidden = true;
});
$("discard").addEventListener("click", () => {
  working = Object.assign({}, committed);
  clashHeld = false; $("clash").hidden = true; $("errors").hidden = true;
  render();
});

setInterval(poll, POLL_MS);
setInterval(renderStatus, 200);
poll();
