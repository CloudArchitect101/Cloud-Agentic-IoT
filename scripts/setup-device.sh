#!/bin/bash
#
# setup-device.sh - first-time setup for one ESP32, start to finish. (macOS / Linux)
#
# Usage: ./scripts/setup-device.sh [folder-with-downloaded-certificates]
#
# Asks, line by line, for the WiFi network and the files you downloaded from
# AWS IoT Core. Then it compiles the firmware, flashes it over USB, and sends
# the credentials to the device, which stores them in NVS flash.
#
# Why flashing comes first: a blank ESP32 has no WiFi stack, no TLS, and no
# idea that AWS exists. Its ROM bootloader speaks serial and nothing else, so
# it cannot fetch its own firmware. OTA only works once our firmware is already
# running - see docs/DEVICE-IDENTITY.md.
#
# Nothing secret is written into the repo. The bundle is built in a temp file
# with owner-only permissions and deleted on exit, however this script ends.

set -euo pipefail

FQBN="esp32:esp32:esp32doit-devkit-v1"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE_CPP="$REPO/firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp"

BUNDLE="$(mktemp "${TMPDIR:-/tmp}/bundle.XXXXXX.json")"
chmod 600 "$BUNDLE"
trap 'rm -f "$BUNDLE"' EXIT INT TERM

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# read -p writes its prompt to stderr, so the answer alone lands on stdout and
# can be captured with $(...). Anything else this function prints must also go
# to stderr or it would be captured as part of the answer.
ask() {
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply
    printf '%s' "${reply:-$default}"
  else
    while :; do
      read -r -p "  $prompt: " reply
      [ -n "$reply" ] && break
      echo "    (required)" >&2
    done
    printf '%s' "$reply"
  fi
}

command -v python3 >/dev/null || die "python3 is required (it builds the JSON bundle)."

# ---------------------------------------------------------------- 1. the files
bold "Step 1 of 5 - the files you downloaded from AWS IoT Core"
echo "Put the certificate, the private key, and Amazon Root CA 1 in one folder."

CERT_DIR="${1:-}"
[ -n "$CERT_DIR" ] || CERT_DIR="$(ask "Folder holding those files" "$HOME/Downloads")"
CERT_DIR="${CERT_DIR/#\~/$HOME}"
[ -d "$CERT_DIR" ] || die "No such folder: $CERT_DIR"

echo
echo "Files in $CERT_DIR:"
ls -1 "$CERT_DIR" | sed 's/^/    /'
echo

# AWS uses predictable download names, so offer them as defaults. Any of them
# can be overwritten by just typing a different filename.
guess() { ls -1 "$CERT_DIR" 2>/dev/null | grep -i -m1 -E "$1" || true; }

CERT_FILE="$(ask "Certificate file"  "$(guess 'certificate\.pem\.crt$|\.crt$')")"
KEY_FILE="$(ask  "Private key file"  "$(guess 'private\.pem\.key$|\.key$')")"
CA_FILE="$(ask   "Amazon Root CA file" "$(guess 'amazonrootca1?\.pem$|root.*ca.*\.pem$')")"

for f in "$CERT_FILE" "$KEY_FILE" "$CA_FILE"; do
  [ -f "$CERT_DIR/$f" ] || die "Not found: $CERT_DIR/$f"
done

# Catch the classic mix-up - cert and key swapped - before it turns into an
# opaque TLS handshake failure hours later.
grep -q "BEGIN CERTIFICATE"  "$CERT_DIR/$CERT_FILE" || die "$CERT_FILE is not a certificate."
grep -q "PRIVATE KEY"        "$CERT_DIR/$KEY_FILE"  || die "$KEY_FILE is not a private key."
grep -q "BEGIN CERTIFICATE"  "$CERT_DIR/$CA_FILE"   || die "$CA_FILE is not a certificate."

# ------------------------------------------------------------- 2. the identity
bold "Step 2 of 5 - which Thing is this?"

