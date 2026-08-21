"""Named weight sets for the melody generator (SPEC §8).

A macro over a weights table, not a model. The numbers are a starting point to
tune by ear; nothing here is derived from measurement and nothing should be
described as if it were.
"""


class Mood:
    def __init__(self, name, notes_per_breath, step_leap_ratio, ornament_rate,
                 cadence_strength, register_bias, sweep_depth, pushed_bias,
                 breath_mean_s, trill_rate, call_response, bpm, phrase_shape):
        self.name = name
        self.notes_per_breath = notes_per_breath
        self.step_leap_ratio = step_leap_ratio
        self.ornament_rate = ornament_rate
        self.cadence_strength = cadence_strength
        self.register_bias = register_bias
        self.sweep_depth = sweep_depth
        self.pushed_bias = pushed_bias
        self.breath_mean_s = breath_mean_s
        self.trill_rate = trill_rate          # chance a held note is shaken
        self.call_response = call_response    # how far apart call and answer sit
        self.bpm = bpm                        # the tempo this mood moves at
        self.phrase_shape = phrase_shape      # Beta(a, b) over the breath


# Tempo is part of a mood, not of the instrument: a mood that asks for more
# notes in a breath needs a faster beat to fit them, and one that asks for
# stillness needs a slower one. `bpm` is the quarter note.
MOODS = {
    "contemplative": Mood("contemplative", 4, 0.80, 0.10, 0.70, 0.0, 0.25,
                          0.15, 8.0, 0.10, 0.55, 72, (3.0, 3.0)),
    "mourning": Mood("mourning", 3, 0.85, 0.15, 0.85, -0.2, 0.35,
                     0.10, 9.0, 0.08, 0.65, 56, (2.0, 4.0)),
    "pastoral": Mood("pastoral", 6, 0.70, 0.20, 0.55, 0.1, 0.30,
                     0.25, 7.0, 0.18, 0.50, 88, (3.0, 3.0)),
    "ceremonial": Mood("ceremonial", 5, 0.60, 0.15, 0.75, 0.2, 0.45,
                       0.45, 7.5, 0.12, 0.75, 66, (4.0, 2.0)),
    "restless": Mood("restless", 11, 0.45, 0.40, 0.25, 0.4, 0.55,
                     0.60, 5.0, 0.45, 0.35, 120, (2.0, 2.0)),
    "sleep": Mood("sleep", 2, 0.92, 0.02, 0.90, -0.3, 0.15,
                  0.02, 11.0, 0.02, 0.30, 48, (2.0, 4.0)),
}


def get(name):
    key = name.lower()
    if key not in MOODS:
        raise ValueError(f"unknown mood {name!r}; have {sorted(MOODS)}")
    return MOODS[key]
