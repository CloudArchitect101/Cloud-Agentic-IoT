# The chapters

**These are explanations, not install steps.** They assume the system is installed ([Quick install](INSTALL.md) or the [Install guide](INSTALL-GUIDE.md)). Each chapter demonstrates one capability, and its article and video are published separately. The code for all of them lives together in the one repository layout shown in the [README](../README.md#whats-where), because it is one system.

| # | Chapter | # | Chapter |
|---|---|---|---|
| 00 | [IoT Device Provisioning](#00--iot-device-provisioning) | 07 | [Cross-Cloud Integrations (MuleSoft)](#07--cross-cloud-integrations-ipaas--mulesoft) |
| 01 | [Data Cloud RAG Pipeline](#01--data-cloud-rag-pipeline) | 08 | [Knowledge Base RAG](#08--knowledge-base-rag) |
| 02 | [Real-time Streams to Agents](#02--real-time-streams-to-agents) | 09 | [Saga Pattern OTA](#09--event-driven-architecture-saga-pattern) |
| 03 | [Physical Case Queue Indicator](#03--physical-case-queue-indicator) | 10 | [Einstein Trust Layer: PII Masking](#10--einstein-trust-layer--pii-masking--audit) |
| 04 | [Headless Slack Integration](#04--headless-slack-integration) | 11 | [Agentforce Guardrails](#11--agentforce-guardrails) |
| 05 | [The Agent and Its Actions](#05--the-agent-and-its-actions) | 12 | [Capstone: The Complete System](#12--capstone--the-complete-system) |
| 06 | [Multi-Agent Orchestration (MCP)](#06--multi-agent-orchestration-mcp--agent2agent) | 13 | [Device Provisioning Automation](#13--device-provisioning-automation) |

Where a chapter needs something from [Stage 2 of the Install guide](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach) it says so, and where you can watch it working there is a **To see it work** line.


## 00 · IoT Device Provisioning

Provisioning a physical ESP32 monitoring device and connecting it securely to AWS IoT Core over mutual TLS, with Salesforce as the system of record for device management — including the groundwork for OTA updates managed from a Salesforce app.

A real, physical system you can walk end-to-end, not a mockup. Secure authentication and authorization between connected systems is the whole subject.

**Key files:** `firmware/patient-monitor/`, `firmware/libraries/CloudAgenticDevice/`, `force-app/main/default/objects/Asset/`

## 01 · Data Cloud RAG Pipeline

Patient IoT data flowing from edge devices through **Data Cloud** into a RAG pipeline that lets agents retrieve patient context autonomously.

The pipeline stages: telemetry arrives at IoT Core → Lambda transforms and stores in DynamoDB and the S3 archive → syncs the readings someone acts on to Salesforce via REST → Data Cloud ingests every room reading from the archive's CSV copy into the `Room_Reading` data model object, with two calculated insights per device ([DATA-CLOUD.md](DATA-CLOUD.md)) → auto-chunks the time series → Bedrock embeds each chunk → agents retrieve by semantic search. The ingestion and the insights are built; the chunking, embedding and retrieval are not yet.

**Key files:** `force-app/main/default/objects/Patient_Vitals__c/`, `Patient_Daily_Summary__c/`, `classes/DataIngestionService.cls`, `lambda/patient-vitals/`, `datacloud/`

The device registry uses the **standard Asset object** — SerialNumber is the IoT Thing name, Account is the patient's Person Account — extended with 13 custom fields: firmware, connection, provisioning and Thing identity (`objects/Asset/fields/`). A Patient Device must belong to a Person Account (`objects/Asset/validationRules/`); an Internal Device sits on a ward's business account.

## 02 · Real-time Streams to Agents

Patient vitals streaming in real time through **EventBridge** and **Platform Events** to trigger autonomous agent action within seconds.

The design: telemetry hits IoT Core → an EventBridge rule routes it to the alert dispatcher → the dispatcher evaluates vitals against clinical thresholds → publishes `Patient_Vital_Alert__e` for critical conditions → agents subscribed to the event act on it. What runs today: readings reach Salesforce through the patient-vitals stack (IoT rule → SQS → `salesforce-sync`, which upserts `Patient_Vitals__c`). The streaming stack deploys, and `VitalAlertCaseService` subscribes to `Patient_Vital_Alert__e`: a `CRITICAL_VITALS` alert opens one Case per device (Origin Vital Alert) in the care team's queue, which the ward board then turns for. No IoT rule feeds the bus: the ward boards measure room air, which never reaches a clinical band, and every reading on the bus would cost more than IoT Core itself ([SCALING.md](SCALING.md)). `scripts/streams-test.sh Dev <device>` sends one synthetic reading down the whole path ([TRY-IT.md, Fire the vitals stream](TRY-IT.md#fire-the-vitals-stream)).

**Key files:** `objects/Patient_Vital_Alert__e/`, `classes/StreamingAlertService.cls`, `classes/VitalAlertCaseService.cls` (+ tests), `lambda/streaming/`, `scripts/streams-test.sh`

## 03 · Physical Case Queue Indicator

A servo on a desk that spins while there is unclaimed work in a Salesforce Case queue and stops the moment it is empty, with speed scaling to queue depth.

It is a desk toy. It is also a complete demonstration of Salesforce driving the physical world from business data: trigger → Platform Event → async callout with SigV4 auth → API Gateway → Lambda → IoT Core → MQTT → motor. The payoff is visible from across a room.

**The design decision that matters:** nothing about *which* queue, *which* device, or *how fast* is hardcoded.

- **Which boards.** Every board runs the same firmware; the Asset's record type decides what it is for. A **Monitoring Device** (record type API name `Patient_Device`; the default, and every Asset with no record type) turns its servo while its own sensor reads 30 C or more (below). An **Internal Device**, a ward board such as a nurse-station indicator, follows the whole queue and, from firmware 2.7.0, ignores its own sensor: it turns while at least one open Case is owned by Care_Team_Queue, whichever device the Case is on, or none, and stops at 0. Making a board an indicator is a change of record type, and the board is told at once. Salesforce wants an Account or a Contact on every Asset, so an Internal Device sits on the ward's own Account.
- **Which queue.** `Internal_Device_Queue__c` on `Device_Platform_Setting__mdt.Default` (Care_Team_Queue).
- **How fast, and extra boards.** `Device_Queue_Binding__mdt`:

| Field | Purpose |
|---|---|
| `Queue_Developer_Name__c` | Which queue this binding watches |
| `Device_Id__c` | Optional: the AWS IoT Thing name of one more board that follows this queue (blank in the shipped Care_Team_Queue binding) |
| `Full_Speed_Depth__c` | Case count at which the motor runs flat out (5); also the Internal Device boards' when this is their queue |
| `Active__c` | Kill switch that does not require a deploy |

Apex normalises raw queue depth into a 0–100 intensity before it leaves Salesforce, so the firmware stays dumb and the business rules stay where an admin can change them. One `Queue_Depth_Change__e` goes out per queue; the relay sends its `QUEUE_DEPTH` to the board the binding names and to every Internal Device board that is provisioned and not offline. A board that was offline is sent the depth when it connects again. Internal Device boards get no case alert, no room-rule Case and no dose (a dose sent to one is refused).

**Hardware note:** a standard **SG90 is a positional servo** — 0–180°, physically incapable of continuous rotation. The firmware defaults to a gauge-needle sweep that gets faster as the queue deepens, which works on the SG90 you already have and reads clearly on camera. For literal continuous spin use an **FS90R or SG90-360** (~$6) and uncomment `#define CONTINUOUS_ROTATION_SERVO`. Both paths are compile-verified.

**Key files:** `objects/Asset/recordTypes/`, `classes/DeviceRoles.cls`, `objects/Device_Queue_Binding__mdt/`, `classes/CaseQueueMonitorService.cls`, `triggers/CaseTrigger.trigger`, `objects/Queue_Depth_Change__e/`, `classes/QueueDepthRelayQueueable.cls`, `lambda/queue-relay/`, `firmware/patient-monitor/` (2.4.0 and later; [firmware/README.md](../firmware/README.md#one-firmware-for-every-board-patient-monitor-240))

**To see it work:** give a board's Asset the Internal Device record type, create a Case owned by Care_Team_Queue on any device, and watch that board's motor start. Close the Case and watch it stop.

### Temperature alert demo rule

A demo rule, not a clinical one. The monitored device's DHT11 can sit wherever the temperature matters: against a patient (the demo puts it under an arm), in a medication fridge, in a room. Warm it to 30 C and the device's own motor starts turning to tell whoever is near, a Case opens by itself, and the indicator moves; once it reads below 30 C the motor stops by itself. The motor never dispenses anything. Steps in [TRY-IT.md](TRY-IT.md#warm-the-sensor-get-a-high-temperature-alert). Labels say "temperature alert" and "monitored device"; some API names (`Room_Temperature_Alert__c`, `RoomTemperatureCaseService`, `Patient_Vitals__c`, `Patient_Device`) keep their first names for now.

- **Flow.** patient-vitals → sync queue → salesforce-sync → `Patient_Vitals__c` (flagged `Room_Temperature_Alert__c`) → `PatientVitalsTrigger` → `RoomTemperatureCaseService` → a Case in Care_Team_Queue, which moves the indicator. No Device Command: the device's motor follows its own sensor.
- **AWS decides when, Salesforce decides what.** The threshold lives once, as `RoomTempAlertCelsius` in `config/<env>.json` (30, inclusive). AWS reports a device on the crossing and then at most every `RealertIntervalMinutes` while it stays high, never per reading. Salesforce never compares `Temperature__c` with 30 itself: AWS flags the reading. The clinical bands are unchanged.
- **Hysteresis.** An episode ends only when a reading drops below 29 C (1 C under the threshold), so a sensor wobbling around 30 C is one report.
- **Dedupe.** One open Case per device from this rule: a Case with Origin `Room Temperature Rule` on the device's Asset. While it is open, nothing new opens. Once it is closed, the next report opens a new one. A device without an Asset gets no Case, only a WARN log.
- **Switches.** `RoomTempAlert` in `config/<env>.json` decides whether AWS sends flagged readings at all: on in Dev, off in Prod.
- **Emergency stop.** Add `PatientVitalsTriggerHandler` to `Integration_Control__c` Bypass Handlers at org level. Instant, no deploy.
- **The motor on the board.** Since firmware 2.5.0 a monitored device sweeps its servo while its own DHT11 reads 30 C or more, and stops at the first reading below 30 C. The board decides from a reading every 5 s, with no Case, Salesforce or network, so it reacts in seconds and works offline. Cases still drive the ward boards (Internal Device, `QUEUE_DEPTH`). The earlier case alert (`CASE_ALERT`, firmware 2.3.0 to 2.4.0, `CaseAlertService`) is retired: the deploy removes the class (`manifest/destructiveChangesPost.xml`), and a board on 2.5.0 answers an old `CASE_ALERT` as done and ignores it. The dispense swing (`DISPENSE_MEDICATION`, until firmware 2.5.0) is retired too: 2.6.0 refuses it, the guardrails refuse it, and the picklist value is inactive.
- **Deploy order.** Salesforce first (the fields and the rule), then AWS, then the board: `scripts/ota.sh try Dev patient-monitor`.

**Key files:** `lambda/patient-vitals/index.js` (`planDevice`), `triggers/PatientVitalsTrigger.trigger`, `classes/RoomTemperatureCaseService.cls`, `firmware/patient-monitor/`, `customMetadata/Device_Platform_Setting.Default.md-meta.xml`

## 04 · Headless Slack Integration

A Slack slash-command bot that reads AWS and Salesforce data — `/patient-status <device-id>` — without any Slack user ever logging into Salesforce. A dedicated integration user authenticates via the JWT Bearer Flow: the same pattern as the CI/CD pipeline, but as a runtime service call rather than a deploy-time one.

**What it answers:** `/patient-status Test8` gives the live reading from AWS (or "offline since") and the last event Salesforce saved. `/dispense-medication` was retired on Nov 10 with the dispenser: the device is a temperature alert now, and a command to a board is **Send Command** on its Asset, which creates a `Device_Command__c` that an Apex trigger sends through the device API and the guardrails; the board's answer marks it `Acked` or `Failed`.

**Key files:** `lambda/slack-integration/index.js` (verifies the Slack signature — HMAC, replay-protected — answers within Slack's 3 seconds, then does the Salesforce work in an asynchronous call of itself and posts the result to the command's `response_url`), `lambda/shared/salesforce.js` (headless JWT auth), `cloudformation.yaml`

**Live versus saved:** `/patient-status` answers with two lines. The live reading comes from AWS (the newest reading in the patient-vitals table, the same one the MCP server's `get_room_status` reads, with "offline since" once it is older than five minutes). The last saved event comes from Salesforce, which keeps only the readings someone must act on: state changes and re-alerts. The live part costs one DynamoDB query, about a millionth of a dollar, and no Salesforce API call. If either side cannot be read, the other still answers and the reply says which part is missing.

**To see it work:** run `/patient-status <device-id>` from Slack with nobody logged into Salesforce.

## 05 · The Agent and Its Actions

The **actual Agentforce agent** — bot, planner, topic, registered actions — plus the Apex it invokes and the integration plumbing that lets it reach outside Salesforce. This is the centre of the system: everything else in the repo produces data for it, constrains it, or gives it somewhere to act.

**The idea worth defending:** an LLM deciding to escalate is a *suggestion*, not an authorisation. The agent chooses whether to call the action; Apex decides what is allowed to happen when it does. Validation, sharing enforcement, and the audit trail live in `PatientCareAgentActions.cls` where no prompt can talk them out of it.

Two details follow from treating agent input as untrusted:

- **Bulk-safe by default.** Agentforce may invoke an action once per record in a batch, so the method takes a `List` and does one DML — a per-invocation insert would hit the governor limit on the third patient.
- **`allOrNone=false`.** One malformed request from the agent must not fail its neighbours.

Every agent-created Case is stamped `Origin = 'Agentforce'`, so "what did the agent actually do" is a report, not an investigation, and owned by Care_Team_Queue, so it moves the queue indicator like any other care team Case.

| File | What it is |
|---|---|
| `aiAuthoringBundles/Patient_Care_Agent/Patient_Care_Agent.agent` | The **agent**, in Agent Script: an employee agent, its router, the **Device Monitoring** subagent (`Patient_Device_Monitoring`) with five instructions and three actions, Salesforce's standard escalation, off-topic and ambiguous-question subagents, and `connection slack` so it answers in Slack ([SETUP.md](SETUP.md#talk-to-the-agent-from-slack-optional)). The org compiles the planner and bot version from it |
| `genAiFunctions/Get_Device_Readings/` | The read action: a device's newest reading stored in AWS (one read-only POST /device-live), its latest saved readings and connection state, each reading with its age, from `DeviceReadingsAgentAction` |
| `genAiFunctions/Find_Procedure/` | The procedure action: the ward SOP passages that answer a question, each with the SOP ID and version to cite, from `ProcedureSearchAgentAction` ([SOP-GROUNDING.md](SOP-GROUNDING.md)) |
| `genAiFunctions/Escalate_Patient_Device_Condition/` | The escalation action: a Case for the care team, from `PatientCareAgentActions` |
| `permissionsets/Patient_Care_Agent` | Who may use the agent, and the access its actions run with |

The five instructions are the interesting part: **ground every answer** (only from the readings and procedure passages the actions return; say so when data is missing rather than estimating); **cite the ward procedure** (call Find Procedure when asked what to do, give only the steps a passage holds, cite each by SOP ID and version, and say so when no procedure covers it); **do not diagnose** (describe readings against thresholds, nothing more); **confirm before acting** (state which device and reading, then report the Case number); **be precise about device identity** (always the serial number; ask rather than guess when a patient has several).

`require_user_confirmation` is `True` on the escalation action (and `False` on the two read-only ones), so confirmation is enforced by the platform rather than requested by a prompt that can be argued with.

**Key files:** `classes/PatientCareAgentActions.cls` (+ test, including a 200-record bulk invocation), `classes/DeviceReadingsAgentAction.cls` (+ test, run as a user with and without the permission set), `classes/ProcedureSearchAgentAction.cls` (+ test, every way the callout can fail)

The read action works as the user: `with sharing` and `WITH USER_MODE`, so the agent sees only the Assets, readings and fields that person may see, and it returns no patient name.

**To see it work:** with the agent active and `Patient_Care_Agent` assigned, open the agent from the Lightning header, ask what a device (by serial number) is reporting, ask what to do about it and check the answer cites an SOP ID, then ask it to escalate, confirm when prompted, and check Cases filtered to `Origin = Agentforce`.

> **Honest caveat:** the agent was first built for the legacy builder (Bot, planner and topic metadata). That shape could not take a Slack connection, so it was upgraded in Agentforce Builder and the Agent Script the org produced is what the repo ships, byte for byte (Nov 9, API 66.0). Agents here are built only for the new builder. After changing one in Agentforce Builder, retrieve it (`sf project retrieve start -m AiAuthoringBundle:Patient_Care_Agent`) and commit the `.agent` file; the compiled planner and bot versions are the org's, not the repo's.

## 06 · Multi-Agent Orchestration (MCP + Agent2Agent)

The Smart Ward MCP server: each patient room's monitor as tools any MCP-speaking agent can discover at runtime (`get_room_status`, `list_rooms_out_of_range`, `send_device_command`), plus the A2A pattern for one agent delegating to a specialist.

**Why MCP instead of a REST API the agent calls:** an agent talking to a bespoke REST API needs the endpoint, the shape, and the "when to use it" baked into its prompt. Change the API and you re-prompt the agent. With MCP the agent calls `tools/list` at runtime and discovers what exists, including the JSON Schema for each argument. **The contract is the schema, not the prompt.** Adding a capability is a server-side change — no agent redeployment, no prompt edit.

Two consequences that show up immediately:

- **A tool `description` is prompt engineering.** The model reads it to decide when the tool applies. A vague description produces an agent that calls the wrong tool with total confidence.
- **Tool failures are returned as tool output, not transport errors.** An agent can reason about "the device is offline" and tell the user something useful. It cannot reason about an HTTP 500.

**What it may touch.** The reads come from the patient-vitals table; `send_device_command` invokes the same device-command function Salesforce's Device Commands reach, so the guardrails (chapter 11) apply to it, and the server's own role has no way to publish to a board around them. The function URL takes only SigV4-signed requests (`AWS_IAM`), so there is no unauthenticated way in.

**Verified:** `test/lambda/mcp-server.test.js` runs the protocol (`initialize` version negotiation, `tools/list`, notifications, a batch refused), every tool against a fake table, `send_device_command` through the real device-command handler over a fake AWS IoT, refusals before anything is invoked, PII masking of answers, and the template's IAM.

**Key files:** `lambda/mcp-server/index.js`, `lambda/mcp-server/cloudformation.yaml`, [docs/GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md)

**To see it work:** connect an MCP client ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#connect-an-mcp-client)) and ask which rooms are out of range. The in-org Patient Care Agent keeps using its Apex actions; Agentforce's own MCP client takes no SigV4, which that page covers.

## 07 · Cross-Cloud Integrations (iPaaS / MuleSoft)

The same AWS-to-Salesforce telemetry sync as chapter 01, implemented as a **MuleSoft flow** instead of a Lambda — DataWeave transform, JWT connection, idempotent upsert, retryable error handling.

**The tradeoff, stated plainly:** this flow does exactly what chapter 01's Lambda already does, and adds a hop and a licence. It is the right choice when an enterprise already owns MuleSoft and wants integration logic governed, monitored, and reusable in one layer instead of scattered across per-team Lambdas. It is the wrong choice for a greenfield team with neither. Having both is the point — the architecture review question is not "can you build it" but "when would you choose each," and the answer is a governance decision, not a technical one.

Two details that matter:

- **Upsert, not create.** Devices retry on reconnect, so the same reading arrives more than once. The DataWeave builds a deterministic external ID from `deviceId + timestamp`, making the write idempotent with no dedupe table.
- **Connectivity errors return 503, not 400.** If Salesforce is down and the flow returns a client error, the device concludes its payload was bad and stops retrying. Retryable failures must look retryable.

**Key files:** `mulesoft/src/main/mule/device-telemetry-sync.xml`, `mulesoft/src/main/resources/dwl/telemetry-to-salesforce.dwl`

This is the one optional piece of the system — step 8 of [Stage 2](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach). Everything works without it; deploying it swaps the ingestion path rather than adding to it.

## 08 · Knowledge Base RAG

Chunking and embedding the ward's standard operating procedures for semantic retrieval, so the Patient Care Agent answers "what do I do?" from them and cites the SOP ID — the *unstructured* half of grounding, where chapter 01 covered structured telemetry.

**The chunking strategy is the whole ballgame.** Everyone demos RAG with fixed-size chunks because it is three lines of code. Then retrieval starts mid-sentence, and in a clinical context the agent quotes half an instruction — worse than returning nothing.

This chunker splits on paragraph boundaries first, falls back to sentence boundaries, and only hard-splits when a single sentence exceeds the window. Overlap carries context across the seam so a fact spanning two chunks stays retrievable from either. **Titles are prepended to every chunk before embedding** — a chunk reading "administer 5mg every six hours" is dangerously ambiguous once separated from the article naming the drug. The title travels with the vector.

**A bug worth keeping in the write-up:** the first version handled long *paragraphs* but not long *sentences*. A 2000-character sentence — a dosage table, a long enumerated list — passed straight through and produced a chunk nearly twice the window. Nothing errored; the embedding model would have silently truncated it and dropped the tail. Found by testing the edge case rather than the happy path. Five cases now assert that no chunk ever exceeds the cap.

**Grounded and cited.** Seven short sample SOPs live in `knowledge/sops/` (a high temperature alert at 30.0 C or above, medication storage humidity, a monitor offline, an alert motor that does not follow the temperature, the case alert motor, escalation and handover, using the agent), each with an ID, version and owner role. Every AWS deploy runs `scripts/index-sops.sh`: the indexer embeds each section with Titan Text Embeddings V2 and writes one index object to S3, and does nothing when no SOP changed. The agent's **Find Procedure** action (`ProcedureSearchAgentAction`) asks the device API's `POST /find-procedure`; procedure-search masks the question, embeds it, ranks the passages by cosine in the function and masks them on the way out. The topic tells the agent to cite each passage by SOP ID and version and to say so when no procedure covers a question. For a few dozen passages one S3 object beats any vector database, and nothing runs while idle: under a cent a month. [SOP-GROUNDING.md](SOP-GROUNDING.md) has the design, the alternatives (Agentforce Data Library, Knowledge, Bedrock Knowledge Bases, S3 Vectors) and the cost.

**Key files:** `knowledge/sops/`, `lambda/shared/sop-index.js`, `lambda/knowledge-indexer/`, `lambda/procedure-search/index.js`, `scripts/index-sops.sh`, `classes/ProcedureSearchAgentAction.cls`

**To see it work:** deploy (the index is built on the way), then ask the agent what to do about a sensor reading 31 C, and check the answer cites `SOP-WARD-001 v2.0`. [SOP-GROUNDING.md, Check each step](SOP-GROUNDING.md#check-each-step) checks the index, the function and the Apex action one at a time.

## 09 · Event-Driven Architecture (Saga Pattern)

An OTA firmware rollout modelled as a **saga** — a sequence of steps spanning AWS and a physical device, each with an explicit compensating action, so a failure at step 3 unwinds steps 2 and 1 in reverse.

**Why a saga and not a transaction:** a firmware update spans an S3 upload, a Salesforce status change, an AWS IoT Job, and a device acknowledgement. There is no shared lock and no two-phase commit across that boundary. The device may simply vanish.

| Step | What it does | Compensating action |
|---|---|---|
| `stage_firmware` | Copies the published build to `firmware/saga/<board>/<run>.bin` | `delete_staged_firmware` deletes the copy |
| `mark_device_updating` | Sets the Thing's `otaState` attribute to `UPDATING` | `mark_device_active` sets it back to `ACTIVE` |
| `create_iot_job` | One IoT Job for that board, with the document `scripts/ota.sh` sends | `cancel_iot_job` cancels it |
| `await_device_ack` | Reads the job execution: `SUCCEEDED` completes, `QUEUED` or `IN_PROGRESS` waits | `rollback_device_firmware`: nothing to undo, an ESP32 boots a new image only after a verified install |

Three decisions make it work:

- **"Not ready" is not "failed."** A slow device that has not acknowledged returns `retryable`, and the orchestrator returns `IN_PROGRESS` without compensating. Conflating the two means every slow device triggers an unnecessary rollback. Verified: a device that has not acked runs **zero** compensations.
- **Steps must be idempotent.** SQS delivers at least once, so every handler will eventually run twice with identical input. The retry is routine, not exceptional — the single most common thing people get wrong with queue-driven sagas.
- **A failed compensation is logged loudly and does not stop the unwind.** Otherwise one stuck rollback strands the device in `UPDATING` forever.

A saga that is still waiting when its attempts run out (20 looks, one a minute) unwinds too, so a board is never left marked `UPDATING` by a message that went quietly to the dead-letter queue.

**Key files:** `lambda/ota-saga/` (function and template: the queue, its dead-letter queue and alarm), `scripts/ota-saga.sh`

**To see it work:** `scripts/ota-saga.sh send Dev Test8 patient-monitor <a published version>`, then `scripts/ota-saga.sh status Dev Test8` and `aws logs tail /aws/lambda/cloud-agentic-iot-ota-saga --follow` for the step trace. Turn the board off first to watch the unwind ([TRY-IT.md, Update one board through the saga](TRY-IT.md#update-one-board-through-the-saga)). Releases to the fleet still go through `scripts/ota.sh`: the saga is for one board at a time.

## 10 · Einstein Trust Layer — PII Masking & Audit

Masking personally identifiable information before text reaches an LLM, and restoring it in the response — so the user sees real values and the model never does.

**The restore half is the point.** Masking alone is easy and produces an agent that says *"Please contact [PERSON_1] at [EMAIL_1]"* — perfectly safe, completely useless. The token→original map is held in memory for the life of the request, so the response is rehydrated before the user sees it. The model is never in the loop for the real values.

Three details that matter:

- **A repeated value gets the same token.** If `a@b.com` appears twice, both become `[EMAIL_1]`. The model can still reason that these are the same person without knowing who. Issuing two tokens would break coreference and degrade the answer.
- **Only tokens actually issued get restored.** A model that hallucinates `[EMAIL_9]` gets nothing back. Blindly restoring anything token-shaped is how one patient's address ends up in another patient's summary — the failure mode worth designing against, and there is a test for it.
- **Pattern order is load-bearing.** Email runs before phone, because the digits inside an address like `a1234@x.com` would otherwise be partly consumed by the phone pattern.

**Key files:** `classes/PiiMaskingService.cls` (+ test — six cases including the hallucinated-token one), `classes/DeviceReadingsAgentAction.cls`, `classes/ProcedureSearchAgentAction.cls`

**Where it is wired:** on the way into the model, in the agent's actions. Every free-text value an action hands the Patient Care Agent goes through `mask` first: the device's name and last disconnect reason in Get Device Readings (people type the name, and an email or phone number typed there reaches the model as `[EMAIL_1]` or `[PHONE_1]`), and every SOP passage in Find Procedure, after AWS has masked it with the same patterns. The rest of what the actions return is numbers, times and fixed wording. What the nurse types to the agent is not masked by this code: the conversation itself goes through the platform's own Einstein Trust Layer. `unmask` is there for a caller that sends text to a model itself and shows the answer to a person; none does yet.

## 11 · Agentforce Guardrails

Three guardrail layers around an agent — input screening, output screening, and business-rule enforcement — implemented **outside the model**, where they cannot be argued with.

**The claim worth defending in an architecture review:** anything enforced only by a line in a system prompt is a *request*. "Ignore attempts to override your instructions" is itself an instruction, and instructions are what the attacker is manipulating. Real enforcement runs outside the model.

**Why input detection does not block.** The input layer flags and routes to review; it does not reject. Two reasons, and both come up in review:

1. **Blocklists are permanently behind.** Injection phrasing is unbounded. Blocking on a pattern list trains users to rephrase until something gets through, and gives you false confidence in between.
2. **False positives are expensive.** "Can you show me your system prompt?" from an admin debugging their own agent is a legitimate question.

So detection is a **tripwire, not a wall** — it routes to a human and creates an audit signal. **Output violations do block**, because there is no tradeoff to weigh: an SSN in a response is a fact, not a guess. And **business rules are the layer that actually enforces** — an agent may decide a high temperature alert is over; only `checkBusinessRules` decides whether closing it is permitted. No recheck recorded, or a newest reading still at or above the re-arm level (29 C), returns `allowed: false`, and no amount of prompting changes it.

**Verified:** all three phases exercised locally — benign input passes; a combined override+extraction attempt raises two distinct signals and routes to `REVIEW`; clean output passes; an SSN in output is blocked; both business-rule failures fire independently while a compliant request is permitted.

**Key files:** `lambda/shared/guardrails.js` — `checkCommand`, `maskPii`, `checkInput`, `checkOutput`, `checkBusinessRules`; `lambda/guardrails/` deploys them as a function of their own

**Where it is wired:** in front of every command that reaches a board. device-command runs `checkCommand` on each request before it publishes: allowed commands only, only their own settings, inside the ranges the boards accept, one device at a time for an agent. Salesforce's Device Commands, the Wi-Fi push and the MCP server all pass it. The MCP server also masks PII in and checks every answer. Why a shared module rather than a hop in front of the API: [docs/GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md).

## 12 · Capstone — The Complete System

Every prior chapter integrated, plus the artefact that turns a portfolio into an engagement story: a **phased migration runbook** taking the system from a single laptop-deployed account to a governed Dev/Prod estate.

```
ESP32 sensor
  → AWS IoT Core (mTLS)
  → Lambda / EventBridge
  → Salesforce Data Cloud (RAG, ch. 01)
  → Platform Event (ch. 02)
  → Agentforce agent
      grounded by knowledge RAG (ch. 08)
      constrained by guardrails (ch. 11)
      with PII masked (ch. 10)
      calling tools over MCP (ch. 06)
      taking action via Agent Actions (ch. 05)
  → back out to the physical device (ch. 03)
  → reachable from Slack without a login (ch. 04)
  → firmware updated by saga-orchestrated OTA (ch. 09)
  → integrated through MuleSoft where the enterprise requires it (ch. 07)
```

**Why the migration framing matters:** a capstone that is just "everything at once" proves you can build. The migration runbook proves you can *land* something. The detail that makes it credible is that the irreversible step — device certificate rotation — is isolated, batched, and deliberately last, and that decommissioning the old environment is a separate delayed phase rather than a same-day cleanup.

**Key files:** [`docs/MIGRATION-RUNBOOK.md`](MIGRATION-RUNBOOK.md) — the five-phase cutover, each phase with a rollback defined

**This is Stage 5 of [Deployment](INSTALL-GUIDE.md):** once the system holds together on `Dev`, promote to `Prod` and follow the runbook.

## 13 · Device Provisioning Automation

Create an Asset record in Salesforce with a Wi-Fi Network → AWS provisions the device automatically → a technician downloads one file and runs one command → the device is on the network, talking to IoT Core, and eligible for OTA. **No credentials are compiled into firmware and no private key is ever stored in Salesforce.**

**The change that makes OTA possible.** Earlier firmware compiled WiFi and certificates in via a `secrets.h`. That means **every device needs its own binary** — so there is no single image to push to a fleet, and OTA is impractical. Here nothing is compiled in. Credentials live in **NVS**, written once at provisioning. One identical binary serves every device, and NVS sits in its own partition, untouched by the `app0`/`app1` slots that `Update.h` swaps, so **an OTA update never erases a device's identity.**

**Why the private key never lands in Salesforce.** AWS returns a device private key **exactly once**, at certificate creation, and never again. Routing it through Salesforce would put a device identity into every CRM backup, data export, report and integration. So the Lambda writes the bundle straight to S3 (SSE-AES256) and returns a **15-minute pre-signed URL**. Salesforce stores the link, its expiry, and the certificate id for audit — never the key.

**The flow:**

1. Create a **Wi-Fi Network** record — SSID plus passphrase in an **Encrypted Text** field, available in every edition, no Shield needed
2. Create an **Asset**: SerialNumber = intended IoT Thing name, set the Wi-Fi Network, optionally a Thing Group (left blank: `fleet-patient-monitor` for a Monitoring Device, `internal-devices` for an Internal Device, the record type of a ward board)
3. `AssetTrigger` fires → `DeviceProvisioningService` calls AWS via a SigV4 Named Credential
4. The Lambda creates the Thing and certificate, attaches the least-privilege policy, adds it to the Thing Group, writes the bundle to S3, returns the pre-signed URL. If a step fails, it undoes the group membership it added and deletes the certificate again, so a failed attempt leaves only an empty Thing
5. The Asset updates to **Provisioned** with the link and its expiry. The link is in **Provisioning Bundle Link**, a long text field: signed with the Lambda's temporary credentials, it carries their session token and runs far past the 255 characters a URL field holds. If AWS finished but Salesforce cannot save the result, the Asset turns **Failed** with the reason and keeps the Thing ARN, so **Re-provision** issues a new link once the cause is fixed. If even that update fails, for example because the device was deleted meanwhile, only the job's debug log says so
6. The technician downloads the bundle, closes any serial monitor (only one program can hold the port), and runs `./scripts/provision-device.sh bundle.json`. The board asks for its bundle only in the two minutes after it starts, and the ESP32 holds only a few hundred bytes between the firmware's reads, so the script restarts the board, waits for it to ask, and sends the bundle in small paced pieces. A bundle sent in one burst can lose characters, and a loss inside the certificate or key would still be stored, once. If the board cannot be restarted from USB, the script asks you to press EN. The Windows script, `.\scripts\provision-device.ps1`, still sends the bundle in one burst without waiting for the board to ask, which can store a damaged identity: provision from macOS or Linux until it works the same way
7. The device stores it in NVS, reboots, connects, and subscribes to its Jobs topic. The script shows what the board says until it reports `aws: connected`
8. Delete the bundle — it contains the private key. The script prints the `rm` command once the board is online, and says to keep the bundle if it is not

**Changing a Wi-Fi password is a message, not a rebuild.** Credentials live in their own NVS namespace, so the binary and the certificate are untouched:

| Situation | What happens |
|---|---|
| Password changes while the device is **online** | Editing `Wi_Fi_Network__c` fires a trigger → `WiFiCredentialService` → per-device MQTT command → the device stores the new network **alongside** the old. No reboot, no outage |
| Deliberate update **from a terminal** (USB attached) | `./scripts/update-wifi.sh "SSID"`, which asks for the passphrase rather than leaving it in your shell history. Writes the `wifi` namespace only. Works whether the device is online or not, and needs no reboot. The script waits for the board to confirm |
| Password already changed, device **offline** | It cannot be messaged. It tries each stored network, fails, and drops into **Wi-Fi recovery mode** on serial, which updates credentials without touching identity |
| Migrating to a new access point | Add the new network while the old still works. Devices roll over on their own; the old AP can then be switched off |

The two NVS namespaces (`identity`, `wifi`) make this structural rather than careful: updating Wi-Fi is *incapable* of touching the certificate, not merely unlikely to.

**If NVS is erased: rotate the certificate, keep the device.** An erased NVS loses the private key, and AWS issues it exactly once — but that is recoverable and **no historical data is lost.** The Thing is preserved (the Thing *name* is the identity; the certificate is only how it proves that identity, so rotating one is like changing a password). Every row keyed on the device name survives — DynamoDB, `Patient_Vitals__c.Device__c`, Data Cloud, the Asset itself. Thing Group membership survives, so OTA keeps targeting it. Deleting and recreating the Thing is what would break all of this, which is why the rotation Lambda never does. Trigger it from a **Re-provision** button on the Asset: it revokes and deletes every attached certificate — so a copied key stops working — issues a new one, attaches it to the same Thing, and returns a fresh 15-minute bundle link. It refuses a device whose Thing ARN names a different Thing than its serial number, since one of the two is wrong and going ahead would replace another Thing's certificate.

**Deleting a device cleans up AWS,** so its serial number can be used again. Without this, a Thing that keeps its certificate blocks that name: provisioning refuses to give one Thing a second credential, and AWS refuses to delete a Thing that still has principals attached. Order is not optional: **detach policy → detach principal → deactivate → delete certificate → delete Thing.** A Thing that a remaining Asset's Thing ARN names, as a copy of a record's does, is never torn down. For a device that never got a Thing ARN, a remaining Asset with the same serial number keeps that Thing too: nothing stops two records sharing one, and its provisioning may be using that Thing.

| Action | Effect |
|---|---|
| Delete a device that has a Thing ARN | Certificates revoked and deleted, then the Thing its Thing ARN names (the one it was provisioned as, even if its serial number was edited since), so the name is free to reuse |
| **Telemetry history** | **Preserved.** DynamoDB rows and `Patient_Vitals__c` are keyed on the device name and are usually needed for audit long after the hardware is retired. Destroying clinical history as a side effect of deleting a CRM record would be the wrong default |
| Restore from Recycle Bin | The record returns; the AWS resources do not. The trigger clears the stale Thing ARN and certificate id and sets status to `Not Provisioned`, so the record re-provisions cleanly instead of *looking* provisioned while pointing at nothing |
| Delete a device with no Thing ARN that had a Wi-Fi Network or a status other than `Not Provisioned` | Its provisioning failed or hadn't finished, so it may have left a Thing named after its serial number. That Thing is deleted only while it has no certificate and is in no Thing Group, which is what a failed attempt leaves: provisioning adds a Thing to its group only after attaching its certificate, and takes both away again when a later step fails. Any other is kept, and the teardown function's log says why. It may be another device's, or this device's own identity that Salesforce never recorded (below) |
| Delete a device that never had a Wi-Fi Network | No callout: it never reached AWS |

**A device AWS provisioned but Salesforce never recorded** has no Thing ARN, and provisioning it again answers that its Thing already has a certificate. If that Thing is this device's, copy its ARN onto the Asset, then press **Re-provision**: it replaces the certificate, keeps the Thing and its group, and issues a new link. Setting a Thing ARN starts no provisioning.

```bash
ARN=$(aws iot describe-thing --thing-name <serial number> --query thingArn --output text)
sf data update record --sobject Asset --record-id <Asset Id> --values "Thing_ARN__c='$ARN'"
```

If the Thing is not this device's, give this device another serial number, which starts provisioning again. Remove the Thing in AWS IoT only once you have checked that no other Asset has that serial number or Thing ARN, since it may be another device's identity.

All four Asset contexts live in **one `AssetTrigger`** rather than several, so execution order is explicit rather than left to whichever trigger the platform runs first.

**Scalability, honestly stated:** this is the **one-device-at-a-time** pattern, automated. It scales to hundreds because nothing is manual except plugging in a USB cable. Beyond that, **Fleet Provisioning by claim** is the answer — firmware ships with a shared claim certificate, the device generates its own keypair and receives a unique certificate on first connect, and no key transits anything at all. Same data model, same Thing Groups, same OTA; only step 6 disappears. Documented as the next step rather than implied to be already done.

**Key files:** `objects/Wi_Fi_Network__c/`, `objects/Asset/fields/`, `classes/DeviceProvisioningService.cls`, `classes/DeviceReprovisionController.cls` and `lwc/reprovisionDevice/` (the Re-provision button), `classes/WiFiCredentialService.cls`, `triggers/AssetTrigger.trigger`, `lambda/device-provisioning/`, `lambda/device-reprovision/`, `lambda/device-teardown/`, `scripts/provision-device.sh` / `.ps1`

**To see it work:** create a Wi-Fi Network record, then an Asset with a SerialNumber, and watch the Asset flip to **Provisioned** with a bundle link. The SigV4 Named Credential it uses is step 1 of [Stage 2](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach).
