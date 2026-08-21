"""v0 entry point (SPEC §14).

    python3 -m belvedere_drone.cli odf   <profile.toml> <out_dir>
    python3 -m belvedere_drone.cli play  <profile.toml> [--mood M] [--seed N]
    python3 -m belvedere_drone.cli check <profile.toml>

`play --dry-run` runs the same scheduler against a recording port and a virtual
clock, so a performance can be checked without GrandOrgue attached.
"""
import argparse
import json
import random
import sys
from pathlib import Path

from . import breath, control, moods, odfgen, samples, profile as profile_mod
from .midi_out import MidiOut

# The scheduler lives in control.Controller so the CLI and the web GUI drive
# the same engine (SPEC §10.3).
_events_for_breath = control.events_for_breath


def _load_keys(profile, out_dir):
    """Read the generated manifest so app and ODF agree on keys (§9)."""
    manifest_path = (Path(out_dir) / Path(profile.odf_path).name).with_suffix(
        ".manifest.json")
    if not manifest_path.exists():
        raise RuntimeError(
            f"no manifest at {manifest_path}. Run the 'odf' command first.")
    manifest = json.loads(manifest_path.read_text())
    return (manifest["chambers"]["drone"]["keys"],
            manifest["chambers"]["melody"]["keys"])


def cmd_odf(args):
    prof = profile_mod.load(args.profile)
    odf_path, manifest_path = odfgen.generate(prof, args.out_dir)
    print(f"profile   : {prof.id}")
    print(f"provenance: {prof.provenance_line()}")
    if not prof.is_tuning_sourced:
        print("  NOTE: cents table is this project's own estimate, not a "
              "sourced measurement.")
    print(f"odf       : {odf_path}")
    print(f"manifest  : {manifest_path}")
    if args.loops:
        staged = samples.stage(prof, args.loops, args.out_dir)
        print(f"samples   : {len(staged)} loops staged from {args.loops}")
    else:
        print("samples   : not staged (pass --loops <dir> from tools/loopfind.py)")
    return 0


def cmd_play(args):
    prof = profile_mod.load(args.profile)
    mood = moods.get(args.mood)
    seed = args.seed if args.seed is not None else random.randrange(2 ** 31)
    keys_drone, keys_melody = _load_keys(prof, args.out_dir)

    out = MidiOut(port_name=args.port, channel=args.channel,
                  dry_run=args.dry_run)
    engine = control.Controller(prof, mood.name, seed, keys_drone, keys_melody,
                                out, args.out_dir, root=args.root)

    print(f"profile : {prof.display}")
    print(f"tuning  : {prof.provenance_line()}")
    print(f"mood    : {mood.name}")
    print(f"seed    : {seed}          <- reproduces this performance")
    print(f"port    : {out.port_name}")

    if args.gui:
        from .web import server as web_server
        web_server.serve(engine, host=args.http_host, port=args.http_port,
                         token=args.token)
        url = f"http://{args.http_host}:{args.http_port}/"
        if args.token:
            url += f"?token={args.token}"
        print(f"gui     : {url}")
    print()
    sys.stdout.flush()

    def report(plan):
        print(f"breath {plan.index:4d}  {plan.length_s:5.2f}s  "
              f"{plan.layer:7} {plan.role:7} "
              f"{' '.join(plan.note_sequence())}")
        sys.stdout.flush()

    engine.run(on_breath=report, max_breaths=args.max_breaths,
               duration_s=args.duration_s,
               # A countdown over a virtual clock is meaningless, so a GUI run
               # keeps real time even when no MIDI port is open.
               realtime=args.gui or not args.dry_run)

    if args.dry_run:
        print(f"\n{len(out.port.messages)} MIDI messages")
        if out.sounding:
            print(f"FAIL: {len(out.sounding)} notes still sounding")
            return 1
    return 0


def _stream_bytes(profile, mood_name, seed, out_dir, breaths):
    """Collect the exact MIDI byte stream for a fixed number of breaths."""
    rng = random.Random(seed)
    keys_drone, keys_melody = _load_keys(profile, out_dir)
    out = MidiOut(dry_run=True)
    performer = breath.Performer(profile, moods.get(mood_name), rng)
    sequences = []
    for _ in range(breaths):
        plan = performer.next_breath()
        for offset, kind, payload in _events_for_breath(plan, keys_drone,
                                                        keys_melody):
            if kind == "note_on":
                out.note_on(*payload)
            elif kind == "note_off":
                out.note_off(*payload)
            else:
                out.control_change(*payload)
        out.all_notes_off()
        sequences.append(plan.note_sequence())
    raw = b"".join(bytes(m.bytes()) for m in out.port.messages)
    return raw, sequences, out


