#!/usr/bin/env bash
#
# Serve the drone flute locally.
#
#   ./run.sh                serve and open a browser
#   ./run.sh --port 9000    ask for a particular port
#   ./run.sh --rebuild      re-author the recordings from the VCSL samples
#   ./run.sh --no-open      serve, but do not open a browser
#
# The instrument is a static site at the repo root -- the same files GitHub
# Pages serves, so what you hear here is what the public page plays. Python is
# needed only to author loops, which is a build step you can skip: the authored
# loops are committed.
#
# Key, scale, mood and seed are controls on the page, and can also be set from
# the URL:  ?key=A&mode=phrygian&mood=restless&seed=42
#
# Anything downloaded goes in vendor/ and anything built goes in build/; both
# are gitignored. Nothing is installed system-wide and nothing needs root.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$REPO/vendor"
BUILD="$REPO/build"
LOOPS="$BUILD/loops"
SITE="$REPO"
SITE_LOOPS="$REPO/loops"
VENV="$REPO/.venv"
PY="$VENV/bin/python"

VCSL="$VENDOR/VCSL"
VCSL_SUSTAIN="$VCSL/Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder/Sustain"
STROKES="$BUILD/strokes"
SITE_STROKES="$REPO/strokes"

# The upstream commit the published sound is built from. VCSL's samples have
# not changed since v1.2.2 in May 2018; the three commits after it are two
# README edits and this one, which adds the LICENSE. Pinned rather than tracking
# the branch tip because a later commit adding an articulation would not break
# the build -- it would quietly change what the 13 loops and 52 strokes sound
# like on the next rebuild.
VCSL_REF=c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e

# Only the folders the build actually reads. VCSL whole is far larger, and a
# sparse checkout of these is about 70 MB.
VCSL_PATHS=(
    "Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder"
    "Membranophones/Struck Membranophones/Frame Drum"
    "Membranophones/Other Membranophones/Ocean Drum"
    "Idiophones/Struck Idiophones/Shaker, Large"
    "Idiophones/Struck Idiophones/Shaker, Small"
    "Idiophones/Struck Idiophones/Cabasa"
    "Idiophones/Struck Idiophones/Guiro"
)

PORT=8740
REBUILD=0
OPEN=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)    PORT="$2"; shift 2 ;;
        --rebuild) REBUILD=1; shift ;;
        --no-open) OPEN=0; shift ;;
        -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next }
                        NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# True only when every folder the build reads is checked out. Testing one of
# them is not enough: a vendor tree fetched when VCSL_PATHS was shorter is
# present but short, and the pools it lacks author no strokes at all.
vcsl_complete() {
    local path
    for path in "${VCSL_PATHS[@]}"; do
        [[ -d "$VCSL/$path" ]] || return 1
    done
}

# --- 1. Loops, only if they are missing or you asked -------------------------
if [[ $REBUILD -eq 1 || -z "$(ls -A "$SITE_LOOPS"/*.wav 2>/dev/null)" \
                       || -z "$(ls -A "$SITE_STROKES"/*.wav 2>/dev/null)" ]]; then
    if [[ ! -x "$PY" ]]; then
        say "Creating virtualenv"
        python3 -m venv "$VENV"
    fi
    if ! "$PY" -c "import numpy, scipy" 2>/dev/null; then
        say "Installing build dependencies"
        "$PY" -m pip install --quiet --upgrade pip
        "$PY" -m pip install --quiet -r "$REPO/requirements.txt"
    fi

    if ! vcsl_complete; then
        say "Fetching VCSL samples (CC0, ~70 MB)"
        mkdir -p "$VENDOR"
        rm -rf "$VCSL"
        git init --quiet "$VCSL"
        git -C "$VCSL" remote add origin https://github.com/sgossner/VCSL.git
        git -C "$VCSL" fetch --quiet --depth 1 --filter=blob:none origin "$VCSL_REF"
        git -C "$VCSL" sparse-checkout set "${VCSL_PATHS[@]}"
        git -C "$VCSL" checkout --quiet FETCH_HEAD
    fi
    vcsl_complete || { echo "VCSL samples incomplete under $VCSL" >&2; exit 1; }

    say "Authoring drone loops"
    rm -rf "$LOOPS"; mkdir -p "$LOOPS"
    "$PY" "$REPO/tools/loopfind.py" "$VCSL_SUSTAIN" "$LOOPS"
    # Advisory, not fatal: the lowest note misses the CV threshold knowingly.
    "$PY" "$REPO/tools/loop_qa.py" "$LOOPS"/*.wav || true

    say "Authoring percussion one-shots"
    rm -rf "$STROKES"; mkdir -p "$STROKES"
    "$PY" "$REPO/tools/oneshot.py" "$VCSL" "$STROKES"
    # Fatal, unlike the loop gate: a one-shot that fails this carries a click
    # or a DC step, and every onset would sound it.
    "$PY" "$REPO/tools/stroke_qa.py" "$STROKES"/*.wav

    say "Publishing recordings into the site"
    mkdir -p "$SITE_LOOPS" "$SITE_STROKES"
    rm -f "$SITE_LOOPS"/*.wav "$SITE_STROKES"/*.wav
    cp "$LOOPS"/*.wav "$SITE_LOOPS/"
    cp "$STROKES"/*.wav "$SITE_STROKES/"
    # One manifest for both directories, written at the root the site serves.
    "$PY" "$REPO/tools/manifest.py" "$SITE"
fi

# --- 2. Serve ----------------------------------------------------------------
# Never hard-bind: a leftover process on the default port would kill the launch.
free_port() {
    python3 - "$1" <<'PYEOF'
import socket, sys
first = int(sys.argv[1])
for port in range(first, first + 40):
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) != 0:
            print(port); break
else:
    sys.exit(f"no free port in {first}..{first + 39}")
PYEOF
}
BOUND="$(free_port "$PORT")"
[[ "$BOUND" != "$PORT" ]] && say "port $PORT is busy — using $BOUND"

URL="http://127.0.0.1:$BOUND/"
if [[ $OPEN -eq 1 && -n "${DISPLAY:-}" ]] && command -v xdg-open >/dev/null; then
    ( sleep 1.2; xdg-open "$URL" >/dev/null 2>&1 || true ) &
fi

say "Press play in the browser — it makes the sound"
echo "    $URL"
exec python3 -m http.server "$BOUND" --bind 127.0.0.1 --directory "$SITE"
