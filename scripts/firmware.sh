#!/usr/bin/env bash
#
# firmware.sh - build, flash and watch the ESP32 sketches.
#
#   scripts/firmware.sh setup                        once per machine: ESP32 core and libraries
#   scripts/firmware.sh build [sketch...]            compile; every sketch by default
#   scripts/firmware.sh build-as <sketch> <version>  compile one sketch as another version (ota.sh try)
#   scripts/firmware.sh flash <sketch> [port]        compile, then write it over USB
#   scripts/firmware.sh monitor [port]               the board's serial console, 115200 baud
#   scripts/firmware.sh version <sketch>             the FIRMWARE_VERSION a sketch declares
#   scripts/firmware.sh check-version <git ref>      fail if firmware changed without a bump
#
# The OTA pipeline builds with this same script, so the binary you flash over
# USB and the one the pipeline sends over the air come from the same command.
# Binaries land in build/firmware/<sketch>/, which git ignores.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

FQBN=esp32:esp32:esp32doit-devkit-v1
ESP32_INDEX=https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
BUILD_DIR="$REPO_ROOT/build/firmware"

usage() {
  sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

cmd_setup() {
  need arduino-cli "Install it with: brew install arduino-cli (see docs/SETUP.md)."
  # The ESP32 index is passed on each command rather than written into your
  # arduino-cli config, so setup leaves any other boards you use alone.
  arduino-cli core update-index --additional-urls "$ESP32_INDEX"
  arduino-cli core install esp32:esp32 --additional-urls "$ESP32_INDEX"
  arduino-cli lib install "PubSubClient" "ArduinoJson" "DHT sensor library" "ESP32Servo"
}

build_one() {   # build_one <sketch> [folder to compile, firmware/<sketch> by default]
  local sketch="$1" dir="${2:-$REPO_ROOT/firmware/$1}" version
  [ -f "$dir/$sketch.ino" ] || die "firmware/$sketch/$sketch.ino not found. A sketch folder must hold a .ino named after the folder."
  version=$(version_of < "$dir/$sketch.ino")
  # The version is what OTA keys on: no version, no way to ever release it.
  [ -n "$version" ] || die "firmware/$sketch/$sketch.ino declares no FIRMWARE_VERSION. Add: #define FIRMWARE_VERSION \"1.0.0\""

  step "Compile $sketch $version"
  # --libraries is what finds <CloudAgenticDevice.h> in firmware/libraries.
  # Nothing secret is compiled in: Wi-Fi and the certificate live in the
  # board's NVS, so one binary serves every board of this type.
  arduino-cli compile --fqbn "$FQBN" \
    --libraries "$REPO_ROOT/firmware/libraries" \
    --output-dir "$BUILD_DIR/$sketch" "$dir"
  endstep
}

cmd_build() {
  need arduino-cli "Install it with: brew install arduino-cli, then run: scripts/firmware.sh setup"
  local targets="$*" ino folder sketch
  if [ -z "$targets" ]; then
    # arduino-cli reports a misnamed .ino as "main file missing from sketch",
    # which does not say what to rename. Say it here instead.
    while IFS= read -r ino; do
      folder=$(basename "$(dirname "$ino")")
      [ "$(basename "$ino" .ino)" = "$folder" ] || die "$ino must be named $folder.ino to be a sketch."
    done < <(find "$REPO_ROOT/firmware" -name '*.ino' -not -path '*/libraries/*')
    targets=$(sketches)
  fi
  [ -n "$targets" ] || die "No sketches under firmware/."
  for sketch in $targets; do build_one "$sketch"; done
}

# build-as compiles a sketch under another FIRMWARE_VERSION, from a copy of its
# folder, so the checkout stays exactly as it is. scripts/ota.sh try uses it: a
# try runs on the boards as <version>-try.<n>, a version the pipeline never
# publishes. The binary lands where build puts it.
cmd_build_as() {
  local sketch="${1:-}" version="${2:-}" copy
  { [ -n "$sketch" ] && [ -f "$REPO_ROOT/firmware/$sketch/$sketch.ino" ] && [ -n "$version" ]; } \
    || die "Usage: scripts/firmware.sh build-as <sketch> <version>"
  # The version ends up in a C string and in a file name.
  [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] \
    || die "A version holds letters, digits, dots, dashes and plus signs only (got '$version')."
  need arduino-cli "Install it with: brew install arduino-cli, then run: scripts/firmware.sh setup"
  copy=$(mktemp -d)
  # shellcheck disable=SC2064  # expand $copy now: the trap runs after this function returns
  trap "rm -rf '$copy'" EXIT
  cp -R "$REPO_ROOT/firmware/$sketch" "$copy/$sketch"
  sed -E "s/^([[:space:]]*#define[[:space:]]+FIRMWARE_VERSION[[:space:]]+)\"[^\"]*\"/\\1\"$version\"/" \
    "$REPO_ROOT/firmware/$sketch/$sketch.ino" > "$copy/$sketch/$sketch.ino"
  [ "$(version_of < "$copy/$sketch/$sketch.ino")" = "$version" ] \
    || die "Could not set FIRMWARE_VERSION in the copy of $sketch.ino."
  build_one "$sketch" "$copy/$sketch"
}

cmd_flash() {
  local sketch="${1:-}" port="${2:-}"
  [ -n "$sketch" ] || die "Usage: scripts/firmware.sh flash <sketch> [port]"
  if [ -z "$port" ]; then
    port=$(detect_port) || die "No ESP32 found on USB. Plug it in, or name the port."
  fi
  cmd_build "$sketch"

  step "Flash $sketch to $port"
  # Rewrites the bootloader, partition table and application. NVS - the Wi-Fi
  # networks, Thing name, certificate and private key - is a separate partition
  # this never touches, so the board comes back up as itself. Never erase_flash
  # to "start clean": AWS issues a private key exactly once.
  arduino-cli upload --fqbn "$FQBN" --port "$port" \
    --input-dir "$BUILD_DIR/$sketch" "$REPO_ROOT/firmware/$sketch"
  endstep
  note "Flashed $sketch $(version_of < "$REPO_ROOT/firmware/$sketch/$sketch.ino"). Watch it with: scripts/firmware.sh monitor $port"
}

cmd_monitor() {
  need arduino-cli "Install it with: brew install arduino-cli"
  local port="${1:-}"
  if [ -z "$port" ]; then
    port=$(detect_port) || die "No ESP32 found on USB. Plug it in, or name the port."
  fi
  arduino-cli monitor --port "$port" --config baudrate=115200
}

cmd_version() {
  local sketch="${1:-}" version
  [ -f "$REPO_ROOT/firmware/$sketch/$sketch.ino" ] || die "Usage: scripts/firmware.sh version <sketch>"
  version=$(version_of < "$REPO_ROOT/firmware/$sketch/$sketch.ino")
  [ -n "$version" ] || die "firmware/$sketch declares no FIRMWARE_VERSION."
  echo "$version"
}

# A device only installs a version it is not already running, and the pipeline
# publishes each version once. So a firmware change that keeps its version
# number never reaches a single board - silently. This turns that into a failed
# check on the pull request. A change to the shared library changes every
# sketch, so it needs every sketch bumped.
cmd_check_version() {
  local base="${1:-}" fork sketch old new failed=0
  [ -n "$base" ] || die "Usage: scripts/firmware.sh check-version <git ref>, for example origin/Dev"
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$base^{commit}" > /dev/null \
    || die "Unknown git ref $base. Fetch it first, for example: git fetch origin Dev"
  # Compared from where this branch forked, against the working tree, so
  # uncommitted edits count too.
  fork=$(git -C "$REPO_ROOT" merge-base "$base" HEAD)

  for sketch in $(sketches); do
    if git -C "$REPO_ROOT" diff --quiet "$fork" -- \
         "firmware/libraries" "firmware/$sketch" ':(exclude)*.md'; then
      continue
    fi
    old=$(git -C "$REPO_ROOT" show "$fork:firmware/$sketch/$sketch.ino" 2>/dev/null | version_of || true)
    new=$(version_of < "$REPO_ROOT/firmware/$sketch/$sketch.ino")
    if [ -z "$old" ]; then
      echo "  $sketch: first versioned build, $new"
    elif [ "$new" != "$old" ] && [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -1)" = "$new" ]; then
      echo "  $sketch: $old -> $new"
    elif [ "$new" = "$old" ]; then
      warn "$sketch changed since $base, but FIRMWARE_VERSION is still $old. Raise it, or this change never reaches a board."
      failed=1
    else
      warn "$sketch changed since $base, but FIRMWARE_VERSION went down, from $old to ${new:-nothing}. It has to go up."
      failed=1
    fi
  done
  [ "$failed" = 0 ] || die "Firmware changed without a higher FIRMWARE_VERSION."
  echo "Firmware versions are in order."
}

cmd="${1:-}"
if [ $# -gt 0 ]; then shift; fi
case "$cmd" in
  setup)         cmd_setup ;;
  build)         cmd_build "$@" ;;
  build-as)      cmd_build_as "$@" ;;
  flash)         cmd_flash "$@" ;;
  monitor)       cmd_monitor "$@" ;;
  version)       cmd_version "$@" ;;
  check-version) cmd_check_version "$@" ;;
  *)             usage ;;
esac
