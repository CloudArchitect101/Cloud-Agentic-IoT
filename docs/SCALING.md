# Scaling to a million boards

What happens to each part of the system at 1,000,000 boards sending a reading every 30 seconds, what has to change before that day, and what it costs. Every number here comes from the code in this repository, the simulation below, or the AWS page listed under [Sources](#sources), checked on 2026-11-03.

**The short answer.** The pipeline itself carries a million boards without a redesign: readings move in batches end to end, every per-environment number is configuration, and the simulation pushed three million readings through the real handlers. What stands between this repository and a million boards is AWS account quotas (a support request, [below](#aws-quotas-to-raise-first)) and Salesforce data storage (a decision, [below](#salesforce-at-a-million-boards)).

## The load

| | Per second | Per month (30 days) |
|---|---:|---:|
| Readings | 33,333 | 86.4 billion |
| Ingest batches (1,000 readings, `IngestBatchSize` in `config/Prod.json`) | 33 | 86.4 million |
| Archive objects in S3 (one per batch) | 33 | 86.4 million |
| STATE reads in DynamoDB (one per reading, 100 per request) | 33,333 | 86.4 billion |
| STATE writes (only when a board's state changes, or a reminder goes out) | about 32 | 82 million |
| Records written to Salesforce (the same changes and reminders) | about 32 | 82 million |
| Salesforce API calls (200 records each) | under 1 | about 450,000 |

## What the simulation measured

`npm run simulate` runs `lambda/patient-vitals` and `lambda/salesforce-sync`, unchanged, against stand-ins for DynamoDB, SQS, S3, Parameter Store and Salesforce that count every request. Batch sizes, the re-alert interval and whether readings are kept in DynamoDB come from `config/Prod.json`. It sends one reading from each of 1,000,000 boards three times: on first contact (an empty table), one interval later, and one re-alert interval later. 2% of boards are at risk, 1% critical, and each board changes state twice a day.

| Requests | First contact | Every 30 s | Every hour (reminders) |
|---|---:|---:|---:|
| S3 PutObject (archive) | 1,000 | 1,000 | 1,000 |
| DynamoDB BatchGetItem | 10,000 | 10,000 | 10,000 |
| DynamoDB STATE updates | 1,000,000 | 695 | 29,981 |
| SQS SendMessageBatch (sync queue) | 100,000 | 695 | 3,238 |
| Salesforce upsert calls | 5,000 | 4 | 150 |
| Salesforce records written | 1,000,000 | 695 | 29,981 |

The handler spent 16 ms of CPU per batch of 1,000 readings on average, 36 ms at the 95th percentile, including the stand-ins' bookkeeping. Compute is not what limits this system; a batch's time goes to waiting on DynamoDB and S3. `test/load/fleet-simulation.test.js` runs the same simulation on 10,000 boards with every pull request and fails if requests stop growing in step with the fleet, if an unchanged board costs more than one STATE read, or if Salesforce starts receiving routine readings.

The simulation leaves out network latency, throttling (the unit tests exercise every retry path) and IoT Core itself, which the next sections cover.

## How each stage scales

| Stage | How it works | At a million boards |
|---|---|---|
| Boards → AWS IoT | MQTT over TLS. From firmware 2.1.0, readings go through [Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html) straight to the rule, skipping the message broker. | 1,000,000 connections and 33,333 publishes a second: both above the default quotas. |
| IoT rule → telemetry queue | One SQS message per reading. Errors go to a CloudWatch log group. | SQS standard queues have no practical throughput limit. This hop is the second-largest cost; see [Kinesis](#levers-in-order-of-effect). |
| Ingest Lambda | Batches of up to 1,000 readings, 5 s batching window, at most 100 at once (`IngestMaxConcurrency`). Failures are reported per message. | About 33 batches a second; at roughly 300 ms each, about 10 run at once. |
| DynamoDB | One `BatchGetItem` per 100 boards; a board's STATE item is written only when its state changes or a reminder goes out. Prod keeps readings in S3 only (`KeepReadingsInDynamoDB: false`). | About 16,700 read units a second, under the 40,000 a table gets by default. Writes are about 32 a second. |
| S3 archive | One gzipped NDJSON object per batch, under `readings/date=/hour=`, kept `ArchiveRetentionDays` (365 in Prod). | 33 objects a second. The simulated readings compressed to 14 bytes each; real ones vary more, so budget about 50: roughly 4 TB a month. |
| Sync queue → Salesforce | Its own queue and function, at most 5 at once (`SyncMaxConcurrency`), 200 records per sObject Collections upsert, keyed on `Device_Reading_Id__c` so a retry never duplicates. | About 15,000 API calls a day, well inside an Enterprise org's daily allocation. Storage is the limit; see below. |
| Firmware and settings | AWS IoT Jobs, one job per device type, paced by `config/<env>.json` (`.ota`). | Jobs roll out at most 1,000 boards a minute: a firmware release reaches a million boards in about 17 hours. |

## AWS quotas to raise first

Raise these in Service Quotas (AWS IoT Core) in the Prod account before the fleet passes about half a million boards. Defaults are from the [AWS IoT Core quotas page](https://docs.aws.amazon.com/general/latest/gr/iot-core.html); some regions have lower defaults.

| Quota | Default | At 1,000,000 boards, 30 s | Ask for |
|---|---:|---:|---:|
| Maximum concurrent client connections per account | 500,000 | 1,000,000 | 1,200,000 |
| Inbound publish requests per second per account | 20,000 | 33,333 | 50,000 |
| Rule evaluations per second per account (Basic Ingest counts) | 20,000 | 33,333 | 50,000 |
| Connect requests per second per account | 3,000 | near 0 in steady state | 10,000 for faster recovery, see below |
| Connect requests per second per client ID | 1, fixed | | The firmware never retries sooner than 1 s |
| `CreateKeysAndCertificate`, `ListThingPrincipals` | 10 per second each | | See [provisioning](#provisioning-a-million-boards) |

The rest needs nothing: an account allows 1,000 concurrent Lambda executions by default and ingest needs about 10; DynamoDB on demand allows 40,000 read units a second per table by default and the table needs about 16,700.

## Monthly cost

US East list prices, before free tiers and discounts, for 1,000,000 boards. Check them in the AWS Pricing Calculator before quoting them to anyone.

| Line | Rate | Firmware 2.0.x (broker) | 2.1.0 (Basic Ingest, this PR) | 2.1.0 and Kinesis |
|---|---|---:|---:|---:|
| IoT connectivity | $0.08 per million connection-minutes | $3,456 | $3,456 | $3,456 |
| IoT messaging | $1.00, $0.80, then $0.70 per million (tiers at 1 and 5 billion) | $61,180 | $0 | $0 |
| IoT rules: rule triggered + action run | $0.15 + $0.15 per million | $25,920 | $25,920 | $25,920 |
| Telemetry queue | SQS: send, receive and delete, about 104 billion requests at $0.40 then $0.30 per million | $41,110 | $41,110 | |
| Telemetry stream | Kinesis provisioned: 40 shards at $0.015 an hour, PUT units at $0.014 per million | | | $1,642 |
| DynamoDB | $0.125 per million read units, $0.625 per million write units (on demand) | $5,451 | $5,451 | $5,451 |
| Lambda | 86.4 million invocations, ~300 ms at 1 GB | $450 | $450 | $450 |
| S3 | $0.005 per 1,000 PUTs, then storage | $432 + storage | $432 + storage | $432 + storage |
| **Total** | | **≈ $138,000** | **≈ $77,000** | **≈ $37,000** |
| **Per board** | | $0.138 | $0.077 | $0.037 |

Archive storage starts near $100 a month and grows by about that much each month up to the 365-day retention, about $1,200 a month on S3 Standard; an S3 lifecycle rule to Glacier Instant Retrieval cuts that by roughly 80%. Readings every 60 seconds instead of 30 halve every line except connectivity.

## Levers, in order of effect

1. **Basic Ingest** (done in this PR, firmware 2.1.0). Readings skip the broker, so AWS does not bill them as messaging: about $61,000 a month at a million boards. The device policy allows both topics, so boards on 2.0.x keep working while 2.1.0 rolls out. `test/firmware/contract.test.js` keeps the firmware's rule name, the rule and the policy in step.
2. **Kinesis Data Streams instead of SQS for telemetry** (not done). SQS bills per request and the IoT rule sends one message per reading; Kinesis bills per shard-hour and per 25 KB, which saves about $39,000 a month at this size. The cost is a design change: Kinesis retries a shard in order, so one bad reading holds up its shard until it is skipped or sent to a failure destination, where SQS retries each message on its own. Below a few hundred thousand boards the saving is smaller than the work; switch when the bill says so.
3. **The reading interval** (done: a fleet setting now). Every board keeps it in NVS, and `scripts/ota.sh interval` (the "Fleet reading interval" workflow in Prod) changes it for a whole device type with one job. 60 seconds halves the volume-based lines. Whether patients can be watched at 60 s is a clinical decision, not an engineering one.
4. **Two readings per message** (not done). The firmware could send two 30-second samples every minute in one message, halving rule and queue costs while keeping 30-second resolution, at the price of alerts arriving up to 30 seconds later.
5. **Readings out of DynamoDB in Prod** (done: `KeepReadingsInDynamoDB: false`). Writing every reading would be 33,333 write units a second, about $54,000 a month and close to the 40,000 a table gets by default. S3 keeps the full history instead.

EventBridge is deliberately not on the per-reading path: 86.4 billion events would cost about $86,000 a month at $1 per million custom events. The `event-router` function stays unwired for that reason.

## Reconnect storms

When AWS IoT or a hospital's network drops, every board loses its connection in the same second. Firmware 2.0.x retried every second. 2.1.0 waits a random time that doubles after each failure, between 1 second and 5 minutes. `test/firmware/device_timing_test.cpp` simulates a million boards through a 10-minute outage against the default 3,000 connects a second:

| | Busiest second after the first minute | Connection attempts in all | Every board back |
|---|---:|---:|---:|
| Retry every second (2.0.x) | 1,000,000 | 767 million | 333 s after AWS |
| Backoff with full jitter (2.1.0) | 21,489 | 13 million | 538 s after AWS |

Backoff takes about 3 minutes longer to bring the last board back and asks AWS for 57 times fewer connections. A connect quota of 10,000 a second would bring the last board back sooner. After an outage, each board sends one reading when it reconnects, not one for every reading it missed.

## Provisioning a million boards

The provisioning API here creates one certificate per board through `CreateKeysAndCertificate`, which AWS allows 10 times a second, and checks existing certificates with `ListThingPrincipals`, also 10 a second. That is about 10 boards a second, 28 hours of continuous calls for a million. It is the right path for re-provisioning and for batches of hundreds, and Salesforce already sends it 10 devices per call (`Devices_Per_Callout__c`).

For boards made by the hundred thousand, provision on the factory line instead: [fleet provisioning by claim](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html), where each board exchanges a shared claim certificate for its own on first connection, or just-in-time provisioning with a CA registered in AWS IoT. Either way the rest of this system is unchanged: the board still ends up with a Thing named after its serial number, the `cloud-agentic-iot-device` policy and a place in `fleet-<sketch>`.

## Salesforce at a million boards

Salesforce receives state changes and reminders, never routine readings: about 82 million records a month out of 86.4 billion readings, a thousand times fewer. The API calls that carries are no concern (about 15,000 a day). The temperature alert demo rule (CHAPTERS.md, chapter 03), when it is on, adds at most one record per hot device per re-alert interval, plus one per crossing of 30 C: 96 a day for a device kept hot in Dev, 24 in Prod, where the rule is off anyway. Its 1 C hysteresis bounds the crossings.

**Storage is the constraint.** Salesforce counts most records as 2 KB, so 82 million records a month is about 160 GB a month, against a base allocation measured in gigabytes. Three ways to handle it, which is your call:

1. **One current-state record per patient, history in Data Cloud (recommended).** Upsert on the device instead of the reading, so Salesforce holds a million records (about 2 GB) for good, and point Data Cloud at the S3 archive for history and trends. Agents and flows still see every change as it happens.
2. **A rolling window.** Keep transitions in `Patient_Vitals__c` and delete those older than, say, 30 days with a scheduled batch. Simple, but still about 160 GB at steady state.
3. **Fewer records.** A longer re-alert interval (Prod is already 60 minutes; reminders are a quarter of the volume) and hysteresis, so a reading hovering at a threshold does not flip a patient's state every 30 seconds. Worth doing either way. Only the temperature alert demo rule has hysteresis today (1 C); the clinical states do not.

First contact writes one record per board, a million records once.

## Not done yet

- Kinesis for telemetry (lever 2), when the bill justifies it.
- Hysteresis on clinical state changes, so a reading hovering at a threshold cannot create a Salesforce record every interval. (The temperature alert demo rule has its own, 1 C.)
- The Salesforce storage decision above.
- Fleet provisioning for factory-scale onboarding.
- A load test against a real account. The simulation measures this code's requests exactly, but not AWS latency or throttling; a few thousand simulated MQTT clients against Dev would.

## Sources

Checked on 2026-11-03.

- AWS IoT Core quotas: [AWS IoT Core endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html)
- AWS IoT Core prices: [AWS IoT Core pricing](https://aws.amazon.com/iot-core/pricing/); US East messaging tiers as summarised by [this calculator](https://www.factualminds.com/tools/aws-iot-core-pricing-calculator/)
- Basic Ingest: [Reducing messaging costs with Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html)
- SQS prices: [Amazon SQS pricing](https://aws.amazon.com/sqs/pricing/), tiers as summarised by [Cloudburn](https://cloudburn.io/blog/amazon-sqs-pricing)
- DynamoDB prices: [the November 2024 50% reduction for on-demand throughput](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-dynamo-db-reduces-prices-on-demand-throughput-global-tables)
- Kinesis prices: [Amazon Kinesis Data Streams pricing](https://aws.amazon.com/kinesis/data-streams/pricing/)
- Backoff: [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), AWS Architecture Blog
