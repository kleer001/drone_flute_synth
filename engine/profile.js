/* The sample set: what was recorded, and where the instrument sits.
 *
 * There is no cents table here. Pitch comes from the key and the mode
 * (`scales.js`), and reaching a pitch the sample set never recorded is a matter
 * of picking the nearest recording and detuning it -- arithmetic, not
 * authorship.
 *
 * The one fact that has to be written down is `soundingOffset`: the recordings
 * are named by fingering, and a soprano recorder sounds an octave above its
 * written pitch. Measured -- there is no energy at the named frequency and all
 * of it at twice. Every lookup elsewhere is in sounding pitch, so this is the
 * only place the distinction appears.
 */
export const INSTRUMENT = {
  // Shown in the page footer, with `sampleNote` behind it as the long form.
  // Provenance is first-class here: what these recordings are, and what they
  // are only a proxy for, should be readable without opening the source.
  provenance: "samples: VCSL baroque soprano recorder, frame drum, shakers, " +
              "cabasa, guiro and ocean drum (CC0)",
  sampleNote:
    "Baroque soprano recorder from VCSL (CC0). A recorder is a duct flute, so " +
    "the structure is right and the timbre is a proxy. VCSL sampled it " +
    "whole-tone -- C D E F# G# A#, plus a stray G -- so a scale needing " +
    "semitone steps borrows the nearest recording and is shifted by at most " +
    "100 cents, formants and all. The percussion is VCSL as well: frame drum " +
    "large and small, two shakers, cabasa, guiro, and an ocean drum standing " +
    "in for a rain stick -- VCSL has none, and a shallow drum full of beads " +
    "is the same gesture. The controls name the role, the credit names the " +
    "recording.",

  soundingOffset: 12,

  // The recorded span, in sounding pitch. Inside it no note is shifted more
  // than 100 cents; outside it the shift grows an octave at a time and the
  // recorder stops sounding like one.
  leadLow: "C5",
  leadHigh: "C7",

  // Which octave a drone slot's offset of 0 lands in, in sounding pitch. An
  // octave below the lead's floor, so the drone sits under the melody rather
  // than in it.
  droneOctave: 4,

  // The bar. A breath resolves to a bar line: the phrase sounds for whole
  // beats, the player breathes on the last of them, and the next phrase starts
  // on a downbeat -- which is how a wind player actually phrases.
  //
  // Tempo is not here. It belongs to the mood, because how fast this instrument
  // moves is a question about the piece being played, not about the flute.
  beatsPerMeasure: 4,

  // The recordings are quiet -- they peak between 0.02 and 0.13, and the lowest
  // note the drone leans on is the quietest of them. Played at their own level
  // the instrument is barely audible, so the mix needs this much makeup.
  makeupGain: 6.0,

  breathMeanS: 7.0,
  breathSpreadS: 2.5,
};
