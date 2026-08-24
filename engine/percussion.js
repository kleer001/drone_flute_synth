import { round } from "./rng.js";

export const DRUM_POOL = "frame_drum";
export const RATTLE_POOL = "rattle";
export const WASH_POOL = "rain_stick";

// Which stroke of a pool serves which role. Pools name their strokes
// differently, so this is a table rather than a guess.
const DRUM_STROKES = {
  frame_drum: { strong: "hit", weak: "muted" },
  frame_drum_small: { strong: "hit", weak: "muted" },
  cabasa: { strong: "hit", weak: "rub" },
  guiro: { strong: "hit", weak: "med" },
};
// A rattle's two strokes are the two halves of one gesture: `cell` carries the
// figure and `fill` is the return stroke between its onsets, which is what a
// player adds to get busier.
//
// `fillVelocity` is per pool because how loud a fill stroke is, is a fact
// about the recordings. The engine levels every take of one stroke to a common
// loudness but never across two -- a muted hit really is quieter than an open
// one -- so a single velocity lands somewhere different in every pool: at 44
// the cabasa's rub arrives 6 dB *over* its own hit while the rattle's
// up-stroke is 4 dB under it. These put every pool's fill about 4 dB under its
// softest cell stroke, which `check.mjs` measures rather than trusts.
export const RATTLE_STROKE_ROLES = {
  rattle: { cell: "down", fill: "up", fillVelocity: 43 },
  rattle_small: { cell: "double_down", fill: "double_up", fillVelocity: 35 },
  cabasa: { cell: "hit", fill: "rub", fillVelocity: 19 },
  guiro: { cell: "hit", fill: "fast", fillVelocity: 43 },
};
// The wash pool is fixed, so its stroke is a constant rather than a table --
// the shaker roll and the slow guiro would serve if it ever became a choice.
export const WASH_STROKE = "wash";

export const DRUM_POOLS = Object.keys(DRUM_STROKES);
export const RATTLE_POOLS = Object.keys(RATTLE_STROKE_ROLES);

// A wash runs far longer than a strike, so two overlapping read as one smeared
// gesture rather than two. Breaths, not seconds: a slow mood's breath is long.
export const WASH_MIN_GAP = 4;
export const WASH_VELOCITY = 48;

const DRUM_VELOCITY = { 3: 104, 2: 80, 1: 60 };
const RATTLE_VELOCITY = { 3: 82, 2: 70, 1: 60 };
// The softest cell stroke, which the fill is levelled against. Named because
// two places depend on it being the floor of the accents.
export const RATTLE_WEAKEST = RATTLE_VELOCITY[1];
// How far under it a fill sits, in dB. The fill is the surface the figure is
// heard on, so it is one level wherever it lands -- accenting it would put a
// second figure in the same layer.
export const RATTLE_FILL_UNDER_DB = 4.0;
const DRUM_TAIL_BARS = 1;

/* Downbeat, beat, offbeat -- read off the meter rather than off a literal, so
   changing the unit moves the accent with it. */
const weightOf = (u, meter) =>
  u % meter.unitsPerMeasure === 0 ? 3 : u % meter.UNITS_PER_BEAT === 0 ? 2 : 1;

/* The motif's durations are a rhythm cell. Augmented, its cycle rarely divides
   the bar, so it phases against it. */
export function timelineCell(motif, scale) {
  const onsets = [];
  let at = 0;
  for (const [, dur] of motif) { onsets.push(at); at += Math.max(1, round(dur * scale)); }
  return { onsets, length: Math.max(1, at) };
}

/* The tune on the grid, ornaments dropped. */
export function reduce(notes, units, unitS) {
  const grid = new Array(units).fill(0);
  for (const n of notes) {
    if (n.isGrace) continue;
    const u = round(n.startS / unitS);
    if (u >= 0 && u < units) grid[u] = Math.max(grid[u], n.velocity);
  }
  return grid;
}

