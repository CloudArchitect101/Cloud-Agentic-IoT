# After install: use case scenarios

> [!TIP]
> Not installed yet? Follow the [Quick Install Guide](INSTALL.md) first, to the end of [step 13](INSTALL.md#step-13). This page starts where it ends. New here? [Start here](START-HERE.md).

This page is the end-to-end test of the whole system. Each step of the install guide ends with a check that only that step worked; here you use every feature the way the people it serves would, grouped by who you act as. Each scenario is one real situation: what you do (copy and paste), what you should see, and what it is worth and costs. Once all eleven give what they say, every feature works. Run them in this order: each one leaves the system ready for the next, and each one makes one short video.

**You act as:** [At the device](#at-the-device) · [Internal user in Salesforce](#internal-user-salesforce) · [Internal user in Slack](#internal-user-slack) · [Patient in the portal](#patient-portal) · [Developer](#developer) · [Business owner](#owner) · [Sysadmin](#sysadmin)

**One user for every hat.** In this example the internal user, the business owner and the sysadmin are the same Salesforce user: you, the org's admin with the System Administrator profile, holding the permission sets the install gave you. Only the patient is a different login, the test patient from [step 10](INSTALL.md#step-10). You create no new users here.

The monitored device's sensor reads the temperature of whatever it sits on: the demo puts it under an arm, but it could be a medication fridge, a server room or a shipping box. Nothing here is a clinical alert: a DHT11 is not a calibrated thermometer.

| # | You act as | Scenario | What it tests | About |
|---|---|---|---|---|
| [1](#scenario-1) | [At the device](#at-the-device) | [A monitored device runs hot and the team is alerted](#scenario-1) | The board's own motor, the temperature alert Case, the gauge's needle and bell | 5 min |
| [2](#scenario-2) | [Internal user in Salesforce](#internal-user-salesforce) | [A nurse asks the agent about a device](#scenario-2) | Agent answers from live readings, SOP search (Bedrock), a Case on request | 3 min |
| [3](#scenario-3) | [Internal user in Salesforce](#internal-user-salesforce) | [A nurse asks whether a device ran hot this week](#scenario-3) | Get Device History from Data Cloud | 3 min |
| [4](#scenario-4) | [Internal user in Salesforce](#internal-user-salesforce) | [A technician restarts a board from Salesforce](#scenario-4) | Live Status card, Send Command and its acknowledgement | 2 min |
| [5](#scenario-5) | [Internal user in Salesforce](#internal-user-salesforce) | [A technician asks a hardware question](#scenario-5) | Espressif MCP servers in the agents | 1 min |
| [6](#scenario-6) | [Internal user in Slack](#internal-user-slack) | [The team asks from Slack](#scenario-6) | `/patient-status` and the agent in Slack | 2 min |
| [7](#scenario-7) | [Patient in the portal](#patient-portal) | [A patient checks their own device in the portal](#scenario-7) | Enhanced Chat, the portal agent, a nurse request | 3 min |
| [8](#scenario-8) | [Developer](#developer) | [A new firmware build reaches the boards over the air](#scenario-8) | OTA to every board, then the saga to one, and its rollback | 5 min |
| [9](#scenario-9) | [Developer](#developer) | [A wearable reports critical readings](#scenario-9) | The event stream: EventBridge to Platform Events to a Case | 2 min |
| [10](#scenario-10) | [Business owner](#owner) | [The business owner reads what it is worth and what it costs](#scenario-10) | The Home spend card, org limits, the Business Value dashboard, the Data Cloud value card | 3 min |
| [11](#scenario-11) | [Sysadmin](#sysadmin) | [A device goes quiet and the sysadmin finds out why](#scenario-11) | Offline status, the silence insight, alarms, logs, firmware and deployed versions | 4 min |

<a id="before-you-start"></a>

## Before you start

**Paste into your terminal.** In every new terminal, before any block below (the same [resume lines](INSTALL.md#resume) as the Quick Install Guide).

```bash
NAME='test-cloud-agentic-iot'
cd ~/Cloud-Agentic-IoT        # or wherever you cloned it
export AWS_PROFILE="$NAME" SF_TARGET_ORG="$NAME"
```

> [!TIP]
> **Ready when** both Assets, `PatientExternalESP32` (the monitored device) and `CompanyInternalESP32` (the corp ticket gauge), show Connection `Online` in the Cloud Agentic IoT app, and both boards run firmware `1.0.0`. Scenario 3 also needs a day of readings in Data Cloud ([step 12c](INSTALL.md#step-12c)).

**For a recording**, shorten the wait between repeat alerts while you film: set `"RealertIntervalMinutes": 2` in `config/Dev.json`, run `scripts/deploy-aws.sh Dev`, and set it back to `15` afterwards. A monitored device on a desk reads as stable, so it gets no other reminders.

<a id="at-the-device"></a>

## At the device

Anyone near the monitored device or the corp ticket gauge.

<a id="scenario-1"></a>
<a id="warm-the-sensor-get-a-high-temperature-alert"></a>

### 1. A monitored device runs hot and the team is alerted

**Situation.** Whatever the device measures gets warm: a patient's arm, a fridge whose door was left open. The people near the device and the care team both need to know, without anyone watching a screen.

**Do.**

1. Put the DHT11 under your arm (about 33 to 36 C there), or cup your hand around it, until it reads 30 C or more.
2. Keep it warm for a minute.
3. Take it out and let it cool below 30 C (a minute or two from body heat).
4. Close the Case in Care_Team_Queue.

**See.**

1. Within about 5 s the monitored device's own servo starts sweeping. The board decides this itself, so it works even with the network down. Its console prints `temperature 30.0C: 30 C or more, motor turning`.
2. Within 1 to 3 stored readings (about 30 s each) a Case `High temperature ... C on PatientExternalESP32` opens in Care_Team_Queue, and the corp ticket gauge sweeps its needle and rings its bell. While the sensor stays warm no second Case opens: Salesforce sees the open one.
3. The device's sweep stops within about 5 s of the first reading below 30 C. The Case stays open, and the gauge keeps ringing until someone closes the Case or takes it from the queue.
4. The gauge stops (when that was the queue's last Case). Warm the sensor again: the device sweeps at once, and a new Case opens once a reading went below 29 C in between.

**Check it.** The Cases the rule opened:

**Paste into your terminal.**

```bash
sf data query --target-org "$NAME" \
  --query "SELECT CaseNumber, Owner.Name, Asset.SerialNumber, Status, CreatedDate FROM Case WHERE Origin = 'Room Temperature Rule' ORDER BY CreatedDate DESC LIMIT 5"
```

**Emergency stop.** Setup → **Custom Settings** → **Integration Control**, at org level: add `PatientVitalsTriggerHandler` to **Bypass Handlers**. No more Cases open, at once, with no deploy. The device's own sweep follows only its sensor: cool the sensor, or unplug the servo.

**Value and cost.** The measured KPI is minutes from a high reading to someone acting on it: as is, a reading checked by hand every two hours goes unnoticed for about an hour on average; here the device signals in seconds and the Case opens in under two minutes. The [Business Value dashboard](BUSINESS-VALUE.md) tracks it. AWS costs about $0.08 per device per month for every reading ([COST-MODEL.md](COST-MODEL.md)), and only flagged readings reach Salesforce, so the org's daily API limit is not touched by normal readings.

When it doesn't behave: [Troubleshooting](TROUBLESHOOTING.md#install-steps). Why the rule works this way: [Chapters, chapter 03](CHAPTERS.md#temperature-alert-demo-rule).

<a id="internal-user-salesforce"></a>

## Internal user in Salesforce

A nurse or technician in the Cloud Agentic IoT app and the Patient Care Agent.

<a id="scenario-2"></a>
<a id="talk-to-the-agent"></a>

### 2. A nurse asks the agent about a device

**Situation.** A nurse wants to know what a monitored device reports, and what the ward's procedure says to do, without opening any records.

**Do.** Open the **Patient Care Agent** from the Lightning header (the install published it and gave you `Patient_Care_Agent`). Ask, one at a time:

1. "What is PatientExternalESP32 reporting?"
2. "What should I do if a device reads above 30 C?"
3. "Escalate the latest reading for PatientExternalESP32." Then confirm.

**See.**

1. The latest temperature and humidity, and whether the device is online.
2. The ward procedure's steps, with the SOP it comes from (SOP-WARD-001, say), from the Bedrock SOP index.
3. The agent names the device and reading and asks you to confirm. After you confirm, it gives a Case number. The Case (Origin `Agentforce`) is in Care_Team_Queue, and the corp ticket gauge sweeps and rings for it.

Close that Case afterwards, so the gauge stops.

**Value and cost.** Each answer replaces a walk to the device or a search through binders. Each agent action is 20 Flex Credits, about $0.10 ([COST-MODEL.md](COST-MODEL.md)); the Bedrock SOP lookup adds a fraction of a cent.

<a id="scenario-3"></a>

### 3. A nurse asks whether a device ran hot this week

**Situation.** A device is hot today. Is that a one-off, or has it been running hot all week? The answer decides between escalating now and rechecking the device first.

**Do.** In the Patient Care Agent, ask:

1. "Has PatientExternalESP32 been running hot this week, or is today a one-off?"
2. "How long was PatientExternalESP32 at or above 30 C yesterday?"
3. "When did CompanyInternalESP32 last send anything?"

**See.**

1. Days and minutes at or above 30.0 C this week, and the highest reading, with a note that the numbers come from Data Cloud.
2. Yesterday's minutes at or above 30 C, with a note that the newest hour or two may be missing (Data Cloud takes in the archive in batches).
3. When the corp ticket gauge last reported, so a silent device reads as a device fault, not a quiet patient.

The agent quotes the numbers the **Get Device History** action returns; it never adds readings up itself. You need the standard **Data Cloud User** permission set, because the action queries Data Cloud as you ([DATA-CLOUD.md](DATA-CLOUD.md#how-the-agent-reads-it)). How the readings get there: [SETUP.md §7](SETUP.md#7-data-cloud-room-readings-for-the-ward).

**Value and cost.** It turns a week of readings (2,880 a device a day) into the one line that goes into a shift handover. The cost follows questions, not devices: one agent action, about $0.10, plus Data Cloud query credits. Two nurses asking 5 a day is about $22 a month ([COST-MODEL.md §9](COST-MODEL.md#9-device-history-for-the-staff-agent-get-device-history)).

<a id="scenario-4"></a>

### 4. A technician restarts a board from Salesforce

**Situation.** A device looks stuck. A technician checks it live and restarts it, without going to it.

**Do.**

1. Open the `PatientExternalESP32` Asset in the Cloud Agentic IoT app and watch its **Live Status** card.
2. Choose **Send Command** → `RESTART`.

**See.**

1. Connection `Online` and a new reading every 2 s while the card is on screen, straight from AWS IoT to your browser. Readings never pass through Salesforce.
2. The Device Command shows `Sent` within seconds, then `Acked` once the board answers. The card shows the board offline for a few seconds and back. A board that is offline is sent nothing, and the command shows `Failed` with the reason ([DATA-MODEL.md](DATA-MODEL.md#device-command-lifecycle)).

**Value and cost.** No site visit for a restart. An hour of watching the card costs about a third of a cent in AWS ([LIVE-STATUS.md](LIVE-STATUS.md)); a command is a few API calls.

<a id="scenario-5"></a>

### 5. A technician asks a hardware question

**Situation.** A technician needs a fact about the hardware, for example to choose a replacement board.

**Do.** Ask any agent: "What is the spec of the ESP32-S3-DevKitC-1?"

**See.** An answer from Espressif's catalogs, with a docs.espressif.com link for the rest ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#espressif-mcp-servers-for-the-agents)).

**Value and cost.** No one leaves the conversation to search. Espressif's MCP servers are free and need no sign-in; each question is one or two agent actions, $0.10 to $0.20 ([COST-MODEL.md §8](COST-MODEL.md#8-espressif-mcp-servers-for-the-agents)).

<a id="internal-user-slack"></a>

## Internal user in Slack

Anyone on the team, from the Slack workspace.

<a id="scenario-6"></a>
<a id="ask-the-ward-from-slack"></a>

### 6. The team asks from Slack

**Situation.** Someone on the team is in Slack, not Salesforce, and wants a device's status.

**Do.** In any channel of your workspace (set up in [step 8](INSTALL.md#step-8)):

1. `/patient-status PatientExternalESP32`
2. DM the Patient Care Agent: "What is PatientExternalESP32 reading?"

**See.**

1. Only you see the answer: first "Looking up `PatientExternalESP32`…", then the live reading from AWS (or "offline since" when the board has not sent for five minutes) and the last event Salesforce saved, which can be hours older, because Salesforce keeps only state changes and alerts.
2. The agent answers as it does in Salesforce, as your Salesforce user.

Slack sends no commands to a board: that is [scenario 4](#scenario-4). If Slack says `dispatch_failed`: [Troubleshooting, Slack](TROUBLESHOOTING.md#slack).

**Value and cost.** The answer goes where the team already works. Each `/patient-status` is well under a thousandth of a cent in AWS and one Salesforce API call; the free Slack plan is enough.

<a id="patient-portal"></a>

## Patient in the portal

The test patient, signed in to the patient portal.

<a id="scenario-7"></a>

### 7. A patient checks their own device in the portal

**Situation.** A patient wants to know what their device reads, and to call a nurse, from home.

**Do.** Open the portal site and sign in as the test patient from [step 10](INSTALL.md#step-10). Open the chat and ask:

1. "What is my temperature?"
2. "I need a nurse."

**See.**

1. The **My monitor** page shows the patient's own device only, and the assistant answers from that device's newest reading.
2. A Case opens in Care_Team_Queue, and the gauge rings for it.

The portal agent sees only the signed-in patient's own device, and uses Salesforce's built-in model ([PATIENT-PORTAL.md](PATIENT-PORTAL.md)).

**Value and cost.** The KPI is chats the agent handled without a nurse, each one a nurse visit that did not happen ([BUSINESS-VALUE.md](BUSINESS-VALUE.md)). A portal member is about $10 a month, and each agent action about $0.10 ([COST-MODEL.md §7](COST-MODEL.md#7-patient-portal-react-site-enhanced-chat-and-agentforce-voice)).

<a id="developer"></a>

## Developer

Whoever changes the firmware or adds a new kind of device, from the terminal.

<a id="scenario-8"></a>
<a id="update-one-board-through-the-saga"></a>

### 8. A new firmware build reaches the boards over the air

**Situation.** A developer changes the firmware. Every board must get it without a USB cable, and a failed update must undo itself.

**Do.** First the build from your working copy to every board, then one board through the saga, which undoes each step if a later one fails.

**Paste into your terminal.**

```bash
scripts/ota.sh try Dev patient-monitor
scripts/ota.sh status Dev
```

Then, with the version `status` printed (for example `1.0.0-try.1`):

```bash
scripts/ota-saga.sh send Dev PatientExternalESP32 patient-monitor 1.0.0-try.1
scripts/ota-saga.sh status Dev PatientExternalESP32
```

**See.**

1. `ota.sh try` compiles your working copy as `1.0.0-try.<n>`, uploads it, and prints each board's answer as it comes: SUCCEEDED `running 1.0.0-try.<n>` once the board has restarted into it and reconnected, or FAILED `came back on <version>` if the new build did not start. The serial console shows `OTA: complete, restarting`, then `aws: connected, patient-monitor v1.0.0-try.<n>`. Each board keeps its Wi-Fi and certificate.
2. The saga's `status` shows the Thing's `otaState` `UPDATING` while it runs, then `ACTIVE` with `otaVersion`. A board already on that version reports it as current. The trace: `aws logs tail /aws/lambda/cloud-agentic-iot-ota-saga --follow`.

**To watch it undo itself**, unplug the board and send the saga again: the job stays `QUEUED`, and after 20 minutes the log shows `cancel_iot_job`, `mark_device_active` and `delete_staged_firmware`, in that order, and the board stays `ACTIVE` on its old version.

**Value and cost.** The KPI is boards on the current version: every update after the first USB flash arrives over the air. A try costs one upload and one job execution per board, a fraction of a cent.

<a id="scenario-9"></a>
<a id="fire-the-vitals-stream"></a>

### 9. A wearable reports critical readings

**Situation.** A wearable that sends heart rate and oxygen saturation reports a critical combination. The boards here send only temperature and humidity, so this sends one synthetic reading down the same event stream a wearable would use (chapter 02: EventBridge to Salesforce Platform Events).

**Do.**

**Paste into your terminal.**

```bash
scripts/streams-test.sh Dev PatientExternalESP32
```

**See.** The script prints what the alert dispatcher in AWS decided: `CRITICAL_VITALS`. Within a few seconds a Case `Critical vitals on PatientExternalESP32`, Origin **Vital Alert**, opens in Care_Team_Queue on the device's Asset, and the gauge rings for it. Run it again while that Case is open: no second Case. `scripts/streams-test.sh Dev PatientExternalESP32 warning` publishes an `ABNORMAL_TREND` alert that opens nothing, and `normal` is dropped in AWS. Nothing is written to the device's readings, no board is contacted, and the AWS logs label the reading `SYNTHETIC_TEST`.

Close the Case afterwards, so the gauge stops.

**Value and cost.** Any new kind of device joins by publishing to the same stream: no new integration. A reading through the stream costs a few millionths of a dollar in AWS.

<a id="owner"></a>

## Business owner

Whoever pays for the platform and answers for its value, reading the dashboards on the app's Home tab.

<a id="scenario-10"></a>
<a id="see-what-it-costs"></a>

### 10. The business owner reads what it is worth and what it costs

**Situation.** The owner wants to know what the platform costs this month, how close it is to its limits, and whether it pays for itself.

**Do.** The value dashboard needs one setup the install doesn't do: a permission set and a nightly snapshot.

**Paste into your terminal.** Once per org. It schedules the nightly snapshot (01:00) and takes the first one now.

```bash
sf org assign permset --name Business_Value_Viewer --target-org "$NAME"
sf apex run --target-org "$NAME" <<'APEX'
System.schedule('Business Value snapshot', '0 0 1 * * ?', new ValueSnapshotJob());
ValueSnapshotService.takeSnapshot();
APEX
```

Then open the Cloud Agentic IoT app's **Home** tab and reload it.

**See.**

1. **Costs and limits**: this month's AWS spend against the project's spend limit, read from the `cloud-agentic-iot-monthly` budget you made in [step 6](INSTALL.md#step-6), and the org's limits by group (API calls, storage).
2. **Business Value** dashboard (also under Dashboards → Business Value): net value over the last 7 days (staff time value minus Agentforce and AWS cost), chats the agent handled, response time before and after, AWS per device per month, and hours avoided ([BUSINESS-VALUE.md](BUSINESS-VALUE.md)).
3. **Data Cloud value: monitored devices**: minutes at or above 30 C and the highest temperature over 7 days, how many devices report and which went silent, and the return on Data Cloud: manual checks replaced against Data Cloud's cost ([BUSINESS-VALUE.md, Data Cloud value card](BUSINESS-VALUE.md#data-cloud-value-card)).

The value side uses the stated as-is numbers shipped with the org (3 minutes a manual check, 12 checks a device a day, $55 a staff hour); change them to your own in Setup → Custom Metadata Types → **Value Assumption** → **Default**, so the dashboard compares measured against your baseline ([Before and after](BUSINESS-VALUE.md#before-and-after-as-is--to-be)).

Near the spend limit, AWS stops new Lambda runs and then pauses the project; the spend card then says so and shows the last spend it read, and its Salesforce half keeps working ([Detailed Install Guide, near the limit](INSTALL-GUIDE.md#near-the-limit)).

**Value and cost.** The one number to say out loud is net value a week. The cost is driven by how often agents act, not by data or infrastructure: AWS is about $0.08 per device per month ([COST-MODEL.md](COST-MODEL.md)). Reading the budget is free, the spend card costs under a cent a month ([SPEND-AND-LIMITS.md](SPEND-AND-LIMITS.md)), and the Data Cloud card reads its insights at most once every 10 minutes per session, to save credits.

<a id="sysadmin"></a>

## Sysadmin

Whoever keeps it running and finds out why something behaves oddly, in the app and the terminal.

<a id="scenario-11"></a>

### 11. A device goes quiet and the sysadmin finds out why

**Situation.** A device stops reporting. Is it the device, its Wi-Fi, AWS or Salesforce? The sysadmin works outward from the device to the first hop that went quiet.

**Do.**

1. Unplug the corp ticket gauge (`CompanyInternalESP32`) and watch its Asset.
2. Ask the Patient Care Agent: "When did CompanyInternalESP32 last send anything?"
3. In the terminal, check the alarms, the presence log, the boards' firmware and what is deployed.
4. Plug the gauge back in.

**Paste into your terminal.** Any time something looks wrong.

```bash
aws cloudwatch describe-alarms --alarm-name-prefix cloud-agentic-iot   --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
aws logs tail /aws/lambda/cloud-agentic-iot-device-presence --since 15m
scripts/ota.sh status Dev
aws ssm get-parameters --names /cloud-agentic-iot/deployed-commit/aws /cloud-agentic-iot/deployed-commit/salesforce \
  --query 'Parameters[].[Name,Value]' --output text
```

**See.**

1. The Asset's Connection turns `Offline` within about 30 to 45 s of losing power (AWS IoT closes a silent connection after 1.5 times its keep-alive), and the Live Status card says it waits for the board ([LIVE-STATUS.md](LIVE-STATUS.md)).
2. The agent gives the time of the last reading from Data Cloud's silence insight, which updates hourly: a device that is silent for longer reads as a device fault, not a quiet patient.
3. Every alarm `OK` (a dead-letter queue that is filling, or `telemetry-falling-behind`, points at the hop that fails); the presence log shows the disconnect for `CompanyInternalESP32`; `ota.sh status` lists each board's firmware and any job still waiting; the last lines name the commits AWS and Salesforce run.
4. Connection `Online` again within a few seconds, and readings on the card.

Each symptom found while building this, with its cause and fix: [Troubleshooting](TROUBLESHOOTING.md). The hop-by-hop checklist: [Detailed Install Guide, step 13](INSTALL-GUIDE.md#step-13).

**Value and cost.** The KPI is coverage: a silent device is a gap in monitoring, and here it shows within a minute instead of at the next manual round. Reading alarms and logs costs nothing extra; the alarms email whoever `ALARM_EMAIL` named.

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
