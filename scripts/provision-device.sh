#!/bin/bash
# Sends a provisioning bundle to an ESP32 in provisioning mode. (macOS / Linux)
#
# Usage: ./scripts/provision-device.sh <bundle.json> [serial-port]
#
# Deliberately does NOT run `esptool erase_flash`: that wipes the NVS partition
# where a device's identity lives, which is exactly what we are trying to keep
# across firmware updates.
set -euo pipefail

BUNDLE="${1:-}"
PORT="${2:-$(ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART /dev/cu.wchusbserial* 2>/dev/null | head -1)}"

[ -f "$BUNDLE" ] || { echo "Usage: $0 <bundle.json> [port]"; exit 1; }
[ -n "$PORT" ] || { echo "No ESP32 serial port found. Pass one explicitly."; exit 1; }

# The bundle is a downloaded credential file. Collapse to one line, since the
# firmware reads a single line terminated by newline.
PAYLOAD=$(python3 -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))" "$BUNDLE")

echo "Port:   $PORT"
echo "Thing:  $(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['thingName'])" "$BUNDLE")"
echo "Sending bundle..."

stty -f "$PORT" 115200 raw 2>/dev/null || stty -F "$PORT" 115200 raw
printf '%s\n' "$PAYLOAD" > "$PORT"
sleep 2
echo "Sent. Watch the serial monitor: the device stores it in NVS and reboots."
echo
echo "Delete the bundle now - it contains the device private key:"
echo "  rm $BUNDLE"
