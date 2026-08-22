/* The authored loops, indexed by the pitch each one actually sounds.
 *
 * Loop files are named by the fingering they were recorded at; `offset` is how
 * far above that they sound. Nothing else in the project needs to know that
 * distinction, because every lookup here is in sounding pitch.
 */
import { midiOf } from "./scales.js";

/* The one channel carrying recorded pitch from the build step to the runtime:
   `tools/loopfind.py` writes files named for the fingering it recorded. */
export const LOOP_SUFFIX = "_loop.wav";

/* Loop points out of the WAV's own `smpl` chunk.
 *
 * `decodeAudioData` keeps `fmt ` and `data` and throws every other chunk away,
 * including this one, so the loop the sample was authored around has to be read
 * from the bytes before decoding or it is simply lost. A buffer whose loop
 * points went missing does not error -- it plays once and stops.
 *
 * The chunk table is walked properly rather than scanned for the four bytes
 * "smpl": that string can occur inside sample data, and a false hit would be
 * read as a loop.
 */
export function readLoopPoints(buffer) {
  const view = new DataView(buffer);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1),
                                         view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let sampleRate = null, loop = null;
  let pos = 12;
  while (pos + 8 <= view.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === "smpl") {
      // 9 uint32 of header, then 6 uint32 per loop; start and end are the
      // third and fourth words of the first loop.
      const loops = view.getUint32(body + 28, true);
      if (loops >= 1) {
        loop = [view.getUint32(body + 36 + 8, true),
                view.getUint32(body + 36 + 12, true)];
      }
    }
    pos = body + size + (size % 2);          // chunks are word-aligned
  }
  if (sampleRate === null) throw new Error("no fmt chunk");
  if (loop === null) throw new Error("no smpl chunk, so no loop points");
  return { loopStartS: loop[0] / sampleRate,
           loopEndS: loop[1] / sampleRate,
           sampleRate };
}

export class SampleSet {
  /* `files` is the list of authored loop names, e.g. ["C4_loop.wav", ...]. */
  constructor(files, offset) {
    this.offset = Math.trunc(offset);
    this.byPitch = new Map();
    for (const name of files) {
      const written = name.slice(0, -LOOP_SUFFIX.length);
      this.byPitch.set(midiOf(written) + this.offset, name);
    }
    if (!this.byPitch.size) throw new Error("no loops in the manifest");
    this.pitches = [...this.byPitch.keys()].sort((a, b) => a - b);
  }

  /* [filename, cents] -- the nearest recording, and the shift to reach `midi`.
   *
   * The recordings are whole-tone spaced, so any pitch inside the recorded span
   * is at most 100 cents from one of them. Outside the span the shift grows by
   * an octave at a time, which is what lets a drone sit far below anything
   * anyone played. */
  voiceFor(midi) {
    let best = this.pitches[0];
    for (const p of this.pitches) {
      const d = Math.abs(p - midi) - Math.abs(best - midi);
      if (d < 0) best = p;
    }
    return [this.byPitch.get(best), (midi - best) * 100];
  }

}
