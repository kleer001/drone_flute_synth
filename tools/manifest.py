#!/usr/bin/env python3
"""Write the manifest the page reads to learn which recordings exist.

The browser cannot list a directory, so the pools have to be handed to it.
This is generated rather than hand-kept: a manifest that disagrees with the
directories is a silently missing note, or a stroke that never sounds.

Two kinds of recording, in two directories:

  loops/     sustained notes with loop points, named <Note>_loop.wav by
             tools/loopfind.py
  strokes/   percussion one-shots, named <pool>-<stroke>-l<level>-v<variant>.wav
             by tools/oneshot.py

Both naming schemes are ours, so both parse without a special case. The
irregular VCSL names never reach this far -- oneshot.py resolved them.

    python3 tools/manifest.py <site_root>
"""
import json
import os
import re
import sys

VERSION = 2
LOOPS_DIR = "loops"
STROKES_DIR = "strokes"
LOOP_SUFFIX = "_loop.wav"
STROKE_RE = re.compile(
    r"^(?P<pool>[a-z0-9_]+)-(?P<stroke>[a-z0-9_]+)"
    r"-l(?P<level>\d+)-v(?P<variant>\d+)\.wav$")


def read_loops(root):
    path = os.path.join(root, LOOPS_DIR)
    files = sorted(f for f in os.listdir(path) if f.endswith(LOOP_SUFFIX))
    if not files:
        sys.exit(f"no *{LOOP_SUFFIX} in {path}")
    return {"dir": LOOPS_DIR, "files": files}


def read_strokes(root):
    """{pool: {dir, samples}}. An empty or absent strokes/ is not an error --
    the instrument played without percussion before it had any."""
    path = os.path.join(root, STROKES_DIR)
    if not os.path.isdir(path):
        return {}
    pools, unparsed = {}, []
    for name in sorted(os.listdir(path)):
        if not name.endswith(".wav"):
            continue
        m = STROKE_RE.match(name)
        if not m:
            unparsed.append(name)
            continue
        pool = pools.setdefault(m["pool"], {"dir": STROKES_DIR, "samples": []})
        pool["samples"].append({
            "file": name,
            "stroke": m["stroke"],
            "level": int(m["level"]),
            "variant": int(m["variant"]),
        })
    if unparsed:
        # Silently skipping would be a stroke authored and never heard.
        sys.exit(f"unparseable name(s) in {path}: {', '.join(unparsed)}")
    return pools


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1].strip())
    root = sys.argv[1]
    manifest = {
        "version": VERSION,
        "loops": read_loops(root),
        "percussion": read_strokes(root),
    }
    path = os.path.join(root, "manifest.json")
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")

    strokes = sum(len(p["samples"]) for p in manifest["percussion"].values())
    print(f"{len(manifest['loops']['files'])} loops, {strokes} one-shots in "
          f"{len(manifest['percussion'])} pools -> {path}")


if __name__ == "__main__":
    main()
