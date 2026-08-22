"""The browser-audio drone flute: Python plans, the browser sounds.

A parallel instrument to the GrandOrgue one, not a replacement. The music
engine is shared and unchanged -- `profile`, `moods`, `melody` and `breath` do
exactly what they do for the organ -- and only the output stage differs. Here
there is no ODF, no MIDI, and no second process: the page fetches the same
loops `tools/loopfind.py` wrote, and plays them with Web Audio.

The mapping is close enough to be worth stating, because it is why this is
short. `AudioBufferSourceNode` takes `loopStart`/`loopEnd`, which is what the
WAV's `smpl` chunk already carries; and its `detune` is specified **in cents**,
which is what the profile's cents table already is. Nothing is translated.

Python stays the brain. It plans a whole breath ahead of time and hands it over
as JSON; the page schedules it on the audio clock, which is sample-accurate and
does not drift the way a browser timer would.
"""
import json
import random
import struct
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .. import breath as breath_mod, moods, profile as profile_mod

STATIC = Path(__file__).parent / "static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".wav": "audio/wav"}

# The breath envelope, matching the organ player's CC 11 shape (control.py).
ATTACK_S = 0.25
RELEASE_S = 0.35
CHAMBER_GAIN = {"drone": 0.85, "melody": 1.0}


def read_loop_points(path):
    """(loop_start_s, loop_end_s, sample_rate) from the WAV's `smpl` chunk.

    `decodeAudioData` in the browser throws every chunk but `fmt` and `data`
    away, so the loop the sample was authored around has to be handed over
    separately or it is simply lost.
    """
    raw = path.read_bytes()
    i = raw.find(b"smpl")
    if i < 0:
        raise ValueError(f"{path}: no smpl chunk, so no loop points")
    size = struct.unpack("<I", raw[i + 4:i + 8])[0]
    chunk = raw[i + 8:i + 8 + size]
    if struct.unpack("<I", chunk[28:32])[0] < 1:
        raise ValueError(f"{path}: smpl chunk declares no loops")
    start, end = struct.unpack("<II", chunk[44:52])
    with wave.open(str(path)) as w:
        sr = w.getframerate()
    return start / sr, end / sr, sr


