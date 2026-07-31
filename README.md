# Cloud-Agentic-IoT

> A healthcare IoT + Agentforce system, built from scratch and in public: physical device provisioning (ESP32) and OTA updates, through Data Cloud RAG, real-time event streams, multi-agent orchestration, and cross-cloud integrations — with real Dev and Prod AWS/Salesforce environments, not a slide deck.

## Why this repo exists

Built from scratch and in public — no environment, no accounts, no hardware wired up at the start — with every step documented so anyone can clone this repo and replicate the whole thing on their own machine. It is one system applied to a healthcare patient-monitoring scenario, presented as fourteen chapters that each demonstrate one capability.

**Everything lives on one branch: `Dev`. Clone `Dev` and you have the entire system — all the Salesforce metadata, every Lambda, both firmware sketches, and the prose for each chapter. `Prod` exists only as the promotion target for verified work.

## Start here

1. **Clone:** `git clone https://github.com/<username>/Cloud-Agentic-IoT.git`
2. **Work through [`docs/SETUP.md`](docs/SETUP.md)** — CLI installs (`sf`, `aws`, `gh`, `arduino-cli`), then accounts, identities, and credentials. Everything below assumes it is done.
3. **Read [How the pieces connect](docs/HOW-IT-CONNECTS.md)** for the shape of the system before you stand it up.
4. **Deploy the whole system once** — [Deployment](#deployment) below. It is one sequence, not fourteen.
5. **Read [The chapters](#the-chapters)** to understand what you just deployed and why each piece is built the way it is.

> **Chapters are a reading order, not a deployment order.** There is no per-chapter install. The system deploys as a single unit — one push stands up every Lambda, every Apex class, the agent, and the events together — because that is what it is: one system. The chapters exist to explain it, in an order that makes narrative sense, and each has its own article and video. Nothing in `content/` is a deployable artefact.

## Documentation

| Doc | What it answers |
|---|---|
| [SETUP.md](docs/SETUP.md) | Accounts, the five identities, licenses, Connected Apps, IAM roles, VS Code auth, GitHub secrets. Dev end-to-end; Prod is the same sequence. |
| [PLATFORM-PRIMER.md](docs/PLATFORM-PRIMER.md) | Apex, SOQL, governor limits, LWC and triggers explained via their Python equivalents. Read this if Salesforce is new to you. |
| [ARCHITECTURE-OVERVIEW.md](docs/ARCHITECTURE-OVERVIEW.md) | The whole system in one diagram, and what each component is for. |
| [HOW-IT-CONNECTS.md](docs/HOW-IT-CONNECTS.md) | How the chapters form one system, the three shared integration seams, and the order to demo them in. |
| [DATA-MODEL.md](docs/DATA-MODEL.md) | Why each object is standard or custom — the "why didn't you just use X" answers. |
| [DEVICE-IDENTITY.md](docs/DEVICE-IDENTITY.md) | How WiFi credentials and AWS certificates get onto a device, why they survive every OTA update, and how a job finds the right device. |
| [CI-CD-SECRETS.md](docs/CI-CD-SECRETS.md) | What is automated vs manual, and the conventions the pipelines enforce. |
| [MIGRATION-RUNBOOK.md](docs/MIGRATION-RUNBOOK.md) | Phased cutover to a governed Dev/Prod estate, with a rollback per phase. |
| [COST-MODEL.md](docs/COST-MODEL.md) | Real per-device, per-user and per-customer costs — and how to run the whole build on free tiers. |
| [CONTENT-GUIDE.md](docs/CONTENT-GUIDE.md) | Writing and video conventions for the article series. |

## End-to-end architecture

```mermaid
graph TB
    subgraph Edge
        A[ESP32 Device<br/>DHT11 + Servo]
    end

    subgraph "AWS — Dev / Prod accounts (AWS Organizations)"
        B[AWS IoT Core]
        C[Lambda: Ingestion / Routing]
        D[EventBridge]
        E[DynamoDB: raw time series]
        F[Bedrock: Embeddings]
        G[SQS: Alerts]
        H[AWS IoT Jobs + S3: OTA Firmware]
    end

    subgraph "Salesforce — Dev / Prod orgs"
        I[Asset - device registry]
        J[Data Cloud: Ingestion + Vector Store]
        K[Patient_Vitals__c]
        L[Platform Events]
        M[Agentforce Agents]
        N[LWC Dashboard / Admin App]
    end

    A -- MQTT over mTLS --> B
    B --> C
    C -- every reading --> E
    C -- state changes only --> K
    C --> D
    D --> G
    D -- Sync --> J
    J -- Chunk & Embed --> F
    C -- Upsert device status --> I
    G --> L
    L --> M
    M --> K
    M --> N
    N -- Trigger OTA Job --> H
    H -. Push firmware .-> A
```

## Repository structure

```
Cloud-Agentic-IoT/
├── README.md                          # You are here — the whole system + how to deploy it
├── force-app/main/default/            # Salesforce metadata — one standard project
│   ├── objects/                       # Asset, Patient_Vitals__c, Wi_Fi_Network__c, ...
│   ├── classes/                       # Apex services + tests
│   ├── triggers/                      # One trigger per object, handler pattern
│   ├── platform_events/               # Patient_Vital_Alert__e, Queue_Depth_Change__e
│   ├── bots/ genAiPlannerBundles/     # The Agentforce agent and its planner
│   ├── genAiPlugins/ genAiFunctions/  # Its topic and registered actions
│   ├── customMetadata/                # Device_Queue_Binding — config, not code
│   └── lwc/                           # queueDepthIndicator
├── lambda/<function>/                 # Lambda source + CloudFormation per function
├── firmware/
│   ├── libraries/CloudAgenticDevice/  # Shared runtime: NVS, provisioning, WiFi, MQTT, OTA
│   ├── patient-monitor/               # DHT11 vitals + medication servo
│   └── queue-indicator/               # Servo driven by Case queue depth
├── mulesoft/                          # The iPaaS alternative to the ingestion Lambda
├── content/<NN-chapter>/              # Per-chapter ARCHITECTURE diagram + article drafts
├── docs/                              # see the Documentation table above
├── scripts/                           # Device setup, provisioning, chapter scaffolding
├── .github/workflows/                 # CI/CD — see Deployment below
└── sfdx-project.json                  # Single package directory: force-app
```

Code uses one standard layout rather than per-chapter copies, so the repo looks like a real, deployable project. Only the prose is namespaced per chapter, under `content/`.

---

## Deployment

**The whole system deploys once, in one sequence.** Work top to bottom; each stage assumes the previous one is done. Nothing here is per-chapter — the chapters explain what these pieces do, they do not install separately.

| Stage | What | How long |
|---|---|---|
| 0 | Prerequisites — [`docs/SETUP.md`](docs/SETUP.md) | Once, ~a day |
| 1 | Push to `Dev` → all AWS and Salesforce deploy automatically | Minutes |
| 2 | Connect the seams CI cannot reach (Named Credentials, Slack, Data Cloud, agent) | ~an hour |
| 3 | Hardware — create the Thing, flash and provision each device | ~20 min per device |
| 4 | Verify end to end | Minutes |
| 5 | Promote `Dev` → `Prod` when it all holds | Per [MIGRATION-RUNBOOK.md](docs/MIGRATION-RUNBOOK.md) |

### Stage 1 — Push to `Dev`

Push to `Dev` and GitHub Actions does the following. Nothing here needs a local CLI, and it deploys **everything at once** — every Lambda and CloudFormation stack in `lambda/`, all Salesforce metadata in `force-app/`, and a compile check for both firmware sketches.

| Workflow | Trigger | What it does |
|---|---|---|
| `deploy-aws.yml` | push to `Dev`/`Prod` | Validates **every** `cloudformation.yaml`, then deploys each as `cloud-agentic-iot-<dir>-<branch>`, then bundles and pushes the real Lambda source over each template's placeholder handler |
| `deploy-salesforce.yml` | push to `Dev`/`Prod` | JWT Bearer Flow auth (no password), then `sf project deploy start`. Skips cleanly when `force-app/` holds nothing |
| `build-firmware.yml` | push + every PR | Compile check for every sketch. **Never flashes** — that needs physical USB access |
| `ota-release.yml` | push touching `firmware/**` | Builds the binary, uploads to S3, creates an AWS IoT Job against that device type's canary ring |
| `ota-promote.yml` | manual | Promotes a verified canary release to the full fleet, one device type at a time |

Two conventions the pipelines enforce, because both fail at deploy time rather than author time:

- A Lambda's `FunctionName` in CloudFormation must be `cloud-agentic-iot-<source directory name>`, or the source-upload step cannot find the function it belongs to.
- A sketch folder must contain a `.ino` named after the folder, or `arduino-cli` reports "main file missing from sketch".

### Stage 2 — Connect the seams CI cannot reach

Everything below is manual for a structural reason, not an oversight: it stores a secret, lives in another vendor's console, or is a deliberate human checkpoint. Do it once, in this order — later steps consume outputs from earlier ones.

**1. Named Credential `AWS_IoT_Relay`.** Setup → Named Credentials → New. Type **AWS Signature Version 4**, service `execute-api`, URL = the `QueueDepthEndpoint` output of the `cloud-agentic-iot-queue-relay-Dev` stack. This one credential carries every Salesforce → AWS callout in the system — the queue indicator, device provisioning, re-provisioning, teardown, and the Wi-Fi credential push.

**2. SSM Parameter Store.** Store `SLACK_SIGNING_SECRET` and the Salesforce JWT credentials the Slack Lambda uses at runtime. Use a **separate, least-privilege integration user** from the CI/CD deploy user — see [`docs/CI-CD-SECRETS.md`](docs/CI-CD-SECRETS.md). Never reuse deploy credentials for runtime access, and never put either in code.

**3. Slack app.** Create it at api.slack.com, add the `/patient-status` and `/dispense-medication` slash commands, and set each one's Request URL to the `SlackCommandsUrl` output of the Slack stack. Copy the Signing Secret into step 2's parameter.

**4. Data Cloud ingestion.** Configure ingestion for the External Objects that carry patient vitals. Point-and-click only — there is no metadata API coverage for it.

**5. Case queue + its binding.** Create a Case queue in Salesforce and note its Developer Name. Put that and your indicator's IoT Thing name into `force-app/main/default/customMetadata/Device_Queue_Binding.Care_Team_Queue.md-meta.xml`, then push — the binding is configuration, so it ships as metadata rather than being clicked in.

**6. Activate the agent.** Setup → Agentforce Agents → **Patient Care Agent** → activate the version, then assign the agent user a permission set granting access to `PatientCareAgentActions`. It ships `Inactive` on purpose: activating an agent that can create clinical Cases should be a deliberate act, not a side effect of a deploy.

**7. Register the MCP endpoint** with whichever agent client you are using, so it can discover the device tools at runtime.

**8. Optional — MuleSoft.** Only if you want the iPaaS ingestion path instead of the Lambda. Open `mulesoft/` in Anypoint Studio, or `mvn package` and deploy to CloudHub; set the `sf.*` properties (consumer key, keystore, principal — JWT, no password); then point the AWS IoT rule at the flow's `/telemetry` endpoint. Chapter 07 explains when this is the right call and when it is not.

Two integration points are **code, not configuration**, and are already wired in the repo — listed here so you know where they live: `PiiMaskingService.mask`/`unmask` wrap every Agentforce prompt callout (chapter 10), and the guardrails Lambda is called at `phase: input`, `phase: output`, and `phase: action` (chapter 11).

### Why these stay manual

| Step | Why it cannot be automated |
|---|---|
| Flashing firmware | Needs a USB cable in a physical port. CI has no hardware |
| First-time device credentials | The AWS private key is issued once and must never transit CI |
| Creating the AWS IoT Thing + policy | One-time per device; the automated path is chapter 13 |
| Named Credentials in Salesforce | Store secrets; created in Setup, not in metadata |
| Slack app creation + signing secret | Lives in Slack's console |
| Data Cloud ingestion config | Point-and-click configuration, no metadata API coverage |
| Activating the Agentforce agent | A deliberate human checkpoint, not a deploy step |

### Stage 3 — Hardware

Only the device chapters (00, 03, 13) need hardware. Everything else is cloud-only, and the system deploys and runs without a board attached — you just will not see a motor move.

#### What you need

| Part | Notes |
|---|---|
| ESP32 development board | DOIT DEVKIT V1 or equivalent |
| DHT11 temperature + humidity sensor | The patient-monitor's vitals source |
| SG90 micro servo | Medication dispenser (ch. 00) and queue indicator (ch. 03) |
| Breadboard + jumper wires | — |
| USB cable | Data, not charge-only — a charge-only cable is the most common "board not detected" cause |

For a queue indicator that spins continuously rather than sweeping, add an **FS90R or SG90-360** continuous-rotation servo — see chapter 03.

#### Create the Thing and its certificate

Do this once per device, before it first connects. Chapter 13 automates all of it from a Salesforce Asset record — this is the manual path, worth doing once so you understand what is being automated.

**1. Create a Thing.** AWS IoT Core → Manage → Things → Create things → Create single thing. Name it `ESP32-Patient-Monitor-01` — this becomes the device's identity, sent to it in the provisioning bundle. Choose *Auto-generate a new certificate*.

**2. Create the policy.** Secure → Policies → Create policy, named `ESP32-Patient-Monitor-Policy`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:REGION:ACCOUNT_ID:client/${iot:ClientId}" },
    { "Effect": "Allow", "Action": "iot:Publish",
      "Resource": "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/telemetry" },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": "arn:aws:iot:REGION:ACCOUNT_ID:topicfilter/device/${iot:Connection.Thing.ThingName}/command" },
    { "Effect": "Allow", "Action": "iot:Receive",
      "Resource": "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/command" }
  ]
}
```

Replace `REGION` and `ACCOUNT_ID`. `${iot:Connection.Thing.ThingName}` is a policy variable resolved per connection, so **one policy serves every device and each is scoped to its own topics** — a device physically cannot subscribe to another's commands. Add `iot:Subscribe`/`iot:Receive` on `$aws/things/${iot:Connection.Thing.ThingName}/jobs/*` for OTA.

**3. Download and attach.** Download the certificate, the private key, and Amazon Root CA 1 into one folder. Attach the policy to the certificate.

**4. Create the Salesforce Asset.** Devices use the **standard Asset object** — no custom object. SerialNumber = the IoT Thing name, Account = the patient's Person Account, Status = `Installed`.

#### Getting a device online

Nothing secret is compiled into the firmware — one `.bin` is valid for every device of its type, which is what makes a single OTA job able to target a fleet. Credentials arrive afterwards, over the USB cable, and land in the ESP32's NVS flash.

Plug the ESP32 in and run the wizard:

```bash
./scripts/setup-device.sh          # macOS / Linux
.\scripts\setup-device.ps1         # Windows
```

It asks for the folder holding your downloaded certificates, which file is which, the Thing name, the endpoint, and the WiFi network — filling in a default wherever it can work one out. Then it compiles, flashes over USB, sends the credentials, and prints what the device says back.

**Add your phone hotspot as the second network right after:**

```bash
./scripts/update-wifi.sh "<hotspot-SSID>" "<hotspot-passphrase>"
```

NVS holds three networks and only the third ever rotates, so the first two are permanent anchors. A hotspot in slot 1 means the device can reach AWS from almost anywhere — which is what lets the third slot be updated remotely later, with no USB and no rebuild.

**Every firmware update after that is over the air.** OTA rewrites the application partition only, so NVS — WiFi *and* certificate — survives untouched. Full detail in [DEVICE-IDENTITY.md](docs/DEVICE-IDENTITY.md).

> Do **not** run `esptool erase_flash` on a provisioned device. It wipes the NVS partition holding a private key that AWS issues exactly once and will never reissue. If it has already happened, use the Re-provision button on the Asset (chapter 13) — it rotates the certificate and keeps all device history.

### Stage 4 — Verify end to end

Start at the device and walk outward; a break is easiest to find at the first hop that goes quiet.

```bash
arduino-cli monitor -p <port> -c baudrate=115200
```

Expect the WiFi and AWS IoT connection lines, then telemetry every 30s. Then work outward:

| Check | Where | Expect |
|---|---|---|
| Device is publishing | IoT Core → MQTT test client, subscribe `device/<thing>/telemetry` | JSON every 30s |
| Device accepts commands | Publish `{ "operation": "DISPENSE_MEDICATION" }` to `device/<thing>/command` | The servo moves |
| Ingestion works | `Patient_Vitals__c` in Salesforce | Rows appearing |
| Events fire | Platform Event monitoring | `Patient_Vital_Alert__e` on a threshold breach |
| The loop closes | Assign a Case to the bound queue | The indicator servo starts |
| The agent acts | Agent conversation preview | A Case with `Origin = Agentforce` |
| Slack is headless | `/patient-status <device-id>` | A reply, with nobody logged into Salesforce |

### Stage 5 — Promote to `Prod`

Once it holds together on `Dev`, `Prod` is the same sequence against the second AWS account and Salesforce org — with one exception that makes it a project rather than a push: **device certificates cannot move between environments.** `iot-dev` and `iot-prod` have separate CAs, so a Dev certificate physically cannot connect to Prod. Re-provisioning the fleet is the one irreversible step, which is why [MIGRATION-RUNBOOK.md](docs/MIGRATION-RUNBOOK.md) isolates it, batches it, and puts it last.

---

## The chapters

**These are explanations, not install steps.** The system is already deployed by the time you read them — everything above stood it up in one pass. Each chapter is a directory under `content/` holding an `ARCHITECTURE.md` diagram and the article drafts (`BLOG.md`, `LINKEDIN.md`, `VIDEO.md`); the code all lives in the shared layout above, together, because it is one system.

The separation is editorial: it is the order the story is told in, across the article and video series. Where a chapter needs something from [Stage 2](#stage-2--connect-the-seams-ci-cannot-reach) it says so, and where you can watch it working there is a **To see it work** line.

### 00 · IoT Device Provisioning

Provisioning a physical ESP32 patient monitor and connecting it securely to AWS IoT Core over mutual TLS, with Salesforce as the system of record for device management — including the groundwork for OTA updates managed from a Salesforce app.

A real, physical system you can walk end-to-end, not a mockup. Secure authentication and authorization between connected systems is the whole subject.

**Key files:** `firmware/patient-monitor/`, `firmware/libraries/CloudAgenticDevice/`, `force-app/main/default/objects/Asset/`

### 01 · Data Cloud RAG Pipeline

Patient IoT data flowing from edge devices through **Data Cloud** into a RAG pipeline that lets agents retrieve patient context autonomously.

The pipeline stages: telemetry arrives at IoT Core → Lambda transforms and stores in DynamoDB → syncs to Salesforce via REST → Data Cloud ingests via External Objects → auto-chunks the time series → Bedrock embeds each chunk → agents retrieve by semantic search.

**Key files:** `force-app/main/default/objects/Patient_Vitals__c/`, `Patient_Daily_Summary__c/`, `classes/DataIngestionService.cls`, `lambda/patient-vitals/`

The device registry uses the **standard Asset object** — SerialNumber is the IoT Thing name, Account is the patient's Person Account — extended with only `Firmware_Version__c` and `Last_Telemetry_At__c`.

### 02 · Real-time Streams to Agents

Patient vitals streaming in real time through **EventBridge** and **Platform Events** to trigger autonomous agent action within seconds.

Telemetry hits IoT Core → an EventBridge rule fans out to Lambda and SQS → the alert dispatcher evaluates vitals against clinical thresholds → creates `Patient_Vitals__c` → publishes `Patient_Vital_Alert__e` for critical conditions → agents subscribed to the event act on it.

**Key files:** `platform_events/Patient_Vital_Alert__e/`, `classes/StreamingAlertService.cls` (+ test), `lambda/streaming/`

### 03 · Physical Case Queue Indicator

A servo on a desk that spins while there is unclaimed work in a Salesforce Case queue and stops the moment it is empty, with speed scaling to queue depth.

It is a desk toy. It is also a complete demonstration of Salesforce driving the physical world from business data: trigger → Platform Event → async callout with SigV4 auth → API Gateway → Lambda → IoT Core → MQTT → motor. The payoff is visible from across a room.

**The design decision that matters:** nothing about *which* queue, *which* device, or *how fast* is hardcoded. It is all `Device_Queue_Binding__mdt` custom metadata:

| Field | Purpose |
|---|---|
| `Queue_Developer_Name__c` | Which queue this device watches |
| `Device_Id__c` | AWS IoT Thing name of the indicator |
| `Full_Speed_Depth__c` | Case count at which the motor runs flat out |
| `Active__c` | Kill switch that does not require a deploy |

Apex normalises raw queue depth into a 0–100 intensity before it leaves Salesforce, so the firmware stays dumb and the business rules stay where an admin can change them. Adding a second device on a second queue is a metadata record, not a code change.

**Hardware note:** a standard **SG90 is a positional servo** — 0–180°, physically incapable of continuous rotation. The firmware defaults to a gauge-needle sweep that gets faster as the queue deepens, which works on the SG90 you already have and reads clearly on camera. For literal continuous spin use an **FS90R or SG90-360** (~$6) and uncomment `#define CONTINUOUS_ROTATION_SERVO`. Both paths are compile-verified.

**Key files:** `objects/Device_Queue_Binding__mdt/`, `classes/CaseQueueMonitorService.cls`, `triggers/CaseTrigger.trigger`, `platform_events/Queue_Depth_Change__e/`, `classes/QueueDepthRelayQueueable.cls`, `lambda/queue-relay/`, `firmware/queue-indicator/`

**To see it work:** create a Case, assign it to the bound queue, and watch the motor start. Close the Case and watch it stop.

### 04 · Headless Slack Integration

A Slack slash-command bot that reads and writes Salesforce data — `/patient-status <device-id>` and `/dispense-medication <device-id>` — without any Slack user ever logging into Salesforce. A dedicated integration user authenticates via the JWT Bearer Flow: the same pattern as the CI/CD pipeline, but as a runtime service call rather than a deploy-time one.

**How it closes the loop:** `/dispense-medication` does not just update a record. It creates a `Device_Command__c` that a Flow/Apex trigger turns into the same Platform Event the ESP32 already listens for via IoT Core. A Slack message can, headlessly, move a physical servo.

**Key files:** `lambda/slack-integration/index.js` (verifies the Slack signature — HMAC, replay-protected), `salesforce-client.js` (headless JWT auth), `cloudformation.yaml`

**To see it work:** run `/patient-status <device-id>` from Slack with nobody logged into Salesforce.

### 05 · The Agent and Its Actions

The **actual Agentforce agent** — bot, planner, topic, registered action — plus the Apex it invokes and the integration plumbing that lets it reach outside Salesforce. This is the centre of the system: everything else in the repo produces data for it, constrains it, or gives it somewhere to act.

**The idea worth defending:** an LLM deciding to escalate is a *suggestion*, not an authorisation. The agent chooses whether to call the action; Apex decides what is allowed to happen when it does. Validation, sharing enforcement, and the audit trail live in `PatientCareAgentActions.cls` where no prompt can talk them out of it.

Two details follow from treating agent input as untrusted:

- **Bulk-safe by default.** Agentforce may invoke an action once per record in a batch, so the method takes a `List` and does one DML — a per-invocation insert would hit the governor limit on the third patient.
- **`allOrNone=false`.** One malformed request from the agent must not fail its neighbours.

Every agent-created Case is stamped `Origin = 'Agentforce'`, so "what did the agent actually do" is a report, not an investigation.

| File | What it is |
|---|---|
| `bots/Patient_Care_Agent/` | The agent and its version. Ships `Inactive` — activating an agent that can create clinical Cases should be deliberate, not a side effect of a deploy |
| `genAiPlannerBundles/Patient_Care_Planner/` | The planner. Decides which topic handles a request |
| `genAiPlugins/Patient_Device_Monitoring.genAiPlugin` | The **topic** — scope plus four instructions. Where the agent's behaviour actually lives |
| `genAiFunctions/Escalate_Patient_Device_Condition.genAiFunction` | Registers the Apex `@InvocableMethod` as an action the agent may call |

The four instructions are the interesting part: **ground every answer** (only from retrieved readings and articles; say so when data is missing rather than estimating); **do not diagnose** (describe readings against thresholds, nothing more); **confirm before acting** (state which device and reading, then report the Case number); **be precise about device identity** (always the serial number; ask rather than guess when a patient has several).

`isConfirmationRequired` is `true` on the action, so confirmation is enforced by the platform rather than requested by a prompt that can be argued with.

**Key files:** `classes/PatientCareAgentActions.cls` (+ test, including a 200-record bulk invocation)

**To see it work:** open the conversation preview, ask something that should escalate, confirm when prompted, then check Cases filtered to `Origin = Agentforce`.

> **Honest caveat:** Agentforce metadata schema moves between releases, and this is validated as **well-formed XML but not yet deployed to a live org**. Expect to reconcile field names against your org's API version on first deploy — `sf project deploy start --dry-run` will tell you exactly what it disagrees with. Everything else in this repo is verified to the same standard as its claims; this is the one place where "written correctly" and "confirmed working" have not yet met.

### 06 · Multi-Agent Orchestration (MCP + Agent2Agent)

An MCP server exposing patient-device capabilities as tools any MCP-speaking agent can discover at runtime, plus the A2A pattern for one agent delegating to a specialist.

**Why MCP instead of a REST API the agent calls:** an agent talking to a bespoke REST API needs the endpoint, the shape, and the "when to use it" baked into its prompt. Change the API and you re-prompt the agent. With MCP the agent calls `tools/list` at runtime and discovers what exists, including the JSON Schema for each argument. **The contract is the schema, not the prompt.** Adding a capability is a server-side change — no agent redeployment, no prompt edit.

Two consequences that show up immediately:

- **A tool `description` is prompt engineering.** The model reads it to decide when the tool applies. A vague description produces an agent that calls the wrong tool with total confidence.
- **Tool failures are returned as tool output, not transport errors.** An agent can reason about "the device is offline" and tell the user something useful. It cannot reason about an HTTP 500.

**Verified:** all four protocol paths exercised locally — `initialize` handshake, tool discovery, a successful call, a call with a missing required argument (returns `isError` with a usable message rather than throwing), and an unknown tool (returns JSON-RPC `-32602`).

**Key files:** `lambda/mcp-server/index.js` — JSON-RPC 2.0 handler implementing `initialize`, `tools/list`, `tools/call`

**To see it work:** ask the agent something requiring device data. It will discover the tool and call it without being told the endpoint.

### 07 · Cross-Cloud Integrations (iPaaS / MuleSoft)

The same AWS-to-Salesforce telemetry sync as chapter 01, implemented as a **MuleSoft flow** instead of a Lambda — DataWeave transform, JWT connection, idempotent upsert, retryable error handling.

**The tradeoff, stated plainly:** this flow does exactly what chapter 01's Lambda already does, and adds a hop and a licence. It is the right choice when an enterprise already owns MuleSoft and wants integration logic governed, monitored, and reusable in one layer instead of scattered across per-team Lambdas. It is the wrong choice for a greenfield team with neither. Having both is the point — the architecture review question is not "can you build it" but "when would you choose each," and the answer is a governance decision, not a technical one.

Two details that matter:

- **Upsert, not create.** Devices retry on reconnect, so the same reading arrives more than once. The DataWeave builds a deterministic external ID from `deviceId + timestamp`, making the write idempotent with no dedupe table.
- **Connectivity errors return 503, not 400.** If Salesforce is down and the flow returns a client error, the device concludes its payload was bad and stops retrying. Retryable failures must look retryable.

**Key files:** `mulesoft/src/main/mule/device-telemetry-sync.xml`, `mulesoft/src/main/resources/dwl/telemetry-to-salesforce.dwl`

This is the one optional piece of the system — step 8 of [Stage 2](#stage-2--connect-the-seams-ci-cannot-reach). Everything works without it; deploying it swaps the ingestion path rather than adding to it.

### 08 · Knowledge Base RAG

Chunking and embedding care-team knowledge articles for semantic retrieval — the *unstructured* half of grounding, where chapter 01 covered structured telemetry.

**The chunking strategy is the whole ballgame.** Everyone demos RAG with fixed-size chunks because it is three lines of code. Then retrieval starts mid-sentence, and in a clinical context the agent quotes half an instruction — worse than returning nothing.

This chunker splits on paragraph boundaries first, falls back to sentence boundaries, and only hard-splits when a single sentence exceeds the window. Overlap carries context across the seam so a fact spanning two chunks stays retrievable from either. **Titles are prepended to every chunk before embedding** — a chunk reading "administer 5mg every six hours" is dangerously ambiguous once separated from the article naming the drug. The title travels with the vector.

**A bug worth keeping in the write-up:** the first version handled long *paragraphs* but not long *sentences*. A 2000-character sentence — a dosage table, a long enumerated list — passed straight through and produced a chunk nearly twice the window. Nothing errored; the embedding model would have silently truncated it and dropped the tail. Found by testing the edge case rather than the happy path. Five cases now assert that no chunk ever exceeds the cap.

**Key files:** `lambda/knowledge-indexer/index.js`

**To see it work:** POST an article as `{ "id": "...", "title": "...", "content": "..." }` and persist the returned vectors to your store — Data Cloud vector index, OpenSearch, or pgvector. The Bedrock invoke permission for `amazon.titan-embed-text-v2:0` is in the template.

### 09 · Event-Driven Architecture (Saga Pattern)

An OTA firmware rollout modelled as a **saga** — a sequence of steps spanning AWS and a physical device, each with an explicit compensating action, so a failure at step 3 unwinds steps 2 and 1 in reverse.

**Why a saga and not a transaction:** a firmware update spans an S3 upload, a Salesforce status change, an AWS IoT Job, and a device acknowledgement. There is no shared lock and no two-phase commit across that boundary. The device may simply vanish.

| Step | Compensating action |
|---|---|
| `stage_firmware` | `delete_staged_firmware` |
| `mark_device_updating` | `mark_device_active` |
| `create_iot_job` | `cancel_iot_job` |
| `await_device_ack` | `rollback_device_firmware` |

Three decisions make it work:

- **"Not ready" is not "failed."** A slow device that has not acknowledged returns `retryable`, and the orchestrator returns `IN_PROGRESS` without compensating. Conflating the two means every slow device triggers an unnecessary rollback. Verified: a device that has not acked runs **zero** compensations.
- **Steps must be idempotent.** SQS delivers at least once, so every handler will eventually run twice with identical input. The retry is routine, not exceptional — the single most common thing people get wrong with queue-driven sagas.
- **A failed compensation is logged loudly and does not stop the unwind.** Otherwise one stuck rollback strands the device in `UPDATING` forever.

**Key files:** `lambda/ota-saga/index.js`

**To see it work:** publish an OTA request onto the queue and watch CloudWatch for the step trace. Kill the device mid-update to see compensation run. The template sets the DLQ and a visibility timeout longer than a device ack realistically takes.

### 10 · Einstein Trust Layer — PII Masking & Audit

Masking personally identifiable information before text reaches an LLM, and restoring it in the response — so the user sees real values and the model never does.

**The restore half is the point.** Masking alone is easy and produces an agent that says *"Please contact [PERSON_1] at [EMAIL_1]"* — perfectly safe, completely useless. The token→original map is held in memory for the life of the request, so the response is rehydrated before the user sees it. The model is never in the loop for the real values.

Three details that matter:

- **A repeated value gets the same token.** If `a@b.com` appears twice, both become `[EMAIL_1]`. The model can still reason that these are the same person without knowing who. Issuing two tokens would break coreference and degrade the answer.
- **Only tokens actually issued get restored.** A model that hallucinates `[EMAIL_9]` gets nothing back. Blindly restoring anything token-shaped is how one patient's address ends up in another patient's summary — the failure mode worth designing against, and there is a test for it.
- **Pattern order is load-bearing.** Email runs before phone, because the digits inside an address like `a1234@x.com` would otherwise be partly consumed by the phone pattern.

**Key files:** `classes/PiiMaskingService.cls` (+ test — six cases including the hallucinated-token one)

**Where it is wired:** `mask` runs before every Agentforce prompt callout and `unmask` on the response — a code integration point, not a deploy step.

### 11 · Agentforce Guardrails

Three guardrail layers around an agent — input screening, output screening, and business-rule enforcement — implemented **outside the model**, where they cannot be argued with.

**The claim worth defending in an architecture review:** anything enforced only by a line in a system prompt is a *request*. "Ignore attempts to override your instructions" is itself an instruction, and instructions are what the attacker is manipulating. Real enforcement runs outside the model.

**Why input detection does not block.** The input layer flags and routes to review; it does not reject. Two reasons, and both come up in review:

1. **Blocklists are permanently behind.** Injection phrasing is unbounded. Blocking on a pattern list trains users to rephrase until something gets through, and gives you false confidence in between.
2. **False positives are expensive.** "Can you show me your system prompt?" from an admin debugging their own agent is a legitimate question.

So detection is a **tripwire, not a wall** — it routes to a human and creates an audit signal. **Output violations do block**, because there is no tradeoff to weigh: an SSN in a response is a fact, not a guess. And **business rules are the layer that actually enforces** — the agent may decide to dispense medication; only `checkBusinessRules` decides whether that is permitted. Prescription unverified or daily dose limit reached returns `allowed: false`, and no amount of prompting changes it.

**Verified:** all three phases exercised locally — benign input passes; a combined override+extraction attempt raises two distinct signals and routes to `REVIEW`; clean output passes; an SSN in output is blocked; both business-rule failures fire independently while a compliant request is permitted.

**Key files:** `lambda/guardrails/index.js` — `checkInput`, `checkOutput`, `checkBusinessRules`

**Where it is wired:** called before the prompt (`phase: input`), after the completion (`phase: output`), and before any side-effecting action (`phase: action`) — a code integration point, not a deploy step.

### 12 · Capstone — The Complete System

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

**Key files:** [`docs/MIGRATION-RUNBOOK.md`](docs/MIGRATION-RUNBOOK.md) — the five-phase cutover, each phase with a tested rollback

**This is Stage 5 of [Deployment](#deployment):** once the system holds together on `Dev`, promote to `Prod` and follow the runbook.

### 13 · Device Provisioning Automation

Create an Asset record in Salesforce with a Wi-Fi Network → AWS provisions the device automatically → a technician downloads one file and runs one command → the device is on the network, talking to IoT Core, and eligible for OTA. **No credentials are compiled into firmware and no private key is ever stored in Salesforce.**

**The change that makes OTA possible.** Earlier firmware compiled WiFi and certificates in via a `secrets.h`. That means **every device needs its own binary** — so there is no single image to push to a fleet, and OTA is impractical. Here nothing is compiled in. Credentials live in **NVS**, written once at provisioning. One identical binary serves every device, and NVS sits in its own partition, untouched by the `app0`/`app1` slots that `Update.h` swaps, so **an OTA update never erases a device's identity.**

**Why the private key never lands in Salesforce.** AWS returns a device private key **exactly once**, at certificate creation, and never again. Routing it through Salesforce would put a device identity into every CRM backup, data export, report and integration. So the Lambda writes the bundle straight to S3 (SSE-AES256) and returns a **15-minute pre-signed URL**. Salesforce stores the link, its expiry, and the certificate id for audit — never the key.

**The flow:**

1. Create a **Wi-Fi Network** record — SSID plus passphrase in an **Encrypted Text** field, available in every edition, no Shield needed
2. Create an **Asset**: SerialNumber = intended IoT Thing name, set the Wi-Fi Network, optionally a Thing Group
3. `AssetTrigger` fires → `DeviceProvisioningService` calls AWS via a SigV4 Named Credential
4. The Lambda creates the Thing and certificate, attaches the least-privilege policy, adds it to the Thing Group, writes the bundle to S3, returns the pre-signed URL
5. The Asset updates to **Provisioned** with the link and expiry
6. The technician downloads the bundle and runs `./scripts/provision-device.sh bundle.json` (or `.\scripts\provision-device.ps1 -Bundle bundle.json -Port COM5`)
7. The device stores it in NVS, reboots, connects, and subscribes to its Jobs topic
8. Delete the bundle — it contains the private key

**Changing a Wi-Fi password is a message, not a rebuild.** Credentials live in their own NVS namespace, so the binary and the certificate are untouched:

| Situation | What happens |
|---|---|
| Password changes while the device is **online** | Editing `Wi_Fi_Network__c` fires a trigger → `WiFiCredentialService` → per-device MQTT command → the device stores the new network **alongside** the old. No reboot, no outage |
| Deliberate update **from a terminal** (USB attached) | `./scripts/update-wifi.sh "SSID" "pass"`. Writes the `wifi` namespace only. Works whether the device is online or not, and does not reboot it |
| Password already changed, device **offline** | It cannot be messaged. It tries each stored network, fails, and drops into **Wi-Fi recovery mode** on serial, which updates credentials without touching identity |
| Migrating to a new access point | Add the new network while the old still works. Devices roll over on their own; the old AP can then be switched off |

The two NVS namespaces (`identity`, `wifi`) make this structural rather than careful: updating Wi-Fi is *incapable* of touching the certificate, not merely unlikely to.

**If NVS is erased: rotate the certificate, keep the device.** An erased NVS loses the private key, and AWS issues it exactly once — but that is recoverable and **no historical data is lost.** The Thing is preserved (the Thing *name* is the identity; the certificate is only how it proves that identity, so rotating one is like changing a password). Every row keyed on the device name survives — DynamoDB, `Patient_Vitals__c.Device__c`, Data Cloud, the Asset itself. Thing Group membership survives, so OTA keeps targeting it. Deleting and recreating the Thing is what would break all of this, which is why the rotation Lambda never does. Trigger it from a **Re-provision** button on the Asset: it revokes and deletes every attached certificate — so a copied key stops working — issues a new one, attaches it to the same Thing, and returns a fresh 15-minute bundle link.

**Deleting a device cleans up AWS,** so the serial number is immediately reusable. Without this, AWS refuses to create a Thing whose name already exists — and refuses to delete a Thing that still has principals attached — so an orphaned Thing permanently blocks that name. Order is not optional: **detach policy → detach principal → deactivate → delete certificate → delete Thing.**

| Action | Effect |
|---|---|
| Delete the Asset | Certificates revoked and deleted, Thing deleted, name free to reuse |
| **Telemetry history** | **Preserved.** DynamoDB rows and `Patient_Vitals__c` are keyed on the device name and are usually needed for audit long after the hardware is retired. Destroying clinical history as a side effect of deleting a CRM record would be the wrong default |
| Restore from Recycle Bin | The record returns; the AWS resources do not. The trigger clears the stale Thing ARN and certificate id and sets status to `Not Provisioned`, so the record re-provisions cleanly instead of *looking* provisioned while pointing at nothing |
| Delete a device that was never provisioned | No callout — there is nothing in AWS to remove |

All four Asset contexts live in **one `AssetTrigger`** rather than several, so execution order is explicit rather than left to whichever trigger the platform runs first.

**Scalability, honestly stated:** this is the **one-device-at-a-time** pattern, automated. It scales to hundreds because nothing is manual except plugging in a USB cable. Beyond that, **Fleet Provisioning by claim** is the answer — firmware ships with a shared claim certificate, the device generates its own keypair and receives a unique certificate on first connect, and no key transits anything at all. Same data model, same Thing Groups, same OTA; only step 6 disappears. Documented as the next step rather than implied to be already done.

**Key files:** `objects/Wi_Fi_Network__c/`, `objects/Asset/fields/`, `classes/DeviceProvisioningService.cls`, `classes/WiFiCredentialService.cls`, `triggers/AssetTrigger.trigger`, `lambda/device-provisioning/`, `lambda/device-reprovision/`, `lambda/device-teardown/`, `scripts/provision-device.sh` / `.ps1`

**To see it work:** create a Wi-Fi Network record, then an Asset with a SerialNumber, and watch the Asset flip to **Provisioned** with a bundle link. The SigV4 Named Credential it uses is step 1 of [Stage 2](#stage-2--connect-the-seams-ci-cannot-reach).

---

## Tech stack

- **Salesforce**: Agentforce, Data Cloud, Apex, LWC, Platform Events, Flows
- **AWS**: IoT Core, Lambda, DynamoDB, EventBridge, SQS, Bedrock, IoT Jobs (OTA)
- **Edge**: ESP32, `arduino-cli`
- **Languages**: Apex, JavaScript (Node.js), C++ (firmware), DataWeave
- **Domains**: Healthcare IoT, Patient Monitoring, AI Agents

## Current state

Every chapter is written and locally verified — firmware compiles, Node handlers are tested, Apex is reviewed. **None of it has been deployed to a real AWS account or Salesforce org yet.** The connections described above are how the system is designed to fit together; proving they fit is the deploy-and-verify work still ahead. Chapter 05's Agentforce metadata carries the one explicit caveat, noted in its section.