THING_NAME="$(ask "Thing name (exactly as in AWS IoT Core)")"

# The endpoint is per AWS account and region, identical for every device in it,
# so read it from the AWS CLI when that is configured rather than making the
# user hunt through the console.
ENDPOINT_GUESS="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS \
                    --query endpointAddress --output text 2>/dev/null || true)"
[ "$ENDPOINT_GUESS" = "None" ] && ENDPOINT_GUESS=""
ENDPOINT="$(ask "AWS IoT data endpoint" "$ENDPOINT_GUESS")"

# ----------------------------------------------------------------- 3. the wifi
bold "Step 3 of 5 - the WiFi network"
echo "This is the only part you can change later without a rebuild:"
echo "scripts/update-wifi.sh replaces it, and NVS remembers up to 3 networks."
echo

WIFI_SSID="$(ask "WiFi SSID")"
read -r -s -p "  WiFi passphrase (hidden): " WIFI_PASS
echo

# Last chance to catch a typo. Everything after this point writes to the device,
# and the identity namespace is write-once - a wrong Thing name here means
# re-provisioning through Salesforce rather than just running this again.
bold "Check this before anything is written"
cat <<EOF
  Thing name:   $THING_NAME
  Endpoint:     $ENDPOINT
  Certificate:  $CERT_FILE
  Private key:  $KEY_FILE
  Root CA:      $CA_FILE
  WiFi SSID:    $WIFI_SSID
  Passphrase:   $(printf '%*s' ${#WIFI_PASS} '' | tr ' ' '*')
EOF
CONFIRM="$(ask "Correct? (y/n)" "y")"
case "$CONFIRM" in [yY]*) ;; *) die "Stopped - nothing was written." ;; esac

# ------------------------------------------------------------- 4. the firmware
bold "Step 4 of 5 - build and flash"