/* A fraction of the slots offered, strongest first. Both layers fill by metric
   weight -- the drum answering the tune and the rattle filling its own cell --
   so where a fraction lands is decided once. */
function strongest(units, meter, fraction) {
  const sorted = units.slice().sort(
    (a, b) => weightOf(b, meter) - weightOf(a, meter) || a - b);
  return sorted.slice(0, round(sorted.length * fraction));
}

/* Strong empty slots inside the span the tune occupies: hits land where the
   tune is not, so the drum answers rather than doubles. */
export function hocket(tune, meter, density) {
  const first = tune.findIndex((v) => v);
  const out = new Array(tune.length).fill(0);
  if (first < 0) return out;
  let last = 0;
  tune.forEach((v, u) => { if (v) last = u; });
  const end = Math.min(tune.length, last + DRUM_TAIL_BARS * meter.unitsPerMeasure);
  const empty = [];
  for (let u = first; u < end; u++) if (!tune[u]) empty.push(u);
  for (const u of strongest(empty, meter, density)) out[u] = weightOf(u, meter);
  return out;
}

/* Both layers for one breath, as {startS, stroke, velocity}.
 *
 * `clock` is the performance's position in eighths. The rattle is indifferent
 * to the breath -- it runs through the inhale and across the bar line, which is
 * what makes it a reference the free melody is heard against. The drum is
 * derived from this breath's own notes, so a repeated block drums identically.
 */
export function rhythm({ motif, notes, meter, lengthS, inhaleS, clock,
                         drum, rattle, drumDensity, rattleScale, rattleFill,
                         drumPool = DRUM_POOL, rattlePool = RATTLE_POOL }) {
  const unitS = meter.unitS;
  const units = Math.max(1, round(lengthS / unitS));
  const out = { drum: [], rattle: [] };

  if (drum) {
    const strokes = DRUM_STROKES[drumPool];
    if (!strokes) throw new Error(`no drum stroke map for pool ${drumPool}`);
    hocket(reduce(notes, units, unitS), meter, drumDensity)
      .forEach((w, u) => {
        if (!w) return;
        out.drum.push({ startS: u * unitS, velocity: DRUM_VELOCITY[w],
                        stroke: w === 3 ? strokes.strong : strokes.weak });
      });
  }

  /* The cell carries the figure and the fill is the surface between its
     onsets. A player gets busier by subdividing rather than by skipping, so
     the fill only ever adds: at 0 the motif's rhythm sounds bare, at 1 every
     unit of the grid sounds and the cell is what is accented on top of it.
     Dropping cell onsets instead would thin the one thing the layer is for --
     how sparse the figure itself is, is `rattleScale`. */
  if (rattle) {
    const strokes = RATTLE_STROKE_ROLES[rattlePool];
    if (!strokes) throw new Error(`no rattle stroke map for pool ${rattlePool}`);
    const cell = timelineCell(motif, rattleScale);
    const total = units + Math.max(0, round(inhaleS / unitS));
    const gaps = [];
    for (let u = 0; u < total; u++) {
      if (cell.onsets.includes((clock + u) % cell.length)) {
        out.rattle.push({ startS: u * unitS, velocity: RATTLE_VELOCITY[weightOf(u, meter)],
                          stroke: strokes.cell });
      } else {
        gaps.push(u);
      }
    }
    for (const u of strongest(gaps, meter, rattleFill)) {
      out.rattle.push({ startS: u * unitS, velocity: strokes.fillVelocity,
                        stroke: strokes.fill });
    }
    // In time order, so the round robin's "not the recording used last" is
    // about consecutive strokes as heard rather than as pushed.
    out.rattle.sort((a, b) => a.startS - b.startS);
  }
  return out;
}

/* How far the performance clock advances over one breath cycle. */
export const cycleUnits = (meter, lengthS, inhaleS) =>
  round(lengthS / meter.unitS) + round(inhaleS / meter.unitS);
