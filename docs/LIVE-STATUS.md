# Live device status

Open a device's Asset in the Cloud Agentic IoT app and the **Live Status** card
at the top of the sidebar answers two questions without creating a single
record: is the board connected, and what is it reading right now. While the
card is on screen the board sends a reading every 2 seconds, straight from AWS
IoT to your browser. Salesforce never sees those readings, so watching a board
all day costs nothing in Salesforce limits and about a third of a cent an hour
in AWS.

- [What you see](#what-you-see)
- [How it works](#how-it-works)
- [Speeds](#speeds)
- [What it costs in AWS](#what-it-costs-in-aws)
- [What it costs Salesforce](#what-it-costs-salesforce)
- [Setting it up](#setting-it-up)
- [When something looks wrong](#when-something-looks-wrong)
- [Why it is built this way](#why-it-is-built-this-way)
- [Where the code is](#where-the-code-is)

## What you see

**On the Asset**, three read-only fields kept up to date from AWS IoT's own
connect and disconnect events:

| Field | Shows |
|---|---|
| Connection | `Online` or `Offline` |
| Connection Since | When the board connected or disconnected |
| Last Disconnect Reason | AWS IoT's reason for the last disconnect, such as `MQTT_KEEP_ALIVE_TIMEOUT` (the board went quiet: power or Wi-Fi lost) or `CLIENT_INITIATED_DISCONNECT` |

They change only when the board connects or disconnects, so they work whether
or not anyone has the card open, and a list view or report can filter on them.

**On the card**, while it is on screen:

- **Connection**, from the fields above, in green or red.
- **Temperature and humidity**, live. With a live reading the card also shows
  the **Wi-Fi signal** (dBm), the **firmware** version and the board's
  **uptime**, which tell you at a glance whether it restarted or updated.
- **Patient state**, when the board's readings have set one.
- A line such as *Live reading, updated 1 s ago*, and a badge: **Live, every
  2 s**, **Connecting**, or **Stored, every 5 s** when it had to fall back.

Two notices explain the cases where live readings do not arrive:

- *Waiting for the board: it may be offline, or on firmware older than 2.2.0.*
  The card is connected to AWS IoT but the board has sent nothing live.
- *Live connection unavailable; showing stored readings every 5 s.* The
  browser could not hold its live connection, so the card shows the latest
  stored reading instead (the board stores one every 30 s).

## How it works

Two independent paths: one keeps the Asset's fields current, the other streams
readings to the card only while someone is looking.

**Connection fields: AWS IoT presence events.** AWS IoT publishes an event
whenever a client connects or disconnects. One rule forwards the boards'
events to a queue, a Lambda takes them from it, and one Salesforce call
updates every Asset in the batch that changed:

```
Board connects or disconnects
  -> AWS IoT lifecycle event on $aws/events/presence/<connected|disconnected>/<thing>
  -> IoT rule cloud_agentic_iot_device_presence  (skips the cards' own live- connections)
  -> SQS: Dev hands each event on at once, Prod collects them for up to 10 s
  -> Lambda cloud-agentic-iot-device-presence
  -> Salesforce: DeviceConnectionService, one call per batch
  -> Asset: Connection, Connection Since, Last Disconnect Reason
```

Events can arrive late or twice; the Asset takes a change only when it is at
least as new as what it shows. The board's MQTT client ID is its Thing name,
and the Asset is found by its Thing ARN, exactly (Thing names are
case-sensitive).

**Live readings: straight from the board to the browser.**

```
The card becomes visible
  -> DeviceLiveController.start (one Apex callout, signed with the AWS_IoT_Relay credential)
  -> POST /device-live on the device API
       1. publishes {"operation":"LIVE","seconds":2,"minutes":15} to device/<thing>/command
       2. returns a signed WebSocket link, valid 15 minutes, that may only
          subscribe to device/<thing>/live, plus the latest stored reading
  -> the card connects to AWS IoT over MQTT on a WebSocket and subscribes
Board (firmware 2.2.0): a reading to device/<thing>/live every 2 s for 15 min,
  on top of its stored reading every 30 s
The card calls start again every 10 min while visible
Tab hidden or card closed -> the card disconnects; the board stops by itself
  when its 15 minutes run out
```

The live readings never pass through Salesforce, Lambda or a database: AWS
IoT hands each one from the board to every card subscribed to it. No rule
reads `device/+/live`, so nothing stores them. The stored readings carry on
exactly as before.

The link is a credential until it expires, so it is scoped tightly: one
client ID, subscribe and receive on one board's live topic, no publishing,
15 minutes. Nothing logs it, in the Lambda, in Apex or in the browser. The
firmware side is in [firmware/README.md, Live mode](../firmware/README.md#live-mode-readings-while-someone-watches-from-220).

## Speeds

| What | Default | Limits | Where to change it |
|---|---|---|---|
| Live reading interval | 2 s | the board takes 1 to 60 s | `LiveReadingSeconds`, `queue-relay` in `config/<env>.json` |
| How long a board stays live after the card last asked | 15 min | 1 to 30 min | `LiveMinutes`, same place |
| The card renews live mode and its link | every 10 min while visible | stays inside both 15-minute windows | `REFRESH_MS` in `deviceLiveCard.js` |
| First live reading on screen | about 2 s after the card subscribes | | |
| Stored readings | every 30 s, as before | 5 s to 24 h | `SET_TELEMETRY_INTERVAL` command |
| Fallback when the live connection fails | 3 reconnects, 2 s apart, then the stored reading every 5 s | | `deviceLiveCard.js` |
| Asset shows Online, or Offline after a clean disconnect | Dev: a second or two, one Salesforce call per event. Prod: within 10 s, up to 20 s when the queue has been quiet | | `PresenceBatchWindowSeconds` and `PresenceBatchSize`, `patient-vitals` |
| Asset shows Offline after power or Wi-Fi loss | 30 to 45 s, plus the time above | | AWS IoT closes a silent connection after 1.5 times its keep-alive, and treats the board's 15 s keep-alive as its 30 s minimum |

**Why 2 seconds and not 1.** 2 s is the fastest the DHT11 gives a new value:
the Adafruit DHT library the sketch uses hands back the previous value when it
is asked again within 2 s. At 1 s the card would show every value twice, and
the board would send twice the messages for nothing. A different sensor that
measures faster can use 1 s: set `LiveReadingSeconds` to 1.

The first reading after the card opens is usually not the one the board sends
straight away: that one leaves before the card has subscribed, and AWS IoT
keeps nothing for a late subscriber. The next one, 2 s later, arrives.

## What it costs in AWS

Prices are us-east-2 list prices. Live messages are about 150 bytes, well
inside AWS IoT's 5 KB metering unit, so each counts as one message.

| Item | Rate | Cost |
|---|---|---|
| The board's live readings | 1,800 an hour at 2 s, $1.00 per million messages | $0.0018 an hour |
| Delivery to each open card | 1,800 an hour per card | $0.0018 an hour per card |
| Starting and renewing | 6 calls an hour: API Gateway, a 256 MB Lambda, STS, two DynamoDB reads, one command | under $0.0001 an hour |
| The card's connection | $0.08 per million connection-minutes | negligible |
| **One card watching one board** | | **about $0.0036 an hour: a third of a cent** |

So a board watched for a whole working day costs about 3 cents, and watched
around the clock for a month about $2.60. Each extra card watching the same
board at the same time adds half again: the board publishes once, AWS IoT
delivers to each card. When the last card closes, the board keeps sending for
what is left of its 15 minutes, at most 450 readings, then stops.

Presence costs a rule run, a few SQS requests and at most one Lambda call per
connect or disconnect: a board that reconnects a few times a day costs well
under a cent a month. Its queue costs a little even when nothing happens:
Lambda polls it while it is empty, a few hundred thousand requests a month,
which SQS's free million requests a month usually covers. Beyond the free
tier that is under 20 cents a month.

None of this changes the stored readings, which cost what
[COST-MODEL.md](COST-MODEL.md) says: about 8 cents a month per board on Prod
settings. On Dev settings a lone board costs more, about 60 to 70 cents a
month: with a 1-second batching window (`IngestBatchWindowSeconds: 1`) each of
its readings becomes its own batch and its own S3 object, and S3 requests are
two thirds of that.

## What it costs Salesforce

| Path | Salesforce work | Counts against |
|---|---|---|
| Live readings | **None.** No API call, no record, no Apex, no storage, no platform event | nothing |
| Opening the card, and every 10 min while it stays visible | One Apex call (`DeviceLiveController.start`): one SOQL query, one callout, no DML | Per-transaction limits only (1 of 100 callouts). Callouts out of Salesforce do not count against the org's daily API requests |
| Fallback, only while the live connection is down | One Apex call (`latest`) every 5 s, one callout | Same |
| Connection fields | One REST call per batch of changes, up to 100 changes a batch (10 in Dev, where most batches hold one): one SOQL query, one update | The daily API request allocation (15,000 a day in a Developer Edition). A board that reconnects a few times a day costs a few calls a day; none while boards stay connected |
| Storage | Three fields on the Asset | No new records |

In the browser, the card handles one small message every 2 seconds and
redraws a few numbers; Salesforce's servers do nothing per reading. A hidden
tab sends nothing at all: the card disconnects and stops its timers until you
come back.

## Setting it up

The pieces ship with the rest of the project; this is what to check.

1. **Deploy Salesforce first.** It adds the three fields,
   `DeviceConnectionService`, `DeviceLiveController`, the card and the CSP
   Trusted Sites. Until `DeviceConnectionService` exists, every presence batch
   fails: AWS retries it, moves it to `cloud-agentic-iot-device-presence-dlq`
   and the `cloud-agentic-iot-device-presence-dead-letters` alarm fires.
   Deployed in the other order, redrive that queue once Salesforce is in.
2. **Deploy AWS.** The `patient-vitals` stack carries the presence rule, queue
   and Lambda. The `queue-relay` stack carries `POST /device-live`, the role
   behind the card's link, and the device policy line that lets a board
   publish to `device/<thing>/live`.
3. **Update the boards to firmware 2.2.0.** Older boards ignore the LIVE
   command, so their card waits (the connection fields work with any
   firmware). In a trial project ([TRY-IT.md](TRY-IT.md)),
   `scripts/ota.sh try Dev patient-monitor` sends the build to every board
   over the air; through the pipelines, a release does.
4. **Permissions.** People who use the card need the **Device Platform Admin**
   permission set and **External Credential Principal Access** to the
   AWS_IoT_Relay principal, the same access re-provisioning needs
   ([README, Stage 2 part d](../README.md#stage-2--connect-the-seams-ci-cannot-reach)).
   The integration user that the Lambdas sign in as needs **Device
   Integration**, which now includes `DeviceConnectionService` and edit
   access to the three fields.
5. **Region.** The card connects to `wss://<your endpoint>.iot.<region>.amazonaws.com`.
   CSP Trusted Sites for `us-east-2` and `ca-central-1` ship with the project.
   For another Region add one in Setup, Trusted URLs (formerly CSP Trusted
   Sites): URL `wss://*.iot.<region>.amazonaws.com`, context `connect-src`.

## When something looks wrong

| You see | Likely cause | Check |
|---|---|---|
| *Waiting for the board...* | The board is offline, runs firmware older than 2.2.0, or the `queue-relay` stack predates the `/live` policy line | The serial console prints `live: every 2 s for 15 min` when the card opens. If it does not, check `aws: connected, patient-monitor v2.2.0` after a restart |
| *Waiting for the board...* on a queue indicator | Expected: the queue indicator has no sensor and sends no live readings | |
| *Live connection unavailable; showing stored readings every 5 s* | The browser could not keep a WebSocket to AWS IoT: no Trusted URL for the Region, or a network that blocks it | The browser console shows a CSP error naming `wss://...iot...` |
| *Live status is unavailable. Salesforce could not reach the device API...* | No principal access to the AWS_IoT_Relay external credential, or the device API is unreachable | Re-provisioning the same Asset fails the same way |
| *...has no device-live route yet* | The `queue-relay` stack is older than this feature | Deploy it |
| *This device has no AWS IoT Thing yet* | The Asset was never provisioned | Provision it first |
| Connection says *Not reported yet* | No connect or disconnect since presence was deployed, or Salesforce did not take the change | Restart the board: it reconnects and should show Online within seconds. Otherwise search `/aws/lambda/cloud-agentic-iot-device-presence` for `No Asset changed for a Thing` (the Asset's Thing ARN does not match, often another Region or account) and look at `cloud-agentic-iot-device-presence-dlq` |
| Still Online right after unplugging the board | AWS IoT notices a silent board only when its keep-alive runs out | Wait up to a minute: 30 to 45 s for AWS IoT, plus the presence queue |

The presence Lambda logs one summary line per batch, `Connection changes sent
to Salesforce`, with how many events it dropped and why, how many Assets
changed and how many changes Salesforce skipped as older than what the Asset
shows. Rule delivery errors go to
`/cloud-agentic-iot/iot-rule-errors/device-presence`. The device-live Lambda
logs one `live view` line per request, never the link.

## Why it is built this way

The brief was to see, on the Asset, whether a board is online and what it is
sending, without creating records and without spending Salesforce limits,
CPU or memory, and to see readings as fast as the board can usefully send
them.

- **Polling Salesforce records** every second would write a record per
  reading per board and spend API calls and storage, the opposite of the
  brief.
- **Platform events or Data Cloud** would still push every reading through
  Salesforce, with their own allocations and costs, for a value nobody keeps.
- **Streaming all the time** at 2 s, card open or not, costs a few dollars a
  month per board in AWS messages for readings nobody watches. Streaming
  only while a card is open costs the same per hour but only for the hours
  someone looks.
- **The browser talks to AWS IoT directly**, with a short, narrow credential
  that Salesforce asks for once every 10 minutes. AWS IoT already does
  fan-out to many subscribers; Salesforce only decides who may watch.
- **Connection comes from AWS IoT's own events**, not from the readings: a
  board that is connected but not sensing still shows Online, and the card's
  sensor line says what is wrong.

## Where the code is

| Piece | Files |
|---|---|
| Board | `firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp` (`setLive`, `publishLive`), `DeviceTiming.h` (the limits), [firmware/README.md](../firmware/README.md#live-mode-readings-while-someone-watches-from-220) |
| Presence | `lambda/device-presence/`, the presence section of `lambda/patient-vitals/cloudformation.yaml`, `force-app/main/default/classes/DeviceConnectionService.cls` |
| Live link | `lambda/device-live/`, `LiveViewerRole` and the device policy in `lambda/queue-relay/cloudformation.yaml`, `force-app/main/default/classes/DeviceLiveController.cls` |
| Card | `force-app/main/default/lwc/deviceLiveCard/` (`mqtt.js` is a small MQTT 3.1.1 client for the browser) |
| Checks that keep them in step | `test/firmware/contract.test.js` (topics, limits, the `live-` prefix), `test/lambda/device-presence.test.js`, `test/lambda/device-live.test.js`, `test/lambda/live-viewer-role.test.js`, `test/lwc/device-live-mqtt.test.js` |
