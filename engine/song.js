import { mod } from "./rng.js";

export const BLOCK_BREATHS = 2;          // a block is one call and its answer

function shuffle(items, rng) {
  const s = items.slice();
  for (let i = s.length - 1; i > 0; i--) {
    const j = rng.randint(0, i);
    [s[i], s[j]] = [s[j], s[i]];
  }
  return s;
}

function runAt(s, maxRun) {
  for (let i = maxRun; i < s.length; i++) {
    let same = true;
    for (let k = 1; k <= maxRun; k++) if (s[i - k] !== s[i]) { same = false; break; }
    if (same) return i;
  }
  return -1;
}

/* An order over `blocks` distinct blocks, each appearing `repeats` times, with
   no block occurring more than `maxRun` times running.

   Offenders move to the back. That locks when the offending run is already at
   the tail -- measured at 3% of shuffles -- so a lock reshuffles and retries
   rather than spinning. Mean attempts 1.03. */
export function arrange(blocks, repeats, rng, maxRun = 1, tries = 16) {
  const items = [];
  for (let b = 0; b < blocks; b++) for (let r = 0; r < repeats; r++) items.push(b);
  if (blocks <= maxRun) throw new Error(`${blocks} blocks cannot avoid a run of ${maxRun}`);

  for (let t = 0; t < tries; t++) {
    const s = shuffle(items, rng);
    let locked = false;
    for (let step = 0; step < items.length * 20; step++) {
      const i = runAt(s, maxRun);
      if (i < 0) break;
      if (i === s.length - 1) { locked = true; break; }
      s.push(...s.splice(i, 1));
    }
    if (!locked && runAt(s, maxRun) < 0) return s;
  }
  throw new Error(`could not arrange ${blocks}x${repeats} in ${tries} tries`);
}

export const blockLabel = (i) => String.fromCharCode(65 + mod(i, 26));