def cmd_check(args):
    """Acceptance criteria 1, 2, 5 and 6 (SPEC §12), MIDI side only.

    Criteria 3 and 4 are sample-side and live in tools/loop_qa.py and a
    recording of GrandOrgue's output; they are not checked here.
    """
    prof = profile_mod.load(args.profile)
    failures = []

    raw_a, seqs_a, out_a = _stream_bytes(prof, args.mood, 1234, args.out_dir, 60)
    raw_b, seqs_b, _ = _stream_bytes(prof, args.mood, 1234, args.out_dir, 60)
    raw_c, _, _ = _stream_bytes(prof, args.mood, 5678, args.out_dir, 60)

    if raw_a == raw_b:
        print(f"PASS  criterion 5: same seed -> byte-identical MIDI "
              f"({len(raw_a)} bytes)")
    else:
        failures.append("criterion 5: same seed produced different streams")
        print("FAIL  criterion 5")

    if raw_a != raw_c:
        print("PASS  criterion 5b: a different seed produces a different stream")
    else:
        failures.append("criterion 5b: different seeds produced identical output")
        print("FAIL  criterion 5b")

    repeats = sum(1 for i in range(1, len(seqs_a)) if seqs_a[i] == seqs_a[i - 1])
    if repeats == 0:
        print(f"PASS  criterion 6: no two consecutive breaths identical "
              f"({len(seqs_a)} breaths)")
    else:
        failures.append(f"criterion 6: {repeats} consecutive repeats")
        print(f"FAIL  criterion 6: {repeats} consecutive repeats")

    if not out_a.sounding:
        print("PASS  criterion 1: nothing left sounding after the run")
    else:
        failures.append(f"criterion 1: {len(out_a.sounding)} notes still on")
        print(f"FAIL  criterion 1: {len(out_a.sounding)} notes still on")

    out_a.panic()
    tail = out_a.port.messages[-2:]
    controls = [m.control for m in tail if m.type == "control_change"]
    if 123 in controls and 120 in controls:
        print("PASS  criterion 2: panic sends all-notes-off and all-sound-off")
    else:
        failures.append("criterion 2: panic did not send CC 123 + CC 120")
        print("FAIL  criterion 2")

    on = sum(1 for m in out_a.port.messages if m.type == "note_on")
    off = sum(1 for m in out_a.port.messages if m.type == "note_off")
    if off >= on:
        print(f"PASS  criterion 1b: {on} note-ons balanced by {off} note-offs")
    else:
        failures.append(f"criterion 1b: {on} note-ons but only {off} note-offs")
        print(f"FAIL  criterion 1b: {on} on / {off} off")

    print()
    if failures:
        for f in failures:
            print(f"  {f}")
        return 1
    print("all MIDI-side acceptance criteria pass")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="belvedere-drone")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("odf", help="generate the .organ and key manifest")
    p.add_argument("profile")
    p.add_argument("out_dir")
    p.add_argument("--loops", help="loop directory from tools/loopfind.py; "
                                   "its WAVs are staged beside the ODF")
    p.set_defaults(func=cmd_odf)

    p = sub.add_parser("play", help="play an endless performance")
    p.add_argument("profile")
    p.add_argument("--out-dir", default="build",
                   help="where the generated manifest lives")
    p.add_argument("--mood", default="contemplative")
    p.add_argument("--seed", type=int)
    p.add_argument("--root", help="drone root note, e.g. A#4")
    p.add_argument("--port", help="MIDI port substring (default: GrandOrgue)")
    p.add_argument("--channel", type=int, default=1)
    p.add_argument("--dry-run", action="store_true",
                   help="no MIDI port, no sleeping; record the stream instead")
    p.add_argument("--max-breaths", type=int)
    p.add_argument("--duration-s", type=float)
    p.add_argument("--gui", action="store_true",
                   help="serve the web control surface (SPEC §10)")
    p.add_argument("--http-port", type=int, default=8737)
    p.add_argument("--http-host", default="127.0.0.1",
                   help="anything but loopback requires --token")
    p.add_argument("--token", help="required to bind a non-loopback address")
    p.set_defaults(func=cmd_play)

    p = sub.add_parser("check", help="run the MIDI-side acceptance criteria")
    p.add_argument("profile")
    p.add_argument("--out-dir", default="build")
    p.add_argument("--mood", default="contemplative")
    p.set_defaults(func=cmd_check)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
