#!/bin/bash
# Sends a provisioning bundle to an ESP32 over USB. (macOS / Linux)
#
# Usage: ./scripts/provision-device.sh <bundle.json> [serial-port]
#
# Close any serial monitor first: only one program can hold the port. This
# restarts the board, waits for it to ask for the bundle, sends the bundle in
# pieces the board can keep up with, then shows what the board says until it
# is online. scripts/lib/board_serial.py does the talking, and says why that
# takes more than writing the bundle to the port.
#
# Deliberately does NOT run `esptool erase_flash`: that wipes the NVS partition
# where a device's identity lives, which is exactly what we are trying to keep
# across firmware updates.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

BUNDLE="${1:-}"
PORT="${2:-}"

[ -f "$BUNDLE" ] || die "Usage: $0 <bundle.json> [serial-port]"
need python3 "It comes with the Xcode command line tools: xcode-select --install"
if [ -z "$PORT" ]; then
  PORT=$(detect_port) || die "No ESP32 found on USB. Plug it in, or name the port: $0 $BUNDLE /dev/cu.usbserial-0001"
fi

status=0
python3 "$REPO_ROOT/scripts/lib/board_serial.py" provision "$PORT" "$BUNDLE" || status=$?

echo
case "$status" in
  0) echo "Delete the bundle now: it holds the device's private key, and the board no longer needs it."
     printf '  rm %q\n' "$BUNDLE" ;;
  3) echo "Keep the bundle until the board says \"aws: connected\" (scripts/firmware.sh monitor), then delete it." ;;
  2) echo "Nothing was sent, so the bundle is unused. Keep it until the board it is for has it." ;;
  *) echo "Nothing was stored. Keep the bundle and run this again once the problem above is fixed." ;;
esac
exit "$status"
