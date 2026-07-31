#!/bin/bash
# Updates ONLY the Wi-Fi credentials on a provisioned ESP32. (macOS / Linux)
#
# Usage: ./scripts/update-wifi.sh "<SSID>" "<passphrase>" [serial-port]
#
# The device writes these to its "wifi" NVS namespace. The "identity"
# namespace - Thing name, endpoint, certificate, private key - is untouched.
#
# Do NOT use `esptool erase_flash` for this. It wipes NVS entirely, destroying
# a private key that AWS issues exactly once and will never reissue. If that
# has already happened, use the Re-provision button on the Asset in Salesforce
# instead: it rotates the certificate and keeps all device history.
set -euo pipefail

SSID="${1:-}"
PASS="${2:-}"
PORT="${3:-$(ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART /dev/cu.wchusbserial* 2>/dev/null | head -1)}"

[ -n "$SSID" ] || { echo "Usage: $0 \"<SSID>\" \"<passphrase>\" [port]"; exit 1; }
[ -n "$PORT" ] || { echo "No ESP32 serial port found. Pass one explicitly."; exit 1; }

PAYLOAD=$(SSID="$SSID" PASS="$PASS" python3 -c \
  'import json,os;print(json.dumps({"ssid":os.environ["SSID"],"passphrase":os.environ["PASS"]}))')

echo "Port: $PORT"
echo "SSID: $SSID"
stty -f "$PORT" 115200 raw 2>/dev/null || stty -F "$PORT" 115200 raw
printf '%s\n' "$PAYLOAD" > "$PORT"
sleep 1
echo "Sent. The device stores it alongside any existing networks."
echo "Certificate and Thing name are untouched."
