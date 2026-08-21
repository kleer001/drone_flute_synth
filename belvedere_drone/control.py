"""The engine's control seam (SPEC §10.3).

The performance is authoritative and headless; the web GUI is one client of
this object, and `cli.py` is another. Nothing here imports the server, and the
server never touches the scheduler thread, the MIDI port, or the panic path.

The submit model (§10.4) is a correctness requirement rather than a courtesy.
Committing controls one at a time lets a breath run with a root that is not in
the mood it was drawn for; staging a whole set and draining it at a breath
boundary makes the change atomic. That is why `stage` changes nothing audible
and only `submit` can.
"""
import json
import random
import threading
import time
import uuid
from pathlib import Path

from . import breath, moods
from .midi_out import CC_BREATH_LEVEL

# Ranges are SPEC §8's weights table plus §5's breath clamps. The GUI reads
# them from /state rather than repeating them, so there is one source.
NUMERIC_PARAMS = {
    "notes_per_breath": (1.0, 14.0),
    "step_leap_ratio": (0.0, 1.0),
    "ornament_rate": (0.0, 1.0),
    "cadence_strength": (0.0, 1.0),
    "register_bias": (-1.0, 1.0),
    "sweep_depth": (0.0, 1.0),
    "pushed_bias": (0.0, 1.0),
    "trill_rate": (0.0, 1.0),
    "call_response": (0.0, 1.0),
    "breath_mean_s": breath.BREATH_CLAMP_S,
    "breath_spread_s": (0.0, 5.0),
    "inhale_s": breath.INHALE_CLAMP_S,
}

# The eight that §8's table calls the mood, in its order. `breath_mean_s` is
# one of them, so the breath panel owns only spread and inhale -- two controls
# writing one value would make "committed" ambiguous.
MOOD_WEIGHTS = ("notes_per_breath", "step_leap_ratio", "ornament_rate",
                "cadence_strength", "register_bias", "sweep_depth",
                "pushed_bias", "trill_rate", "call_response", "breath_mean_s")

BREATH_ATTACK_S = 0.25
BREATH_RELEASE_S = 0.35
LEVEL_STEPS = 24


class ValidationError(Exception):
    """Carries per-field reasons, because §10.4 names the field that failed."""

    def __init__(self, errors):
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


def _mood_from(name, weights):
    """A Mood built from the working weights, keeping the preset's phrase shape.

    `phrase_shape` is a Beta pair rather than a scalar, so it has no slider and
    stays whatever the named preset chose.
    """
    preset = moods.get(name)
    return moods.Mood(
        name=name,
        notes_per_breath=weights["notes_per_breath"],
        step_leap_ratio=weights["step_leap_ratio"],
        ornament_rate=weights["ornament_rate"],
        cadence_strength=weights["cadence_strength"],
        register_bias=weights["register_bias"],
        sweep_depth=weights["sweep_depth"],
        pushed_bias=weights["pushed_bias"],
        trill_rate=weights["trill_rate"],
        call_response=weights["call_response"],
        breath_mean_s=weights["breath_mean_s"],
        phrase_shape=preset.phrase_shape)


def events_for_breath(plan, keys_drone, keys_melody):
    """Flatten one breath into (offset_s, kind, payload), time-ordered."""
    events = [(0.0, "note_on", (keys_drone[plan.drone_note],
                                breath.LAYER_VELOCITY[plan.layer]))]
    for i in range(LEVEL_STEPS + 1):
        t = BREATH_ATTACK_S * i / LEVEL_STEPS
        events.append((t, "cc", (CC_BREATH_LEVEL, int(127 * i / LEVEL_STEPS))))
    for note in plan.melody_notes:
        key = keys_melody[note.name]
        events.append((note.start_s, "note_on", (key, note.velocity)))
        events.append((note.start_s + note.dur_s, "note_off", (key,)))
    for i in range(LEVEL_STEPS + 1):
        t = plan.length_s - BREATH_RELEASE_S + BREATH_RELEASE_S * i / LEVEL_STEPS
        events.append((max(t, 0.0), "cc",
                       (CC_BREATH_LEVEL, int(127 * (1 - i / LEVEL_STEPS)))))
    events.sort(key=lambda e: e[0])
    return events


