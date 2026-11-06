#!/bin/bash
# Updates ONLY the Wi-Fi credentials on a provisioned ESP32. (macOS / Linux)
#
# Usage: ./scripts/update-wifi.sh "<SSID>" "<passphrase>" [serial-port]
#
# The device writes these to its "wifi" NVS namespace. The "identity"
# namespace - Thing name, endpoint, certificate, private key - is untouched.
# Close any serial monitor first: only one program can hold the port.
# scripts/lib/board_serial.py sends the network once the board can read it and
# waits for the board to confirm.
#
# Do NOT use `esptool erase_flash` for this. It wipes NVS entirely, destroying
# a private key that AWS issues exactly once and will never reissue. If that
# has already happened, use the Re-provision button on the Asset in Salesforce
# instead: it rotates the certificate and keeps all device history.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

SSID="${1:-}"
PASS="${2:-}"
PORT="${3:-}"

[ -n "$SSID" ] || die "Usage: $0 \"<SSID>\" \"<passphrase>\" [serial-port]"
need python3 "It comes with the Xcode command line tools: xcode-select --install"
if [ -z "$PORT" ]; then
  PORT=$(detect_port) || die "No ESP32 found on USB. Plug it in, or name the port as the third argument."
fi

echo "SSID:   $SSID"
# Through the environment, not the command line, where ps would show it.
WIFI_SSID="$SSID" WIFI_PASS="$PASS" exec python3 "$REPO_ROOT/scripts/lib/board_serial.py" wifi "$PORT"
