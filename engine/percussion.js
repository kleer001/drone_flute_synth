import { round } from "./rng.js";

export const DRUM_POOL = "frame_drum";
export const RATTLE_POOL = "rattle";

// Which stroke of a pool serves which role. Pools name their strokes
// differently, so this is a table rather than a guess.
const DRUM_STROKES = {
  frame_drum: { strong: "hit", weak: "muted" },
  frame_drum_small: { strong: "hit", weak: "muted" },
};
const RATTLE_STROKES = {
  rattle: ["down", "up"],
  rattle_small: ["double_down", "double_up"],
  cabasa: ["hit", "rub"],
  guiro: ["hit", "fast"],
};

const DRUM_VELOCITY = { 3: 104, 2: 80, 1: 60 };
const RATTLE_VELOCITY = { 3: 82, 2: 70, 1: 60 };
const DRUM_TAIL_BARS = 1;

const weightOf = (u, unitsPerBar) =>
  u % unitsPerBar === 0 ? 3 : u % 2 === 0 ? 2 : 1;

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

/* Strong empty slots inside the span the tune occupies: hits land where the
   tune is not, so the drum answers rather than doubles. */
export function hocket(tune, unitsPerBar, density) {
  const first = tune.findIndex((v) => v);
  const out = new Array(tune.length).fill(0);
  if (first < 0) return out;
  let last = 0;
  tune.forEach((v, u) => { if (v) last = u; });
  const end = Math.min(tune.length, last + DRUM_TAIL_BARS * unitsPerBar);
  const empty = [];
  for (let u = first; u < end; u++) if (!tune[u]) empty.push(u);
  empty.sort((a, b) => weightOf(b, unitsPerBar) - weightOf(a, unitsPerBar) || a - b);
  for (const u of empty.slice(0, Math.round(empty.length * density))) {
    out[u] = weightOf(u, unitsPerBar);
  }
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
                         drum, rattle, drumDensity, rattleScale,
                         drumPool = DRUM_POOL, rattlePool = RATTLE_POOL }) {
  const unitS = meter.unitS;
  const unitsPerBar = meter.unitsPerMeasure;
  const units = Math.max(1, round(lengthS / unitS));
  const out = { drum: [], rattle: [] };

  if (drum) {
    const strokes = DRUM_STROKES[drumPool];
    if (!strokes) throw new Error(`no drum stroke map for pool ${drumPool}`);
    hocket(reduce(notes, units, unitS), unitsPerBar, drumDensity)
      .forEach((w, u) => {
        if (!w) return;
        out.drum.push({ startS: u * unitS, velocity: DRUM_VELOCITY[w],
                        stroke: w === 3 ? strokes.strong : strokes.weak });
      });
  }

  if (rattle) {
    const strokes = RATTLE_STROKES[rattlePool];
    if (!strokes) throw new Error(`no rattle stroke map for pool ${rattlePool}`);
    const cell = timelineCell(motif, rattleScale);
    const total = units + Math.max(0, round(inhaleS / unitS));
    let n = 0;
    for (let u = 0; u < total; u++) {
      if (!cell.onsets.includes((clock + u) % cell.length)) continue;
      const w = weightOf(u, unitsPerBar);
      out.rattle.push({ startS: u * unitS, velocity: RATTLE_VELOCITY[w],
                        stroke: strokes[n++ % strokes.length] });
    }
  }
  return out;
}

/* How far the performance clock advances over one breath cycle. */
export const cycleUnits = (meter, lengthS, inhaleS) =>
  round(lengthS / meter.unitS) + round(inhaleS / meter.unitS);
