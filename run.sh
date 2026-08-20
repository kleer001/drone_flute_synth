#!/usr/bin/env bash
#
# Launch the drone flute: fetch what's missing, build the organ, start
# GrandOrgue, and play into it.
#
#   ./run.sh                      play forever, contemplative
#   ./run.sh --mood restless      pick a mood
#   ./run.sh --seed 42            reproduce a performance exactly
#   ./run.sh --duration 60        stop after 60 seconds
#   ./run.sh --dry-run            no GrandOrgue, no audio; print the performance
#   ./run.sh --rebuild            rebuild loops and organ from scratch
#
# Everything it downloads goes in vendor/ and everything it builds goes in
# build/; both are gitignored. Nothing is installed system-wide and nothing
# needs root.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$REPO/vendor"
BUILD="$REPO/build"
LOOPS="$BUILD/loops"
VENV="$REPO/.venv"
PY="$VENV/bin/python"

PROFILE="$REPO/profiles/naf-double-drone-as.toml"
ORGAN="$BUILD/naf-double-drone-as.organ"

GO_VERSION="3.17.3-1"
GO_URL="https://github.com/GrandOrgue/grandorgue/releases/download/${GO_VERSION}/grandorgue-${GO_VERSION}.x86_64.AppImage"
VCSL_SUSTAIN="$VENDOR/VCSL/Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder/Sustain"

MOOD="contemplative"
SEED=""
DURATION=""
DRY_RUN=0
REBUILD=0
PLAY_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mood)     MOOD="$2"; shift 2 ;;
        --seed)     SEED="$2"; shift 2 ;;
        --duration) DURATION="$2"; shift 2 ;;
        --dry-run)  DRY_RUN=1; shift ;;
        --rebuild)  REBUILD=1; shift ;;
        -h|--help)  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        *)          echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. Python environment -------------------------------------------------
if [[ ! -x "$PY" ]]; then
    say "Creating virtualenv"
    python3 -m venv "$VENV"
fi
# Cheap idempotence check: only pip install when an import is actually missing.
if ! "$PY" -c "import numpy, scipy, mido, rtmidi" 2>/dev/null; then
    say "Installing Python dependencies"
    "$PY" -m pip install --quiet --upgrade pip
    "$PY" -m pip install --quiet -r "$REPO/requirements.txt"
fi

# --- 2. Samples ------------------------------------------------------------
# VCSL is CC0 but large, so only the Aerophones subtree is checked out.
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
if [[ $REBUILD -eq 1 ]]; then rm -rf "$LOOPS" "$ORGAN"; fi
if [[ ! -d "$LOOPS" ]]; then
    say "Building drone loops"
    mkdir -p "$LOOPS"
    "$PY" "$REPO/tools/loopfind.py" "$VCSL_SUSTAIN" "$LOOPS"
    # The gate is advisory here, not fatal: 8 of 13 loops pass, and the
    # profile knowingly uses one that does not (SPEC §12 criterion 3).
    "$PY" "$REPO/tools/loop_qa.py" "$LOOPS"/*.wav || true
fi

# --- 4. Organ --------------------------------------------------------------
if [[ ! -f "$ORGAN" ]]; then
    say "Generating the organ definition"
    "$PY" -m belvedere_drone.cli odf "$PROFILE" "$BUILD" --loops "$LOOPS"
fi

# --- 5. Play ---------------------------------------------------------------
PLAY_ARGS=(--out-dir "$BUILD" --mood "$MOOD")
[[ -n "$SEED" ]]     && PLAY_ARGS+=(--seed "$SEED")
[[ -n "$DURATION" ]] && PLAY_ARGS+=(--duration-s "$DURATION")

if [[ $DRY_RUN -eq 1 ]]; then
    say "Dry run — no GrandOrgue, no audio"
    [[ -n "$DURATION" ]] || PLAY_ARGS+=(--max-breaths 12)
    exec "$PY" -m belvedere_drone.cli play "$PROFILE" --dry-run "${PLAY_ARGS[@]}"
fi

# GrandOrgue: prefer one already installed, else use the upstream AppImage.
# It is extracted rather than run directly so it works without FUSE.
GO_BIN="$(command -v GrandOrgue || true)"
if [[ -z "$GO_BIN" ]]; then
    if [[ ! -x "$VENDOR/grandorgue/AppRun" ]]; then
        say "Fetching GrandOrgue $GO_VERSION (~230 MB, no root needed)"
        mkdir -p "$VENDOR"
        curl -fL --progress-bar -o "$VENDOR/GrandOrgue.AppImage" "$GO_URL"
        chmod +x "$VENDOR/GrandOrgue.AppImage"
        ( cd "$VENDOR" && ./GrandOrgue.AppImage --appimage-extract >/dev/null \
          && rm -rf grandorgue && mv squashfs-root grandorgue )
        rm -f "$VENDOR/GrandOrgue.AppImage"
    fi
    GO_BIN="$VENDOR/grandorgue/AppRun"
fi

say "Starting GrandOrgue"
echo "    $GO_BIN"
echo "    $ORGAN"
"$GO_BIN" "$ORGAN" &
GO_PID=$!
# GrandOrgue is the sound; if it dies, stop rather than play to nothing.
trap 'kill $GO_PID 2>/dev/null || true' EXIT

say "Waiting for GrandOrgue's MIDI port"
for _ in $(seq 1 120); do
    if "$PY" -c "import mido,sys; sys.exit(0 if any('GrandOrgue' in p for p in mido.get_output_names()) else 1)" 2>/dev/null; then
        break
    fi
    kill -0 "$GO_PID" 2>/dev/null || { echo "GrandOrgue exited before opening a MIDI port" >&2; exit 1; }
    sleep 1
done
"$PY" -c "import mido,sys; sys.exit(0 if any('GrandOrgue' in p for p in mido.get_output_names()) else 1)" \
    || { echo "timed out waiting for the GrandOrgue MIDI port" >&2; exit 1; }

# The organ still has to finish loading its samples after the port appears.
sleep 3

say "Playing — Ctrl-C to stop"
"$PY" -m belvedere_drone.cli play "$PROFILE" "${PLAY_ARGS[@]}"
