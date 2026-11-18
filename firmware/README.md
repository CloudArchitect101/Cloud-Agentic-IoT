# Firmware

**One firmware for every board** (from patient-monitor 2.4.0), one shared runtime.

| Sketch | What it does | Thing Groups |
|---|---|---|
| `patient-monitor/` | Every board: DHT11 readings, the temperature alert motor at 30 C, and the queue indicator (QUEUE_DEPTH). What a board does is decided by its Asset's record type in Salesforce, not by its build | `canary-patient-monitor` and `internal-devices` inside `fleet-patient-monitor` |
| `queue-indicator/` | **Retired** at 2.2.0: kept for a board already flashed with it. A new indicator is a patient-monitor board whose Asset is an Internal Device ([below](#one-firmware-for-every-board-patient-monitor-240)) | `canary-queue-indicator` → `fleet-queue-indicator` |
| `libraries/CloudAgenticDevice/` | Shared: NVS credentials and settings, provisioning, WiFi, MQTT with backoff, OTA, live mode, commands and their answers | — |

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
#define FIRMWARE_VERSION "2.5.0"
CloudAgenticDevice device("patient-monitor", FIRMWARE_VERSION, DEFAULT_TELEMETRY_SECONDS);
```

That name travels in every OTA job document, and **the device refuses any firmware built for a different type**. Thing Group targeting should already prevent a mismatch, but a mis-targeted job must not be able to destroy hardware: queue-indicator firmware on a patient monitor means wrong pins and wrong logic, and a bricked device cannot be fixed over the air — only by USB.

This is why the build every board runs is still called `patient-monitor`, internal boards included: every board in the field (Test7, Test8) runs `patient-monitor`, and it would refuse a build under a new name. Renaming would mean a USB flash of every board. A board still on the queue-indicator build refuses the patient-monitor build for the same reason; it moves over only by USB (`scripts/firmware.sh flash patient-monitor`).

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

- **Bounds.** `seconds` 1 to 60 and `minutes` 1 to 30 (`MIN_LIVE_SECONDS`, `MAX_LIVE_SECONDS` and `MAX_LIVE_MINUTES` in `DeviceTiming.h`). `{"operation":"LIVE","minutes":0}` ends it at once. Anything else is refused, changes nothing, and the console says `live: refused` with what is allowed; a LIVE that carries a `commandId` is answered `failed` (see [Commands](#commands-what-a-board-takes-and-how-it-answers-from-220)).
- **2 seconds** is the default because faster gains nothing: asked again within 2 seconds, the DHT library returns the reading it already has. One read serves a stored reading and a live one that fall due together.
- **RAM only.** Live mode is never written to NVS, so a restart ends it.
- **A plain MQTT topic.** Live readings go through the message broker at QoS 0 rather than Basic Ingest, because the card subscribes to them and Basic Ingest reaches only rules. AWS bills them as messaging, which is why they flow only while someone watches.
- **The console** says `live: every 2 s for 15 min` for each command and `live: off` when it ends, by itself or by `minutes` 0. Live readings print nothing, and `DHT read failed` appears on stored readings only, so the console stays readable.
- **A board without a sensor**, such as an internal board, streams too: from 2.4.0 its live readings say `"sensorError":"no sensor"`. The retired queue indicator accepts the command, since the library handles it, but its sketch has no reading to send. Firmware older than 2.2.0 ignores the command.

`test/firmware/device_timing_test.cpp` checks the window on the host: the first reading at once, a second command extending the window, 0 minutes, and a window that straddles the `millis()` wrap.

## Commands: what a board takes, and how it answers (from 2.2.0)

Commands arrive on `device/<thing>/command`: from the device-command API (Device Command records in Salesforce, Wi-Fi pushes), the device-live API and the queue-depth API.

| Operation | Handled by | What the board does | Answer |
|---|---|---|---|
| `WIFI_UPDATE` | library | Stores `ssid` and `passphrase`, for when the network it is on is gone | done `stored`; failed `ssid is required` |
| `SET_TELEMETRY_INTERVAL` | library | Sets the reading interval to `seconds`, kept in NVS | done `every 60 s`; failed `seconds must be 5-86400` |
| `LIVE` | library | Opens or ends live mode (above) | done `every 2 s for 15 min` or `off`; failed `seconds must be 1-60 and minutes 1-30, or minutes 0 to stop` |
| `RESTART` | library | Restarts the board | done `restarting`, sent before it restarts |
| `DISPENSE_MEDICATION` | patient-monitor up to 2.5.0; retired in 2.6.0 | 2.6.0 does not know it: the board is a temperature alert, not a dispenser | refused `unknown operation DISPENSE_MEDICATION` |
| `CASE_ALERT` | patient-monitor 2.3.0 to 2.4.0; retired in 2.5.0 | 2.5.0 ignores it: the motor follows the board's own sensor (below) | done |
| `QUEUE_DEPTH` | patient-monitor (2.4.0), queue-indicator | `intensity` 0-100 (kept to that range) and `openCaseCount`: the servo turns while it is above 0, faster as the queue fills, and stops at 0 unless the temperature is high (below). It publishes `{"deviceId","openCaseCount","intensity"}` on `device/<thing>/status` | none: the queue-depth API sends no `commandId` |
| anything else | | Nothing | refused `unknown operation <operation>`, or `no operation` when it names none |

The device-command API checks a command against this table before it publishes it ([`lambda/shared/guardrails.js`](../lambda/shared/guardrails.js)): an operation not listed, a setting the operation does not take, or a value outside the range the board accepts is refused there with a 400, so it never reaches the board. `QUEUE_DEPTH` is not among those it sends; the queue-depth API publishes it itself.

**The answer.** A command that carries a `commandId` (1 to 40 of `A-Z a-z 0-9 _ -`; Salesforce sends the Device Command record's Id) is answered on `device/<thing>/ack`, a plain MQTT topic at QoS 0, so the MQTT test client shows answers:

```json
{"commandId":"a0Bbm00000AbCdEFGH","operation":"RESTART","outcome":"done","detail":"restarting"}
{"commandId":"a0Bbm00000AbCdEFGI","operation":"SET_TELEMETRY_INTERVAL","outcome":"failed","detail":"seconds must be 5-86400"}
```

`outcome` is `done` (carried out), `failed` (the board knows the operation but could not carry it out) or `refused` (nothing on the board knows the operation); `detail`, at most 120 characters, is there when there is more to say. Rule `cloud_agentic_iot_device_command_ack` takes each answer to Salesforce, where the record goes from Sent to Acked or Failed. A command without a `commandId` (Wi-Fi pushes, LIVE and QUEUE_DEPTH today) is carried out the same way and not answered. An invalid `commandId` is ignored and the command still carried out: the id is for the answer, not a permission.

- **A command sent twice is carried out once.** A send retried upstream after a timeout reaches the board as a second message with the same `commandId`. The board remembers the last 8 it carried out and what each came to, and answers a repeat with the outcome it remembers and detail `already carried out` instead of carrying it out again: one RESTART never restarts the board twice. The memory is RAM only and a restart clears it, which is fine: the board subscribes at QoS 0 with a clean session, so the broker never hands it an old message again after a restart.
- **RESTART** answers first, gives the answer half a second to leave, prints `command: restarting` and restarts. Live mode ends with it; the reading interval and the Wi-Fi networks are in NVS and stay.
- **The console** says `command: <operation> <outcome>` and the detail for every command, such as `command: RESTART done - restarting` or `command: LIVE done - every 2 s for 15 min`, and never the whole message: a WIFI_UPDATE carries a passphrase.
- **Older firmware** carries out what it knows and never answers, so a Device Command sent to a board older than 2.2.0 stays Sent, and RESTART does nothing there.

`test/firmware/device_commands_test.cpp` checks the `commandId` rule and the memory of recent commands on the host, and `test/firmware/contract.test.js` checks that the answer topic, the rule and the device-command APIs agree with the firmware.

## Temperature alert: the motor turns while the sensor reads 30 C or more (patient-monitor 2.5.0 to 2.7.0)

The sensor can sit wherever the temperature matters: against a patient (the demo puts the DHT11 under an arm, which reads about 33 to 36 C), in a medication fridge, in a room. The motor is the alert: it turns to tell whoever is near that the sensor reads high, and stops when it is back to normal. A monitored board decides by itself. It reads its DHT11 every 5 seconds (and at each stored reading), and its servo sweeps without stopping while a reading is 30.0 C or more, and stops once a reading is below 30.0 C. No Case, no Salesforce and no network is involved, so it reacts within seconds and works offline too.

- **The sweep** goes 0 to 180° and back once every 2 seconds (`ServoSweep.h`). The angle comes from the clock, so `loop()` never waits for the servo and MQTT keeps running.
- **No dose.** 2.6.0 removed the 90° dispense swing (`DISPENSE_MEDICATION`); the motor only ever means "temperature high" on a monitored board.
- **Only on a monitored board** (2.7.0). A board that has been sent `QUEUE_DEPTH` is an internal board, and from then on its own DHT11 no longer turns the motor; only the queue does. Salesforce sends `QUEUE_DEPTH` to internal boards only, each time one connects, so after a restart an internal board with a warm sensor can turn for the few seconds until it arrives. Changing a board's record type takes effect at its next restart. Up to 2.6.0 an internal board with a DHT11 turned for its own reading too.
- **A failed read** changes nothing; a sensor that stops answering stops the motor.
- **Exactly at the line:** the DHT11 reads in whole degrees, so a sensor sitting at 29 to 30 C can start and stop the motor from one reading to the next. That is the rule as asked; a buffer (for example stop below 29) is a one-line change in `ServoDemand.h`.
- **A continuous-rotation servo** (FS90R / SG90-360): uncomment `CONTINUOUS_ROTATION_SERVO` in the sketch. It then spins at about half speed while the temperature is high.
- **The console** says `temperature 30.0C: 30 C or more, motor turning` and `temperature 29.0C: below 30 C, motor stopped`, only when it changes.
- **`CASE_ALERT`** (2.3.0 to 2.4.0: the motor turned while the device's Case waited) is retired. The board answers it as done and ignores it, and clears the state an older version kept in NVS (namespace `caseAlert`) once at start.

`test/firmware/servo_demand_test.cpp` checks the 30 C rule and `test/firmware/servo_sweep_test.cpp` the sweep on the host.

## One firmware for every board (patient-monitor 2.4.0)

Every board runs the patient-monitor build, so one OTA reaches them all. What a board is told depends on its Asset's record type in Salesforce ([`DeviceRoles`](../force-app/main/default/classes/DeviceRoles.cls)):

| Asset record type | Its servo turns while | Readings | Thing Group when Salesforce provisions it |
|---|---|---|---|
| Monitoring Device (API name `Patient_Device`; and an Asset with no record type, every Asset made before 2.4.0) | its own DHT11 reads 30 C or more (2.5.0; up to 2.4.0 its open Case, `CASE_ALERT`) | yes: the 30 C temperature alert opens a Case | `fleet-patient-monitor` |
| Internal Device: a ward board, such as a nurse-station indicator, on the ward's Account | any open Case is owned by Care_Team_Queue, on any device or none, faster as the queue fills: `QUEUE_DEPTH` | none needed: an internal board usually has no DHT11, and if it has one, its readings open no Case and, from 2.7.0, do not turn its servo | `internal-devices`, inside `fleet-patient-monitor` |

- **The servo turns if either asks.** Since 2.7.0 only a board's own role asks (the temperature on a monitored board, the queue on an internal one), so both are on only for the seconds after an internal board restarts warm; then it sweeps at the faster of the two: the temperature sweeps once every 2 s; the queue from about 7 s a sweep at 1 Case (intensity 20, with a full-speed depth of 5) to about 1 s at full speed, as the queue-indicator firmware did. It stops only when neither asks. `ServoDemand.h` holds the rule, `ServoSweep.h` the sweep, which can change speed without the arm jumping.
- **A continuous-rotation servo** spins instead: about half speed for a case alert, and from just above standing still to full speed for the queue, the larger of the two.
- **The queue's depth is not kept in NVS.** Salesforce sends it again each time an internal board connects (`DeviceConnectionService`), and at once when an Asset's record type changes. The case alert is still kept, as in 2.3.0.
- **No sensor, no noise.** A board without a DHT11 prints `DHT read failed` for its first three readings, then `DHT11: no sensor answers, so this board sends no readings (normal on a ward board)` once, and nothing more. It keeps trying once per reading interval, silently, and says `DHT11: answering again, readings on` if a sensor is plugged in. A sensor that worked and stops says `DHT11: stopped answering` once. No reading is published without a sensor, so nothing in AWS or Salesforce reacts. Its live card shows `sensorError: "no sensor"`. `SensorPresence.h` holds the rule.
- **The console** says `queue: 2 case(s), intensity 40% -> motor turning`, `-> motor stopped`, or `-> motor turning for the case alert`, and `case alert: off, motor turning for the queue` when the queue still turns it.
- **Older firmware.** 2.3.0 does not know `QUEUE_DEPTH`: an internal board on it stays still until it takes 2.4.0 (`scripts/ota.sh try Dev patient-monitor`).

`test/firmware/servo_demand_test.cpp` checks the servo rule and the sensor rule on the host, `test/firmware/servo_sweep_test.cpp` the speed change, and `test/firmware/contract.test.js` that the queue relay and the sketch spell `QUEUE_DEPTH`, `intensity` and `openCaseCount` the same, that the build keeps the name `patient-monitor`, and that `internal-devices` sits inside `fleet-patient-monitor`.

## Lifecycle: manual once, automatic thereafter

1. **Once per device** — `./scripts/setup-device.sh`: USB flash + serial provisioning bundle. The only hands-on step in a device's life, because the ROM bootloader has no network stack and cannot fetch its own first firmware.
2. **Every update after that** is over the air. Raise `FIRMWARE_VERSION` (a pull request that changes firmware without raising it fails its checks) and merge. Merged into `Dev`, the pipeline builds, publishes, and sends it to every Dev board; merged into `Prod`, to that type's canary ring. A device that was offline during the rollout asks for pending jobs when it reconnects. To try a build over the air before merging, `scripts/ota.sh try Dev <type>` sends your working copy to every Dev board of that type as `<version>-try.<n>`, a version no release uses. The console names the image a board downloads (`OTA: downloading https://s3.<region>.amazonaws.com/<bucket>/firmware/...bin`); from 2.2.0 it leaves out the link's query string, which holds its signature and the OTA role's session token.
3. **One click per release** promotes a Prod release from canary to fleet, for that device type only.

See [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) for the whole path from your desk to Prod.

### What a board reports on an update (from 2.2.0)

A board answers its job on `$aws/things/<thing>/jobs/<jobId>/update`; `scripts/ota.sh status` and the AWS IoT console show where each board stands.

| Status | Detail | When |
|---|---|---|
| `IN_PROGRESS` | `downloading` | It has started the download. |
| `IN_PROGRESS` | `rebooting` | The build is written, and the board restarts into it. |
| `SUCCEEDED` | `running <version>` | It came back on the new build and connected: the update worked. |
| `SUCCEEDED` | `already current` | It already runs that version. |
| `FAILED` | `came back on <version>` | It restarted for the new build but came back on another version: the new build did not start and the bootloader went back to the one before, or the build calls itself a different version. The board does not download it again: a build that cannot start never puts a board in a loop. |
| `FAILED` | `http <code>`, `http begin failed`, `insufficient space`, `write incomplete`, `no url in job document` | The download or the write failed; the build it runs is untouched. |
| `REJECTED` | `wrong sketch for this device type` | The job is for another device type (see the safety check above). |
| `TIMED_OUT` | | Set by AWS when a board has not finished within the job's in-progress timeout (`inProgressTimeoutInMinutes` in `config/<env>.json`), most often because it never came back after `rebooting`. A build that starts but never connects stays on the board until it is flashed over USB. |

Until 2.2.0 a board answered SUCCEEDED `rebooting` as soon as the build was written, before anything showed that it started. Now SUCCEEDED comes from the new build itself, so a canary job's results, which promotion reads, count only the boards that came back on it. A board updating to 2.2.0 from older firmware answers the old way that once. The reading-interval job answers SUCCEEDED `telemetry every <n> s`, or REJECTED `seconds must be 5-86400`.
