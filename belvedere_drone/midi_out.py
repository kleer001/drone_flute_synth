"""MIDI output and the panic path (SPEC §3, §9).

GrandOrgue is a write-only device: it exposes no way to ask what is sounding,
so this module is the sole authority on what is on. A stuck drone is the worst
failure this app has, which is why `panic` is wired to normal exit, to SIGINT
and SIGTERM, and to `atexit` -- and why it is written to be safe to call twice.

`--dry-run` swaps in a sink that records the same byte stream instead of
opening a port, which is what makes the determinism criterion testable without
a synth attached.
"""
import atexit
import signal

import mido

CC_MASTER_LEVEL = 7
CC_BREATH_LEVEL = 11
CC_ALL_SOUND_OFF = 120
CC_ALL_NOTES_OFF = 123


class DryRunPort:
    """Records messages instead of sending them. Same interface as mido."""

    def __init__(self):
        self.messages = []
        self.closed = False

    def send(self, msg):
        self.messages.append(msg)

    def close(self):
        self.closed = True


class MidiOut:
    def __init__(self, port_name=None, channel=1, dry_run=False):
        if channel < 1 or channel > 16:
            raise ValueError(f"channel must be 1..16, got {channel}")
        self.channel = channel - 1
        self._sounding = set()
        self._panicked = False

        if dry_run:
            self.port = DryRunPort()
            self.port_name = "<dry-run>"
        else:
            self.port_name = self._resolve(port_name)
            self.port = mido.open_output(self.port_name)

        signal.signal(signal.SIGINT, self._on_signal)
        signal.signal(signal.SIGTERM, self._on_signal)
        atexit.register(self.panic)

    @staticmethod
    def _resolve(port_name):
        available = mido.get_output_names()
        if not available:
            raise RuntimeError("no ALSA MIDI output ports found")
        if port_name is None:
            match = [p for p in available if "GrandOrgue" in p]
            if not match:
                raise RuntimeError(
                    "no GrandOrgue MIDI input port found. Start GrandOrgue and "
                    "load the organ first, or pass --port. Available: "
                    + ", ".join(available))
            return match[0]
        match = [p for p in available if port_name in p]
        if not match:
            raise RuntimeError(
                f"no MIDI port matching {port_name!r}. Available: "
                + ", ".join(available))
        return match[0]

    def note_on(self, key, velocity):
        self.port.send(mido.Message("note_on", channel=self.channel,
                                    note=key, velocity=velocity))
        self._sounding.add(key)

    def note_off(self, key):
        self.port.send(mido.Message("note_off", channel=self.channel,
                                    note=key, velocity=0))
        self._sounding.discard(key)

    def control_change(self, control, value):
        self.port.send(mido.Message("control_change", channel=self.channel,
                                    control=control, value=int(value)))

    def breath_level(self, value):
        self.control_change(CC_BREATH_LEVEL, value)

    def master_level(self, value):
        self.control_change(CC_MASTER_LEVEL, value)

    @property
    def sounding(self):
        return frozenset(self._sounding)

    def all_notes_off(self):
        """End one breath: every chamber releases on the same event (§5)."""
        for key in sorted(self._sounding):
            self.port.send(mido.Message("note_off", channel=self.channel,
                                        note=key, velocity=0))
        self._sounding.clear()
        self.control_change(CC_ALL_NOTES_OFF, 0)

    def silence(self):
        """Stop everything sounding, but keep the port. Safe to call twice.

        This is the GUI's Panic button (SPEC §10.7): the worst failure mode is
        a stuck drone, and the cure for it must not also end the performance.
        """
        self.all_notes_off()
        self.control_change(CC_ALL_SOUND_OFF, 0)

    def panic(self):
        """Silence everything and close the port. Safe to call more than once.

        This is the exit path -- normal exit, SIGINT/SIGTERM, and `atexit` --
        so it is terminal by design. Use `silence` for a panic mid-performance.
        """
        if self._panicked:
            return
        self._panicked = True
        self.silence()
        self.port.close()

    def _on_signal(self, signum, frame):
        self.panic()
        raise SystemExit(128 + signum)
