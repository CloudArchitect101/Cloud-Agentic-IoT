# Device Identity, Credentials, and How OTA Finds the Right Device

Answers three questions that the architecture diagrams gloss over: where WiFi credentials live, where certificates live (and why **not** in GitHub), and how AWS decides which firmware goes to which device.

## 1. Nothing secret is compiled into the firmware

WiFi is a property of the **location**; the certificate is a property of the **device**. Neither belongs in a binary, so the firmware is built with neither. One `.bin` is valid for every device of that type, which is what makes a single OTA job able to target a whole fleet.

Credentials reach the device **after** flashing, as a one-line JSON bundle sent over the USB serial port. The device writes them into its NVS flash partition and never needs them handed to it again:

| What | How it gets there | NVS namespace |
|---|---|---|
| SSID + passphrase | Serial bundle, `scripts/update-wifi.sh`, or an MQTT push from Salesforce | `wifi` — 3 slots, tried in insertion order |
| Thing name, IoT endpoint, certificate, private key | Serial bundle, write-once | `identity` |
| Amazon Root CA | Compiled in — identical for every device and account, so not a secret | — |

GitHub secrets are the wrong home for any of this: the firmware build in CI is a **compile check only**. Flashing needs physical USB access, so CI could never inject credentials into a real device anyway.

### The one-time setup

**Two things to do by hand, then one script.**