class Instrument:
    """One performance. Rebuilt whenever a control that shapes it changes."""

    def __init__(self, profile, loops_dir, mood_name, seed, root=None):
        self.profile = profile
        self.loops_dir = Path(loops_dir)
        self._lock = threading.RLock()
        self.set_performance(mood_name, seed, root)

    def set_performance(self, mood_name, seed, root=None):
        with self._lock:
            self.mood_name = mood_name
            self.seed = int(seed)
            self.root = root or self.profile.chambers["drone"].notes[0]
            self.performer = breath_mod.Performer(
                self.profile, moods.get(mood_name), random.Random(self.seed),
                root=self.root)

    def voices(self):
        """{chamber: {note: {file, cents}}} -- which loop sounds each note."""
        out = {}
        for name, chamber in self.profile.chambers.items():
            out[name] = {
                note: {"file": f"{chamber.sample_for(note)}_loop.wav",
                       "cents": round(chamber.tuning_offset(note), 4)}
                for note in chamber.notes}
        return out

    def loops(self):
        """Loop points for every file the voices reference."""
        out = {}
        for chamber in self.voices().values():
            for spec in chamber.values():
                if spec["file"] in out:
                    continue
                path = self.loops_dir / spec["file"]
                if not path.is_file():
                    raise FileNotFoundError(
                        f"{path} is missing. Run tools/loopfind.py first.")
                start, end, sr = read_loop_points(path)
                out[spec["file"]] = {"loop_start_s": round(start, 6),
                                     "loop_end_s": round(end, 6),
                                     "sample_rate": sr}
        return out

    def describe(self):
        with self._lock:
            meter = self.performer.meter
            return {
                "profile": self.profile.display,
                "provenance": self.profile.provenance_line(),
                "mood": self.mood_name,
                "moods": sorted(moods.MOODS),
                "seed": self.seed,
                "root": self.root,
                "drone_notes": list(self.profile.chambers["drone"].notes),
                "meter": {"bpm": meter.bpm,
                          "beats_per_measure": meter.beats_per_measure,
                          "beat_s": meter.beat_s,
                          "measure_s": meter.measure_s},
                "voices": self.voices(),
                "loops": self.loops(),
                "attack_s": ATTACK_S,
                "release_s": RELEASE_S,
                "chamber_gain": CHAMBER_GAIN,
            }

    def next_breath(self):
        with self._lock:
            plan = self.performer.next_breath()
            meter = self.performer.meter
            return {
                "index": plan.index,
                "length_s": plan.length_s,
                "inhale_s": plan.inhale_s,
                "bars": round((plan.length_s + plan.inhale_s)
                              / meter.measure_s),
                "layer": plan.layer,
                "role": getattr(plan, "role", ""),
                "drone": plan.drone_note,
                "drone_velocity": breath_mod.LAYER_VELOCITY[plan.layer],
                "notes": [{"name": n.name,
                           "start_s": round(n.start_s, 6),
                           "dur_s": round(n.dur_s, 6),
                           "velocity": n.velocity,
                           "grace": n.is_grace}
                          for n in plan.melody_notes],
            }


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "belvedere-browser"

    def log_message(self, fmt, *args):
        """Silence the access log; the performance owns stdout."""

    def _send(self, code, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    def _file(self, path, content_type):
        if not path.is_file():
            return self._json(404, {"error": f"{path.name} not found"})
        self._send(200, path.read_bytes(), content_type)

    def do_GET(self):
        url = urlparse(self.path)
        inst = self.server.instrument
        if url.path in ("/", "/index.html"):
            return self._file(STATIC / "index.html", CONTENT_TYPES[".html"])
        if url.path in ("/app.js", "/style.css"):
            name = url.path.lstrip("/")
            return self._file(STATIC / name,
                              CONTENT_TYPES[Path(name).suffix])
        if url.path == "/instrument":
            return self._json(200, inst.describe())
        if url.path == "/breath":
            return self._json(200, inst.next_breath())
        if url.path.startswith("/loops/"):
            # Note names carry sharps, so the page percent-encodes them.
            asked = unquote(url.path[len("/loops/"):])
            if asked != Path(asked).name:
                return self._json(400, {"error": "bad loop name"})
            return self._file(inst.loops_dir / asked, CONTENT_TYPES[".wav"])
        self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        inst = self.server.instrument
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if url.path == "/performance":
            # Mood, seed and root reshape the performance, so the phrase
            # generator is rebuilt and the next breath comes from the new one.
            inst.set_performance(body.get("mood", inst.mood_name),
                                 body.get("seed", inst.seed),
                                 body.get("root", inst.root))
            return self._json(200, inst.describe())
        self._json(404, {"error": "not found"})


def serve(instrument, host="127.0.0.1", port=8740):
    httpd = ThreadingHTTPServer((host, port), _Handler)
    httpd.daemon_threads = True
    httpd.instrument = instrument
    return httpd


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("profile")
    ap.add_argument("--loops", default="build/loops")
    ap.add_argument("--mood", default="contemplative")
    ap.add_argument("--seed", type=int,
                    default=random.SystemRandom().randrange(2 ** 31))
    ap.add_argument("--root")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8740)
    args = ap.parse_args(argv)

    profile = profile_mod.load(args.profile)
    inst = Instrument(profile, args.loops, args.mood, args.seed, args.root)
    inst.loops()                      # fail now if a loop is missing, not later
    httpd = serve(inst, args.host, args.port)
    print(f"profile : {profile.display}")
    print(f"mood    : {args.mood}")
    print(f"seed    : {args.seed}          <- reproduces this performance")
    print(f"open    : http://{args.host}:{args.port}/")
    print("\nThe browser makes the sound. Press Ctrl-C to stop serving.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
