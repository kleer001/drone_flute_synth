#!/usr/bin/env python3
"""Write the loop manifest the page reads to learn which recordings exist.

The browser cannot list a directory, so the file names have to be handed to it.
This is generated rather than hand-kept: a manifest that disagrees with the
directory is a silently missing note.

    python3 tools/manifest.py <loops_dir>
"""
import json
import os
import sys


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1].strip())
    loops = sys.argv[1]
    files = sorted(f for f in os.listdir(loops) if f.endswith("_loop.wav"))
    if not files:
        sys.exit(f"no *_loop.wav in {loops}")
    path = os.path.join(loops, "manifest.json")
    with open(path, "w") as fh:
        json.dump({"files": files}, fh, indent=1)
        fh.write("\n")
    print(f"{len(files)} loops -> {path}")


if __name__ == "__main__":
    main()
