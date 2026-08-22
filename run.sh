#!/usr/bin/env bash
#
# Launch the drone flute with the browser making the sound.
#
#   ./run.sh                    serve and open a browser, contemplative
#   ./run.sh --mood restless    pick a mood
#   ./run.sh --seed 42          reproduce a performance exactly
#   ./run.sh --port 9000        ask for a particular port
#   ./run.sh --rebuild          rebuild the loops from the samples
#   ./run.sh --no-open          serve, but do not open a browser
#
# No GrandOrgue, no MIDI, no ODF: Python plans the breaths and the page plays
# the same loops with Web Audio. The GrandOrgue version is ./run_old.sh.
#
# Everything downloaded goes in vendor/ and everything built goes in build/;
# both are gitignored. Nothing is installed system-wide and nothing needs root.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$REPO/vendor"
BUILD="$REPO/build"
LOOPS="$BUILD/loops"
VENV="$REPO/.venv"
PY="$VENV/bin/python"

PROFILE="$REPO/profiles/recorder-drone-c.toml"
VCSL_SUSTAIN="$VENDOR/VCSL/Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder/Sustain"

MOOD="contemplative"
SEED=""
PORT=8740
REBUILD=0
OPEN=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mood)    MOOD="$2"; shift 2 ;;
        --seed)    SEED="$2"; shift 2 ;;
        --port)    PORT="$2"; shift 2 ;;
        --rebuild) REBUILD=1; shift ;;
        --no-open) OPEN=0; shift ;;
        -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next }
                        NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. Python environment -------------------------------------------------
if [[ ! -x "$PY" ]]; then
    say "Creating virtualenv"
    python3 -m venv "$VENV"
fi
# The browser version needs no MIDI, so numpy and scipy are the whole ask.
if ! "$PY" -c "import numpy, scipy" 2>/dev/null; then
    say "Installing Python dependencies"
    "$PY" -m pip install --quiet --upgrade pip
    "$PY" -m pip install --quiet -r "$REPO/requirements.txt"
fi

# --- 2. Samples ------------------------------------------------------------
if [[ ! -d "$VCSL_SUSTAIN" ]]; then
    say "Fetching VCSL recorder samples (CC0, ~30 MB)"
    mkdir -p "$VENDOR"
    rm -rf "$VENDOR/VCSL"
    git clone --quiet --filter=blob:none --sparse --depth 1 \
        https://github.com/sgossner/VCSL.git "$VENDOR/VCSL"
    git -C "$VENDOR/VCSL" sparse-checkout set "Aerophones"
fi
[[ -d "$VCSL_SUSTAIN" ]] || { echo "VCSL sustains not found at $VCSL_SUSTAIN" >&2; exit 1; }

# --- 3. Loops --------------------------------------------------------------
[[ $REBUILD -eq 1 ]] && rm -rf "$LOOPS"
if [[ ! -d "$LOOPS" ]]; then
    say "Building drone loops"
    mkdir -p "$LOOPS"
    "$PY" "$REPO/tools/loopfind.py" "$VCSL_SUSTAIN" "$LOOPS"
    # Advisory, not fatal: the profile knowingly uses C4 for the drone, whose
    # loop misses the CV threshold (SPEC §12 criterion 3).
    "$PY" "$REPO/tools/loop_qa.py" "$LOOPS"/*.wav || true
fi

# --- 4. Serve --------------------------------------------------------------
# The house rule: never hard-bind, or a leftover process kills the launch.
free_port() {
    "$PY" - "$1" <<'PYEOF'
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

ARGS=(--loops "$LOOPS" --mood "$MOOD" --port "$BOUND")
[[ -n "$SEED" ]] && ARGS+=(--seed "$SEED")

URL="http://127.0.0.1:$BOUND/"
if [[ $OPEN -eq 1 && -n "${DISPLAY:-}" ]] && command -v xdg-open >/dev/null; then
    ( sleep 1.5; xdg-open "$URL" >/dev/null 2>&1 || true ) &
fi

say "Press play in the browser — it makes the sound"
exec "$PY" -m belvedere_drone.browser.server "$PROFILE" "${ARGS[@]}"
