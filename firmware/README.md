# Firmware

**Two device types**, one shared runtime.

| Sketch | What it does | Thing Groups |
|---|---|---|
| `patient-monitor/` | DHT11 vitals + medication servo | `canary-patient-monitor` → `fleet-patient-monitor` |
| `queue-indicator/` | Servo driven by Salesforce Case queue depth | `canary-queue-indicator` → `fleet-queue-indicator` |
| `libraries/CloudAgenticDevice/` | Shared: NVS credentials, provisioning, WiFi, MQTT, OTA | — |

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
#define FIRMWARE_VERSION "2.0.1"
CloudAgenticDevice device("patient-monitor", FIRMWARE_VERSION);
```

That name travels in every OTA job document, and **the device refuses any firmware built for a different type**. Thing Group targeting should already prevent a mismatch, but a mis-targeted job must not be able to destroy hardware: queue-indicator firmware on a patient monitor means wrong pins and wrong logic, and a bricked device cannot be fixed over the air — only by USB.

## Lifecycle: manual once, automatic thereafter

1. **Once per device** — `./scripts/setup-device.sh`: USB flash + serial provisioning bundle. The only hands-on step in a device's life, because the ROM bootloader has no network stack and cannot fetch its own first firmware.
2. **Every update after that** is over the air. Raise `FIRMWARE_VERSION` (a pull request that changes firmware without raising it fails its checks) and merge. Merged into `Dev`, the pipeline builds, publishes, and sends it to every Dev board; merged into `Prod`, to that type's canary ring. A device that was offline during the rollout asks for pending jobs when it reconnects.
3. **One click per release** promotes a Prod release from canary to fleet, for that device type only.

See [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) for the whole path from your desk to Prod.
