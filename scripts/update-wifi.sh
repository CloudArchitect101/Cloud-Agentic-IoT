#!/bin/bash
# Updates ONLY the Wi-Fi credentials on a provisioned ESP32. (macOS / Linux)
#
# Usage: ./scripts/update-wifi.sh "<SSID>" [serial-port]
#        ./scripts/update-wifi.sh "<SSID>" "<passphrase>" [serial-port]
#
# The first form asks for the passphrase without showing it. Prefer it: a
# passphrase typed on the command line stays in your shell history. Press
# Enter at the prompt for an open network.
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
[ -n "$SSID" ] || die "Usage: $0 \"<SSID>\" [serial-port]   (it asks for the passphrase)"

# A second argument that names a device is the port; anything else is the
# passphrase, for scripts that cannot answer a prompt.
case "${2:-}" in
  /dev/*) PORT="$2"; ASK=yes ;;
  *)      PORT="${3:-}"; if [ "$#" -ge 2 ]; then PASS="$2"; ASK=no; else ASK=yes; fi ;;
esac
if [ "$ASK" = yes ]; then
  [ -t 0 ] || die "Run this in a terminal, so it can ask for the passphrase."
  read -r -s -p "Passphrase for $SSID (not shown; Enter for an open network): " PASS \
    || die "No passphrase was entered; nothing was sent."
  echo
fi

need python3 "It comes with the Xcode command line tools: xcode-select --install"
if [ -z "$PORT" ]; then
  PORT=$(detect_port) || die "No ESP32 found on USB. Plug it in, or name the port: $0 \"$SSID\" /dev/cu.usbserial-0001"
fi

echo "SSID:   $SSID"
# Through the environment, not python's command line, where ps would show it.
WIFI_SSID="$SSID" WIFI_PASS="$PASS" exec python3 "$REPO_ROOT/scripts/lib/board_serial.py" wifi "$PORT"
