# Firmware

**Two device types**, one shared runtime.

| Sketch | What it does | Thing Groups |
|---|---|---|
| `patient-monitor/` | DHT11 vitals + medication servo | `canary-patient-monitor` → `fleet-patient-monitor` |
| `queue-indicator/` | Servo driven by Salesforce Case queue depth | `canary-queue-indicator` → `fleet-queue-indicator` |
| `libraries/CloudAgenticDevice/` | Shared: NVS credentials, provisioning, WiFi, MQTT, OTA | — |

## Why a shared library

Both types need identical identity, connectivity and update behaviour; only sensors and actuators differ. Duplicating that had already caused real drift — one sketch could be provisioned but not updated, the other updated but not provisioned. Now a sketch contains only what makes its device type different, and both inherit OTA for free.

## Build

```bash
arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 \
  --libraries firmware/libraries firmware/patient-monitor
```

The `--libraries` flag is required — without it the shared header is not found.

Setting up a new device? Don't run this by hand — `./scripts/setup-device.sh`
compiles, flashes, and provisions in one interactive pass. See
[`docs/DEVICE-IDENTITY.md`](../docs/DEVICE-IDENTITY.md).

## The safety check that matters

Each sketch declares its own name, which must match its folder:

```cpp
CloudAgenticDevice device("patient-monitor", "2.0.0");
```

That name travels in every OTA job document, and **the device refuses any firmware built for a different type**. Thing Group targeting should already prevent a mismatch, but a mis-targeted job must not be able to destroy hardware: queue-indicator firmware on a patient monitor means wrong pins and wrong logic, and a bricked device cannot be fixed over the air — only by USB.

## Lifecycle: manual once, automatic thereafter

1. **Once per device** — `./scripts/setup-device.sh`: USB flash + serial provisioning bundle. The only hands-on step in a device's life, because the ROM bootloader has no network stack and cannot fetch its own first firmware.
2. **Every update after that** is over-the-air. Bump `FIRMWARE_VERSION`, merge, and CI builds, publishes, and creates a job against that type's canary ring automatically. A device that was offline during the rollout asks for pending jobs when it reconnects.
3. **One click per release** promotes canary → fleet, for that device type only.
