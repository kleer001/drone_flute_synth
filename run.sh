#!/usr/bin/env bash
#
# Serve the drone flute locally.
#
#   ./run.sh                serve and open a browser
#   ./run.sh --port 9000    ask for a particular port
#   ./run.sh --rebuild      re-author the loops from the VCSL samples
#   ./run.sh --no-open      serve, but do not open a browser
#
# The instrument is a static site in docs/ -- the same files GitHub Pages
# serves, so what you hear here is what the public page plays. Python is needed
# only to author loops, which is a build step you can skip: the authored loops
# are committed.
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
SITE="$REPO/docs"
SITE_LOOPS="$SITE/loops"
VENV="$REPO/.venv"
PY="$VENV/bin/python"

VCSL_SUSTAIN="$VENDOR/VCSL/Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder/Sustain"

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

# --- 1. Loops, only if they are missing or you asked -------------------------
if [[ $REBUILD -eq 1 || -z "$(ls -A "$SITE_LOOPS"/*.wav 2>/dev/null)" ]]; then
    if [[ ! -x "$PY" ]]; then
        say "Creating virtualenv"
        python3 -m venv "$VENV"
    fi
    if ! "$PY" -c "import numpy, scipy" 2>/dev/null; then
        say "Installing build dependencies"
        "$PY" -m pip install --quiet --upgrade pip
        "$PY" -m pip install --quiet -r "$REPO/requirements.txt"
    fi

    if [[ ! -d "$VCSL_SUSTAIN" ]]; then
        say "Fetching VCSL recorder samples (CC0, ~30 MB)"
        mkdir -p "$VENDOR"
        rm -rf "$VENDOR/VCSL"
        git clone --quiet --filter=blob:none --sparse --depth 1 \
            https://github.com/sgossner/VCSL.git "$VENDOR/VCSL"
        git -C "$VENDOR/VCSL" sparse-checkout set "Aerophones"
    fi
    [[ -d "$VCSL_SUSTAIN" ]] || { echo "VCSL sustains not found at $VCSL_SUSTAIN" >&2; exit 1; }

    say "Authoring drone loops"
    rm -rf "$LOOPS"; mkdir -p "$LOOPS"
    "$PY" "$REPO/tools/loopfind.py" "$VCSL_SUSTAIN" "$LOOPS"
    # Advisory, not fatal: the lowest note misses the CV threshold knowingly.
    "$PY" "$REPO/tools/loop_qa.py" "$LOOPS"/*.wav || true

    say "Publishing loops into the site"
    mkdir -p "$SITE_LOOPS"
    rm -f "$SITE_LOOPS"/*.wav
    cp "$LOOPS"/*.wav "$SITE_LOOPS/"
    "$PY" "$REPO/tools/manifest.py" "$SITE_LOOPS"
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