1. **Create the Thing in AWS IoT Core.** Attach the least-privilege policy from [the README's one-time AWS IoT setup](../README.md#create-the-thing-and-its-certificate).
2. **Download all three files into one folder** — the certificate, the private key, and Amazon Root CA 1. `~/Downloads` is fine; keep the names AWS gives them.
3. **Plug the ESP32 in and run the wizard:**

   ```bash
   ./scripts/setup-device.sh          # macOS / Linux
   .\scripts\setup-device.ps1         # Windows
   ```

It asks, one line at a time, and fills in a sensible default wherever it can work one out:

| It asks for | Where the default comes from |
|---|---|
| The folder with the downloaded files | `~/Downloads` |
| Which file is the certificate / key / Root CA | Matched from AWS's own download names |
| Thing name | — you type it, exactly as in AWS |
| AWS IoT endpoint | `aws iot describe-endpoint`, if the AWS CLI is set up |
| WiFi SSID and passphrase | — you type them; the passphrase is not echoed |
| Device type and serial port | The sketch folders under `firmware/`, and the detected port |

It then shows you everything it collected — passphrase masked — and waits for a yes. That confirmation is worth reading: the `identity` namespace is write-once, so a wrong Thing name means re-provisioning through Salesforce rather than just running the script again.

After the confirmation it needs no further input. It pastes the Root CA into the firmware, compiles, flashes over USB, sends the credentials, and prints what the device says back. The device writes NVS, reboots, and connects to WiFi and AWS IoT on its own.

The credential bundle is assembled in a temp file with owner-only permissions and deleted when the script exits, so no private key is ever written into the repo. The originals in your download folder are still there — AWS issues that key exactly once, so keep them somewhere safe or delete them, but do not leave them in `Downloads`.

**One step after the wizard:** it provisions a single network, which lands in slot 0. Add your phone hotspot as slot 1 straight away —

```bash
./scripts/update-wifi.sh "<hotspot-SSID>" "<hotspot-passphrase>"
```

— because that anchor is what makes the third slot remotely updatable. See [what the 3 slots actually do](#what-the-3-slots-actually-do).

> `scripts/provision-device.sh` and `scripts/update-wifi.sh` are still there and still work. `setup-device.sh` is the wizard that does the whole first-time sequence; those two are the narrower tools for re-sending an existing bundle or changing only WiFi.

### Why the firmware has to be flashed first

A blank ESP32 cannot fetch its own firmware, and no amount of correct WiFi credentials changes that. The chip's ROM bootloader speaks serial and nothing else — it has no WiFi driver, no TLS, no MQTT client, and no concept of "check whether newer firmware exists." All of that is code in *our* firmware: `applyFirmware()` in `CloudAgenticDevice.cpp` is what downloads an update, and it only runs once the device is already connected.

So the order is fixed, and the wizard enforces it:

```
flash firmware over USB   →   firmware boots, finds no identity in NVS
                          →   drops into provisioning mode, waits on serial
                          →   receives the bundle, writes NVS, reboots
                          →   connects to WiFi + AWS IoT
                          →   every update after this one is over the air
```

The `.ino` does need to be present before you run the script — it is in the repo you already cloned, and the wizard asks which device type to build. It never needs to be edited: the sketch holds only sensors and pins, and nothing device-specific is compiled in.

### What OTA does and does not touch

A firmware update rewrites the **application partition only**. NVS is a separate partition, so WiFi credentials and the device identity survive every update — the device reboots into new code and reconnects with the same certificate, with nobody at the desk. That is the whole point of keeping credentials out of the binary.

The one thing that destroys this is `esptool erase_flash`, which wipes NVS including a private key AWS will never reissue. Neither provisioning script runs it, deliberately. If it has already happened, use the Re-provision button on the Asset in Salesforce: it rotates the certificate and keeps device history.

### Moving the device to a different WiFi network

**No recompile and no reflash.** The `wifi` namespace is separate from `identity`, so credentials can be replaced on their own:

- **Over USB, no rebuild** — `./scripts/update-wifi.sh "<SSID>" "<passphrase>"` sends just `{"ssid":…,"passphrase":…}`. `checkSerialWifiUpdate()` accepts this at any time while the device is running, and the certificate is untouched.
- **Remotely, while the device is still online** — updating a `Wi_Fi_Network__c` record in Salesforce makes `WiFiCredentialService` push the credentials through the `device-command` Lambda to `device/<thing>/command`, where the library stores them. The device is by definition still on the *old* network to have received this, so it keeps that connection and only falls back to the new entry once the old one is gone. **Send it before the network changes, not after.**
- **Automatically** — NVS holds up to 3 networks and `connectWiFi()` tries each in turn with a 15-second timeout. Add the venue's WiFi before you travel and the device connects to whichever it finds, with no intervention at all.

If a device is already offline on an unknown network, USB serial is the only way back — but it is the credential update above, not a rebuild.

### What the 3 slots actually do

Both paths land in the same `saveNetwork()`, which is **not** a rotating cache:

| Situation | Result |
|---|---|
| SSID already stored | Its passphrase is overwritten in place — no slot consumed |
| New SSID, fewer than 3 stored | Appended to the next free slot |
| New SSID, already 3 stored | **Slot 2 is overwritten** — always the last one |

So once three networks are stored, slot 2 is the only one that ever changes and **slots 0 and 1 can never be evicted.** That is intentional, and the reason to fill them in a specific order:

| Slot | Put this here | Why |
|---|---|---|
| 0 | Home / desk WiFi | Where the device lives and is worked on |
| 1 | Phone hotspot | The anchor — reachable anywhere there is cell signal |
| 2 | Wherever you are today | The only slot that rotates |

The hotspot in slot 1 is what makes the whole scheme work. Because the device can fall back to it almost anywhere, it can always reach AWS IoT, which means **slot 2 can be rewritten remotely from anywhere** — update the `Wi_Fi_Network__c` record in Salesforce and the change is pushed over MQTT. No USB, no rebuild, no physical access. A venue's WiFi is a throwaway; it belongs in a throwaway slot.

Two consequences to know about:

- `connectWiFi()` walks the slots in insertion order, not most-recent-first, and waits `WIFI_ATTEMPT_MS` (15s) on each. If home and hotspot are both out of range, the device spends 30 seconds on them before reaching slot 2. Predictable, and the price of keeping the anchors permanent.
- There is no delete. Freeing a slot would mean wiping the `wifi` namespace, and the only tool that does that is `erase_flash`, which takes the identity with it.

A **password change** on an already-stored network is free — it overwrites in place and consumes nothing. Only a **new SSID** takes a slot.

> Deliberate, not an oversight: an LRU or most-recent-first policy would let a venue's WiFi displace the hotspot, and the first time that happened in the field the device would be unreachable. Fixed anchors are worth the 30 seconds.

## 2. Certificates — unique per device **and** per environment

Each device gets its own X.509 keypair. `iot-dev` and `iot-prod` are separate AWS accounts with separate IoT endpoints and separate CAs, so **a Dev certificate physically cannot connect to Prod.** Moving a device between environments means re-provisioning it, which is exactly why the migration runbook treats certificate rotation as the one irreversible, batched step.

### Why certificates do not go in GitHub secrets

1. **CI cannot use them.** Flashing is manual by definition.
2. **They do not scale as secrets.** One secret per device × two environments; GitHub secrets are per-repo/environment, not per-device.
3. **A private key in a shared CI system is a shared private key.** The whole point of per-device identity is that compromising one device compromises exactly one device.

### The two provisioning paths

**Bootstrap — what you do for the first 1–3 devices (this week):**
1. AWS IoT Core → Manage → Things → Create single thing, named e.g. `ESP32-Patient-Monitor-01`
2. Auto-generate certificate; download the cert, the private key, and Amazon Root CA 1
3. Attach the least-privilege policy from [the README's one-time AWS IoT setup](../README.md#create-the-thing-and-its-certificate)
4. Put them in a bundle and send it over serial after flashing — the five steps in section 1

Yes — for the first deploy you provide WiFi and certificates by hand. That is correct and expected; it is the manual step the runbook calls out.

**Fleet Provisioning — the answer at any real scale:**
Firmware ships with a shared **claim certificate** that can do exactly one thing: call the provisioning API. On first boot the device presents the claim cert, AWS issues it a unique permanent certificate, the device stores that in NVS and never uses the claim cert again. No per-device build, no manual console work.

The repo does bootstrap today and documents Fleet Provisioning as the production path — stated honestly rather than implied.

## 3. How AWS knows which firmware goes to which device

This is the chain, and every link is doing real work:

```
Certificate  →  authenticates the connection (mTLS)
     ↓
Thing name   →  the device's address  (ESP32-Patient-Monitor-01)
     ↓
Thing Group  →  the audience          (patient-monitors, or canary-ring-1)
     ↓
IoT Job      →  the instruction       (job document: S3 URL + version)
```

1. You upload `firmware-1.2.0.bin` to S3.
2. You create an **IoT Job** targeting a **Thing** or a **Thing Group**, with a job document containing the firmware URL and version.
3. AWS pushes a notification to every targeted device on `$aws/things/{thingName}/jobs/notify-next`.
4. The device downloads, verifies, applies with `Update.h`, reboots, and reports `SUCCEEDED` or `FAILED` back on `$aws/things/{thingName}/jobs/{jobId}/update`.

**Targeting is group membership, not a device list in your code.** Put five devices in `canary-ring-1`, run the job against that group, watch, then run it against `patient-monitors`. That is the batching the migration runbook phase 4 describes.

**Dynamic Thing Groups** make this better: a device reports its running version as a Thing attribute, and you define a group like *"devices where firmware_version < 1.2.0"*. Membership updates itself, so a device that was offline during the rollout gets the update whenever it next connects — without anyone re-running anything.

### Practical gotcha

`PubSubClient`'s default MQTT buffer is 256 bytes. AWS Jobs documents are larger, so the callback silently never fires. The firmware calls `client.setBufferSize(2048)` for this reason — it is the kind of failure that looks like "AWS isn't sending anything."

## Summary

| Thing | Where it lives | Per environment? | Per device? |
|---|---|---|---|
| WiFi credentials | Device NVS, `wifi` namespace — replaceable on their own | No | No |
| Device certificate + key | AWS IoT (issued), device NVS `identity` namespace — write-once | **Yes** | **Yes** |
| Amazon Root CA | Compiled into firmware | No | No |
| AWS IoT endpoint | Device NVS, `identity` namespace | **Yes** | No |
| GitHub secrets | OIDC role ARN, Salesforce JWT key — **deploy credentials only** | Yes | No |
