# Firmware

**Two device types**, one shared runtime.

| Sketch | What it does | Thing Groups |
|---|---|---|
| `patient-monitor/` | DHT11 vitals + medication servo | `canary-patient-monitor` → `fleet-patient-monitor` |
| `queue-indicator/` | Servo driven by Salesforce Case queue depth | `canary-queue-indicator` → `fleet-queue-indicator` |
| `libraries/CloudAgenticDevice/` | Shared: NVS credentials and settings, provisioning, WiFi, MQTT with backoff, OTA, live mode | — |

## Why a shared library

Both types need identical identity, connectivity and update behaviour; only sensors and actuators differ. Duplicating that had already caused real drift — one sketch could be provisioned but not updated, the other updated but not provisioned. Now a sketch contains only what makes its device type different, and both inherit OTA for free.

## Build and flash

```bash
scripts/firmware.sh setup                     # once: ESP32 core and libraries
scripts/firmware.sh build                     # every sketch, into build/firmware/
scripts/firmware.sh flash patient-monitor     # build, then write it over USB
scripts/firmware.sh monitor                   # serial console
```

Underneath it is `arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1
--libraries firmware/libraries <sketch>`. The `--libraries` flag is required:
without it the shared header is not found. The OTA pipeline builds with the
same script, so what you flash and what the boards receive come from the same
command.

Setting up a new device? Don't run this by hand — `./scripts/setup-device.sh`
compiles, flashes, and provisions in one interactive pass. See
[`docs/DEVICE-IDENTITY.md`](../docs/DEVICE-IDENTITY.md).

## The safety check that matters

Each sketch declares its own name, which must match its folder:

```cpp
#define FIRMWARE_VERSION "2.2.0"
CloudAgenticDevice device("patient-monitor", FIRMWARE_VERSION, DEFAULT_TELEMETRY_SECONDS);
```

That name travels in every OTA job document, and **the device refuses any firmware built for a different type**. Thing Group targeting should already prevent a mismatch, but a mis-targeted job must not be able to destroy hardware: queue-indicator firmware on a patient monitor means wrong pins and wrong logic, and a bricked device cannot be fixed over the air — only by USB.

## Built for a fleet, not a desk

Three behaviours of the shared library exist for the day there are a million boards (from 2.1.0):

- **Reconnecting backs off.** When AWS or a hospital network drops, every board loses its connection in the same second. Retrying every second, as 2.0.x did, keeps a million attempts a second hitting an account that accepts 3,000 connects a second. The library now waits a random time that doubles after each failure, from 1 second up to 5 minutes, and keeps running the sketch while it waits. `test/firmware/device_timing_test.cpp` simulates a million boards through a 10-minute outage: about 13 million connection attempts instead of 767 million, and every board back about 9 minutes after AWS is.
- **The reading interval belongs to the fleet.** Each board keeps it in NVS. `scripts/ota.sh interval <env> patient-monitor [seconds]` (in Prod, the "Fleet reading interval" workflow) sets it on every board of a type with one AWS IoT job, at the rollout pace in `config/<env>.json`; boards that are offline or join later get it too. For one board or a list, send `{"operation":"SET_TELEMETRY_INTERVAL","seconds":60}` through the device command API. The board accepts 5 seconds to a day. Until set, a sketch uses its `DEFAULT_TELEMETRY_SECONDS`, and the first reading after power-up comes at a random point in the first interval so a ward of boards does not report in lockstep.
- **Readings skip the message broker.** `publishTelemetry()` publishes to `$aws/rules/cloud_agentic_iot_patient_vitals/device/<thing>/telemetry`: AWS IoT Basic Ingest hands it straight to the rule, and AWS does not bill it as messaging, the largest line of the IoT bill at fleet scale. The rule still sees `device/<thing>/telemetry`. One consequence: the MQTT test client cannot show readings any more; the serial console and the archive bucket can. `test/firmware/contract.test.js` keeps the rule name, the device policy and the firmware in step.

## Live mode: readings while someone watches (from 2.2.0)

A board stores a reading every telemetry interval whether anyone looks or not. While someone has its card open in Salesforce it also streams one every 2 seconds. Opening the card sends this command, through the device-live API, on `device/<thing>/command`:

```json
{"operation":"LIVE","seconds":2,"minutes":15}
```

From then on the board publishes a reading every `seconds` to `device/<thing>/live`, the first one at once, until `minutes` have passed since the last LIVE command. The card sends it again every 10 minutes while it stays open, so the board streams while someone watches and stops by itself within 15 minutes of the card closing. Stored readings carry on exactly as before; live ones are extra, and nothing stores them.

```json
{"deviceId":"Test7","temperature":22.5,"humidity":41,"firmware":"2.2.0","rssi":-61,"uptime":5321}
```

`rssi` is the Wi-Fi signal in dBm and `uptime` the whole seconds since the board started. When the DHT11 does not answer, the reading says so instead of going quiet, so the card can tell a board that is up but not sensing from one that is offline:

```json
{"deviceId":"Test7","sensorError":"DHT read failed","firmware":"2.2.0","rssi":-61,"uptime":5323}
```

- **Bounds.** `seconds` 1 to 60 and `minutes` 1 to 30 (`MIN_LIVE_SECONDS`, `MAX_LIVE_SECONDS` and `MAX_LIVE_MINUTES` in `DeviceTiming.h`). `{"operation":"LIVE","minutes":0}` ends it at once. Anything else is refused, changes nothing, and the console says `live: refused` with what is allowed.
- **2 seconds** is the default because faster gains nothing: asked again within 2 seconds, the DHT library returns the reading it already has. One read serves a stored reading and a live one that fall due together.
- **RAM only.** Live mode is never written to NVS, so a restart ends it.
- **A plain MQTT topic.** Live readings go through the message broker at QoS 0 rather than Basic Ingest, because the card subscribes to them and Basic Ingest reaches only rules. AWS bills them as messaging, which is why they flow only while someone watches.
- **The console** says `live: every 2 s for 15 min` for each command and `live: off` when it ends, by itself or by `minutes` 0. Live readings print nothing, and `DHT read failed` appears on stored readings only, so the console stays readable.
- **The queue indicator** accepts the command too, since the library handles it, but its sketch has no reading to send. Firmware older than 2.2.0 ignores the command.

`test/firmware/device_timing_test.cpp` checks the window on the host: the first reading at once, a second command extending the window, 0 minutes, and a window that straddles the `millis()` wrap.

## Lifecycle: manual once, automatic thereafter

1. **Once per device** — `./scripts/setup-device.sh`: USB flash + serial provisioning bundle. The only hands-on step in a device's life, because the ROM bootloader has no network stack and cannot fetch its own first firmware.
2. **Every update after that** is over the air. Raise `FIRMWARE_VERSION` (a pull request that changes firmware without raising it fails its checks) and merge. Merged into `Dev`, the pipeline builds, publishes, and sends it to every Dev board; merged into `Prod`, to that type's canary ring. A device that was offline during the rollout asks for pending jobs when it reconnects. To try a build over the air before merging, `scripts/ota.sh try Dev <type>` sends your working copy to every Dev board of that type as `<version>-try.<n>`, a version no release uses. The console names the image a board downloads (`OTA: downloading https://s3.<region>.amazonaws.com/<bucket>/firmware/...bin`); from 2.2.0 it leaves out the link's query string, which holds its signature and the OTA role's session token.
3. **One click per release** promotes a Prod release from canary to fleet, for that device type only.

See [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) for the whole path from your desk to Prod.
