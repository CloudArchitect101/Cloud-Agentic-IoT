# Firmware

**Two device types**, one shared runtime.

| Sketch | What it does | Thing Groups |
|---|---|---|
| `patient-monitor/` | DHT11 vitals + medication servo | `canary-patient-monitor` → `fleet-patient-monitor` |
| `queue-indicator/` | Servo driven by Salesforce Case queue depth | `canary-queue-indicator` → `fleet-queue-indicator` |
| `libraries/CloudAgenticDevice/` | Shared: NVS credentials and settings, provisioning, WiFi, MQTT with backoff, OTA | — |

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
#define FIRMWARE_VERSION "2.1.0"
CloudAgenticDevice device("patient-monitor", FIRMWARE_VERSION, DEFAULT_TELEMETRY_SECONDS);
```

That name travels in every OTA job document, and **the device refuses any firmware built for a different type**. Thing Group targeting should already prevent a mismatch, but a mis-targeted job must not be able to destroy hardware: queue-indicator firmware on a patient monitor means wrong pins and wrong logic, and a bricked device cannot be fixed over the air — only by USB.

## Built for a fleet, not a desk

Three behaviours of the shared library exist for the day there are a million boards (from 2.1.0):

- **Reconnecting backs off.** When AWS or a hospital network drops, every board loses its connection in the same second. Retrying every second, as 2.0.x did, keeps a million attempts a second hitting an account that accepts 3,000 connects a second. The library now waits a random time that doubles after each failure, from 1 second up to 5 minutes, and keeps running the sketch while it waits. `test/firmware/device_timing_test.cpp` simulates a million boards through a 10-minute outage: about 13 million connection attempts instead of 767 million, and every board back about 9 minutes after AWS is.
- **The reading interval belongs to the fleet.** Each board keeps it in NVS. `scripts/ota.sh interval <env> patient-monitor [seconds]` (in Prod, the "Fleet reading interval" workflow) sets it on every board of a type with one AWS IoT job, at the rollout pace in `config/<env>.json`; boards that are offline or join later get it too. For one board or a list, send `{"operation":"SET_TELEMETRY_INTERVAL","seconds":60}` through the device command API. The board accepts 5 seconds to a day. Until set, a sketch uses its `DEFAULT_TELEMETRY_SECONDS`, and the first reading after power-up comes at a random point in the first interval so a ward of boards does not report in lockstep.
- **Readings skip the message broker.** `publishTelemetry()` publishes to `$aws/rules/cloud_agentic_iot_patient_vitals/device/<thing>/telemetry`: AWS IoT Basic Ingest hands it straight to the rule, and AWS does not bill it as messaging, the largest line of the IoT bill at fleet scale. The rule still sees `device/<thing>/telemetry`. One consequence: the MQTT test client cannot show readings any more; the serial console and the archive bucket can. `test/firmware/contract.test.js` keeps the rule name, the device policy and the firmware in step.

## Lifecycle: manual once, automatic thereafter

1. **Once per device** — `./scripts/setup-device.sh`: USB flash + serial provisioning bundle. The only hands-on step in a device's life, because the ROM bootloader has no network stack and cannot fetch its own first firmware.
2. **Every update after that** is over the air. Raise `FIRMWARE_VERSION` (a pull request that changes firmware without raising it fails its checks) and merge. Merged into `Dev`, the pipeline builds, publishes, and sends it to every Dev board; merged into `Prod`, to that type's canary ring. A device that was offline during the rollout asks for pending jobs when it reconnects. To try a build over the air before merging, `scripts/ota.sh try Dev <type>` sends your working copy to every Dev board of that type as `<version>-try.<n>`, a version no release uses.
3. **One click per release** promotes a Prod release from canary to fleet, for that device type only.

See [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) for the whole path from your desk to Prod.