class Controller:
    """Owns the performance. Thread-safe for `stage`/`submit`/`snapshot`."""

    def __init__(self, profile, mood_name, seed, keys_drone, keys_melody,
                 midi_out, out_dir, root=None):
        self.profile = profile
        self.keys_drone = keys_drone
        self.keys_melody = keys_melody
        self.out = midi_out
        self.out_dir = Path(out_dir)
        # A new run_id tells an open page the engine restarted, so it reloads
        # rather than showing values from a performance that no longer exists.
        self.run_id = uuid.uuid4().hex[:12]
        self.session_log = (
            self.out_dir / Path(profile.odf_path).name).with_suffix(
                ".session.jsonl")

        preset = moods.get(mood_name)
        drone_notes = profile.chambers["drone"].notes
        self._committed = {
            "root": root or drone_notes[0],
            "mood": preset.name,
            "seed": int(seed),
            "notes_per_breath": float(preset.notes_per_breath),
            "step_leap_ratio": float(preset.step_leap_ratio),
            "ornament_rate": float(preset.ornament_rate),
            "cadence_strength": float(preset.cadence_strength),
            "register_bias": float(preset.register_bias),
            "sweep_depth": float(preset.sweep_depth),
            "pushed_bias": float(preset.pushed_bias),
            "trill_rate": float(preset.trill_rate),
            "call_response": float(preset.call_response),
            "breath_mean_s": float(preset.breath_mean_s),
            "breath_spread_s": float(profile.breath_spread_s),
            "inhale_s": float(profile.inhale_s),
        }
        self._working = dict(self._committed)
        self._in_flight = None
        self._lock = threading.RLock()

        self.master_level = 100
        self._running = True
        self._breath_index = 0
        self._breath_ends_at = None
        self._realtime = True

        self._seed_in_use = self._committed["seed"]
        self._rng = random.Random(self._seed_in_use)
        self._performer = self._build_performer()

    # -- engine state ------------------------------------------------------

    def _build_performer(self):
        c = self._committed
        return breath.Performer(
            self.profile, _mood_from(c["mood"], c), self._rng, root=c["root"],
            breath_spread_s=c["breath_spread_s"], inhale_s=c["inhale_s"])

    # -- the seam (§10.3) --------------------------------------------------

    def stage(self, changes):
        """Edit the working copy. Nothing sounds different (§10.4)."""
        with self._lock:
            unknown = set(changes) - set(self._committed)
            if unknown:
                raise ValidationError(
                    {k: "unknown parameter" for k in sorted(unknown)})
            self._working.update(changes)

    def validate(self, params):
        """Whole-set validation. Returns {field: reason}; empty means valid."""
        errors = {}
        for name, (lo, hi) in NUMERIC_PARAMS.items():
            try:
                value = float(params[name])
            except (KeyError, TypeError, ValueError):
                errors[name] = "must be a number"
                continue
            if not lo <= value <= hi:
                errors[name] = f"must be between {lo:g} and {hi:g}"

        drone_notes = self.profile.chambers["drone"].notes
        if params.get("root") not in drone_notes:
            errors["root"] = (
                "the drone chamber cannot sound this note; it has "
                + ", ".join(drone_notes))
        try:
            moods.get(params.get("mood", ""))
        except ValueError as exc:
            errors["mood"] = str(exc)
        try:
            int(params["seed"])
        except (KeyError, TypeError, ValueError):
            errors["seed"] = "must be a whole number"
        return errors

    def submit(self):
        """Queue the working copy atomically. Returns a submission id."""
        with self._lock:
            if self._in_flight is not None:
                raise ValidationError(
                    {"_": "a submission is already in flight"})
            errors = self.validate(self._working)
            if errors:
                raise ValidationError(errors)
            params = dict(self._working)
            params["seed"] = int(params["seed"])
            for name in NUMERIC_PARAMS:
                params[name] = float(params[name])
            submission_id = uuid.uuid4().hex[:12]
            self._in_flight = {"submission_id": submission_id,
                               "params": params}
            return submission_id

    def snapshot(self):
        with self._lock:
            remaining = None
            if self._breath_ends_at is not None:
                remaining = max(0.0, self._breath_ends_at - time.monotonic())
            return {
                "run_id": self.run_id,
                "seed": self._committed["seed"],
                "breath_index": self._breath_index,
                "running": self._running,
                "master_level": self.master_level,
                "committed": dict(self._committed),
                "working": dict(self._working),
                "in_flight": (None if self._in_flight is None
                              else self._in_flight["submission_id"]),
                "next_drain_in": remaining,
                "ranges": {k: list(v) for k, v in NUMERIC_PARAMS.items()},
                "mood_weights": list(MOOD_WEIGHTS),
                "presets": sorted(moods.MOODS),
                # Sent so choosing a preset can overwrite the eight sliders
                # client-side without a round trip (§10.7).
                "preset_weights": {
                    name: {w: float(getattr(preset, w)) for w in MOOD_WEIGHTS}
                    for name, preset in moods.MOODS.items()},
                "readonly": {
                    "profile_id": self.profile.id,
                    "display": self.profile.display,
                    "concert_a_hz": self.profile.concert_a_hz,
                    "tuning_origin": self.profile.tuning_origin,
                    "provenance": self.profile.provenance_line(),
                    "odf_path": str(self.out_dir
                                    / Path(self.profile.odf_path).name),
                    "drone_notes": list(
                        self.profile.chambers["drone"].notes),
                    "melody_notes": list(
                        self.profile.chambers["melody"].notes),
                },
            }

    # -- live controls, no submit (§10.4) ----------------------------------

    def set_level(self, value):
        value = max(0, min(127, int(value)))
        with self._lock:
            self.master_level = value
        self.out.master_level(value)

    def set_running(self, running):
        with self._lock:
            was, self._running = self._running, bool(running)
            if not self._running:
                # No breath is pending, so there is nothing to count down to.
                self._breath_ends_at = None
        if was and not running:
            self.out.all_notes_off()

    def panic(self):
        """Stop the sound now and hold. The engine stays up (§10.11)."""
        self.set_running(False)
        self.out.silence()

    def regenerate(self):
        """Write a fresh ODF from the profile. The reload is the user's (§10.8)."""
        from . import odfgen
        odf_path, _ = odfgen.generate(self.profile, self.out_dir)
        return str(odf_path)

    # -- the performance ---------------------------------------------------

    def _drain(self):
        """Apply a pending set at a breath boundary. Called between breaths."""
        with self._lock:
            pending = self._in_flight
            if pending is None:
                return
            self._in_flight = None
            self._committed = dict(pending["params"])
            self._working = dict(self._committed)
            reseed = self._committed["seed"]
            entry = {"breath_index": self._breath_index,
                     "submission_id": pending["submission_id"],
                     "params": dict(self._committed)}
        if reseed != self._seed_in_use:
            self._seed_in_use = reseed
            self._rng = random.Random(reseed)
        index, last = self._performer._index, self._performer._last_sequence
        self._performer = self._build_performer()
        self._performer._index, self._performer._last_sequence = index, last
        # §10.9: one line per applied set, whether or not a GUI is attached,
        # so a CLI-only run replays by the same rule.
        with open(self.session_log, "a") as fh:
            fh.write(json.dumps(entry) + "\n")

    def run(self, on_breath=None, max_breaths=None, duration_s=None,
            realtime=True):
        """Play until stopped. Blocks; the HTTP server runs on its own thread.

        `realtime=False` runs the same schedule against a virtual clock, which
        is how a dry run checks a performance without waiting for it.
        """
        self._realtime = realtime
        started = time.monotonic()
        virtual = 0.0
        try:
            while True:
                if max_breaths and self._breath_index >= max_breaths:
                    break
                if duration_s and virtual >= duration_s:
                    break
                self._drain()

                if not self._running:
                    with self._lock:
                        self._breath_ends_at = None
                    time.sleep(0.1)
                    started = time.monotonic() - virtual
                    continue

                plan = self._performer.next_breath()
                with self._lock:
                    self._breath_index = plan.index
                    self._breath_ends_at = (started + virtual + plan.length_s
                                            + plan.inhale_s)
                base = virtual
                cut_short = False
                for offset, kind, payload in events_for_breath(
                        plan, self.keys_drone, self.keys_melody):
                    self._sleep_until(started + base + offset)
                    if not self._running:
                        cut_short = True
                        break
                    if kind == "note_on":
                        self.out.note_on(*payload)
                    elif kind == "note_off":
                        self.out.note_off(*payload)
                    else:
                        self.out.control_change(*payload)
                virtual = base + plan.length_s + plan.inhale_s
                # Stop means stop: sleeping out the rest of a breath nobody is
                # hearing would make Start wait up to a breath to take effect.
                if cut_short:
                    self.out.all_notes_off()
                    continue
                self._sleep_until(started + base + plan.length_s)
                self.out.all_notes_off()
                self._sleep_until(started + virtual)
                if on_breath:
                    on_breath(plan)
        finally:
            self.out.panic()

    def _sleep_until(self, target):
        if not self._realtime:
            return
        delay = target - time.monotonic()
        if delay > 0:
            time.sleep(delay)