SKETCHES=()
while IFS= read -r d; do SKETCHES+=("$d"); done < <(
  find "$REPO/firmware" -mindepth 1 -maxdepth 1 -type d ! -name libraries -exec basename {} \; | sort
)
[ ${#SKETCHES[@]} -gt 0 ] || die "No sketches found under firmware/"

echo "Device types available:"
for s in "${SKETCHES[@]}"; do echo "    $s"; done
SKETCH="$(ask "Which one is this device" "${SKETCHES[0]}")"
[ -d "$REPO/firmware/$SKETCH" ] || die "No sketch named '$SKETCH'."

PORT_GUESS="$(ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART /dev/cu.wchusbserial* \
                 /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -1 || true)"
PORT="$(ask "Serial port" "$PORT_GUESS")"
[ -e "$PORT" ] || die "No such serial port: $PORT (is the ESP32 plugged in?)"

# The Root CA is the one credential that IS compiled in: it is the same public
# certificate for every device in every AWS account, so it is not a secret. The
# repo ships a placeholder; fill it in the first time and it stays filled.
if grep -q "PASTE AMAZON ROOT CA 1 HERE" "$DEVICE_CPP"; then
  echo "  Root CA placeholder found in firmware - filling it in from $CA_FILE"
  CA_PATH="$CERT_DIR/$CA_FILE" TARGET="$DEVICE_CPP" python3 - <<'PY'
import os, re, sys

target, ca_path = os.environ["TARGET"], os.environ["CA_PATH"]
source = open(target).read()
ca = open(ca_path).read().strip()

# Replace only what sits between the raw-string delimiters. Anchoring on both
# of them means a malformed match cannot silently eat surrounding code.
pattern = re.compile(r'(R"EOF_CA\().*?(\)EOF_CA")', re.DOTALL)
patched, count = pattern.subn(lambda m: m.group(1) + "\n" + ca + "\n" + m.group(2), source, count=1)

if count != 1:
    sys.exit("Could not find the AWS_ROOT_CA block - fill it in by hand.")
if "PASTE AMAZON ROOT CA 1 HERE" in patched or "BEGIN CERTIFICATE" not in patched:
    sys.exit("Root CA substitution produced unexpected output - aborting.")
# The delimiters must survive untouched, or the file no longer compiles.
if patched.count('R"EOF_CA(') != 1 or patched.count(')EOF_CA"') != 1:
    sys.exit("Raw string delimiters were damaged - aborting.")

open(target, "w").write(patched)
print("  Root CA written into CloudAgenticDevice.cpp")
PY
fi

if command -v arduino-cli >/dev/null; then
  echo "  Compiling $SKETCH..."
  arduino-cli compile --fqbn "$FQBN" \
    --libraries "$REPO/firmware/libraries" "$REPO/firmware/$SKETCH"
  echo "  Flashing over USB..."
  arduino-cli upload -p "$PORT" --fqbn "$FQBN" "$REPO/firmware/$SKETCH"
else
  warn "arduino-cli not found - skipping build and flash."
  warn "The firmware must already be running on the device, or the next step"
  warn "has nothing listening on the serial port. See firmware/README.md."
fi

# ---------------------------------------------------------- 5. the credentials
bold "Step 5 of 5 - sending credentials to the device"

CERT_PATH="$CERT_DIR/$CERT_FILE" KEY_PATH="$CERT_DIR/$KEY_FILE" \
THING="$THING_NAME" ENDPOINT="$ENDPOINT" SSID="$WIFI_SSID" PASS="$WIFI_PASS" \
OUT="$BUNDLE" python3 - <<'PY'
import json, os

# Values arrive through the environment, never through the command line: a
# passphrase in argv is visible to every user on the machine via `ps`.
bundle = {
    "ssid":           os.environ["SSID"],
    "passphrase":     os.environ["PASS"],
    "thingName":      os.environ["THING"],
    "endpoint":       os.environ["ENDPOINT"],
    "certificatePem": open(os.environ["CERT_PATH"]).read(),
    "privateKey":     open(os.environ["KEY_PATH"]).read(),
}
# The firmware reads exactly one newline-terminated line, so the JSON must be
# compact - the embedded newlines inside the PEMs become \n escapes.
with open(os.environ["OUT"], "w") as f:
    f.write(json.dumps(bundle, separators=(",", ":")))
PY

stty -f "$PORT" 115200 raw -echo 2>/dev/null || stty -F "$PORT" 115200 raw -echo

# Hold the port open for the whole exchange. Opening it toggles DTR, which
# resets the ESP32 - so wait for it to boot into provisioning mode before
# writing, otherwise the bundle arrives while the bootloader is still running
# and is lost. Reading the same handle shows the device's own replies.
exec 3<>"$PORT"
echo "  Waiting for the device to boot..."
sleep 4

tr -d '\n' < "$BUNDLE" >&3
printf '\n' >&3

echo "  Sent. Device says:"
echo "  ----------------------------------------------------------------"
cat <&3 | sed 's/^/  /' &
READER=$!
sleep 8
kill "$READER" 2>/dev/null || true
wait "$READER" 2>/dev/null || true
exec 3>&-
echo "  ----------------------------------------------------------------"

bold "Done"
cat <<EOF
The device stored its identity in NVS and rebooted. It should now connect to
WiFi and to AWS IoT on its own - watch it with:

    arduino-cli monitor -p $PORT -c baudrate=115200

The credentials bundle was a temp file and has been deleted. The downloaded
private key in $CERT_DIR is still on disk, and AWS issues it exactly once -
keep it somewhere safe or delete it, but do not leave it in Downloads.

Do this next: add your phone hotspot as the second network.

    ./scripts/update-wifi.sh "<hotspot-SSID>" "<hotspot-passphrase>"

NVS has 3 slots and only the third one ever rotates, so the first two are
permanent anchors. The network you just provisioned took slot 0; a hotspot in
slot 1 means the device can reach AWS from almost anywhere, which is what lets
the third slot be updated remotely later - no USB, no rebuild.

From here on, firmware updates are over the air too: NVS is a separate
partition, so WiFi and certificate survive every update.
EOF
