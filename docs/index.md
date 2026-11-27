---
title: Cloud-Agentic-IoT
---

<div class="lp-hero">
<p class="lp-eyebrow">Open-source healthcare IoT reference build</p>
<h1 class="lp-title">Build your own monitored device, end to end</h1>
<p class="lp-lead">A temperature sensor on an ESP32 streams to AWS IoT. At 30 C a temperature alert opens one Case for the care team in Salesforce, and an Agentforce agent answers from the readings and your procedures, in Salesforce, Slack and a portal.</p>
<p class="lp-pills"><span>≈ $0.08 AWS per device a month</span> <span>≈ $37 CAD of hardware</span> <span>alert on the device in about 5 s, offline too</span></p>
<img src="images/device-to-care.svg" alt="From a monitored device to the care team: sense, stream, alert, act">
</div>

## Who are you? Pick your path

<div class="lp-cards">
<div class="lp-card"><img src="images/icons/admin.svg" alt=""><h3>Clinic Salesforce admin</h3><p>Turn it on in a free org: Setup clicks you know, copy-paste for the rest, and a check after every step.</p><a class="lp-go" href="PATH-ADMIN.md">Admin path →</a><p class="lp-meta">About 2 hours · no code to write</p></div>
<div class="lp-card"><img src="images/icons/hardware.svg" alt=""><h3>Device builder</h3><p>Parts, wiring, firmware, the device's own certificate, and printable cases for your own board.</p><a class="lp-go" href="PATH-DEVICE.md">Device path →</a><p class="lp-meta">About 20 minutes per board</p></div>
<div class="lp-card"><img src="images/icons/developer.svg" alt=""><h3>Developer</h3><p>Deploy AWS and Salesforce in one run from your laptop, then read the code behind each part.</p><a class="lp-go" href="PATH-DEVELOPER.md">Developer path →</a><p class="lp-meta">About 2 hours</p></div>
<div class="lp-card"><img src="images/icons/pipelines.svg" alt=""><h3>Pipelines team</h3><p>Separate Dev and Prod accounts and orgs, deployed by GitHub Actions with an approval for Prod.</p><a class="lp-go" href="PATH-PIPELINES.md">Pipelines path →</a><p class="lp-meta">About a day</p></div>
</div>

Not sure? **[Start here](START-HERE.md)** compares the paths. Only want to see it work first? **[Step through the process](process/)**, no install needed.

> [!NOTE]
> **Video walkthrough: coming soon.** A short video showing the end result and where each part lives in the repository.

## What you get at the end

<div class="lp-stats">
<div><b>1 Case</b>per device per alert, routed to the care team queue</div>
<div><b>3 places</b>the agent answers: Salesforce, Slack and a portal</div>
<div><b>Live</b>status card and remote commands on each device</div>
<div><b>Cost and limits</b>AWS spend and org limits on the app's Home tab</div>
</div>

## Platforms at a glance

Each icon marks the platform a step or a page is about.

<div class="lp-legend">
<div><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <b>Salesforce</b> <span>the app, Cases for the care team, Setup</span></div>
<div><img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> <b>Agentforce</b> <span>the agents that answer</span></div>
<div><img class="pi" src="images/platforms/data-cloud.svg" alt="Data Cloud" title="Data Cloud" width="20" height="20"> <b>Data Cloud</b> <span>readings for KPIs</span></div>
<div><img class="pi" src="images/platforms/portal.svg" alt="Portal (Experience Cloud)" title="Portal (Experience Cloud)" width="20" height="20"> <b>Portal</b> <span>the React site on Experience Cloud</span></div>
<div><img class="pi" src="images/platforms/slack.svg" alt="Slack" title="Slack" width="20" height="20"> <b>Slack</b> <span>status and the agent in chat</span></div>
<div><img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <b>AWS</b> <span>your project with a spend limit</span></div>
<div><img class="pi" src="images/platforms/iot-core.svg" alt="AWS IoT Core" title="AWS IoT Core" width="20" height="20"> <b>IoT Core</b> <span>device certificates and MQTT</span></div>
<div><img class="pi" src="images/platforms/lambda.svg" alt="AWS Lambda" title="AWS Lambda" width="20" height="20"> <b>Lambda</b> <span>readings, commands, the relay</span></div>
<div><img class="pi" src="images/platforms/dynamodb.svg" alt="DynamoDB and S3" title="DynamoDB and S3" width="20" height="20"> <b>DynamoDB and S3</b> <span>latest readings and the archive</span></div>
<div><img class="pi" src="images/platforms/bedrock.svg" alt="Amazon Bedrock" title="Amazon Bedrock" width="20" height="20"> <b>Bedrock</b> <span>SOP search embeddings</span></div>
<div><img class="pi" src="images/platforms/esp32.svg" alt="ESP32" title="ESP32" width="20" height="20"> <b>ESP32</b> <span>the board and its firmware</span></div>
<div><img class="pi" src="images/platforms/electronics.svg" alt="Electronics (wiring)" title="Electronics (wiring)" width="20" height="20"> <b>Electronics</b> <span>sensor, motor, wiring</span></div>
<div><img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> <b>Git and GitHub</b> <span>code, pipelines, OTA releases</span></div>
<div><img class="pi" src="images/platforms/terminal.svg" alt="Terminal" title="Terminal" width="20" height="20"> <b>Terminal</b> <span>copy-paste command blocks</span></div>
</div>

<small>Product names and logos belong to their owners. They are used to show what this project works with, not endorsement. Where each icon comes from: [icon credits](images/platforms/CREDITS.md).</small>

## What it does

| Part | What happens |
|---|---|
| <img class="pi" src="images/platforms/esp32.svg" alt="ESP32" title="ESP32" width="20" height="20"> <img class="pi" src="images/platforms/electronics.svg" alt="Electronics (wiring)" title="Electronics (wiring)" width="20" height="20"> <img class="pi" src="images/platforms/iot-core.svg" alt="AWS IoT Core" title="AWS IoT Core" width="20" height="20"> **Sense** | An ESP32 with a DHT11 sends readings to AWS IoT Core over mutual TLS. No secrets are compiled into the firmware, and every update after the first USB flash goes over the air. |
| <img class="pi" src="images/platforms/esp32.svg" alt="ESP32" title="ESP32" width="20" height="20"> <img class="pi" src="images/platforms/iot-core.svg" alt="AWS IoT Core" title="AWS IoT Core" width="20" height="20"> <img class="pi" src="images/platforms/service.svg" alt="Cases (Service)" title="Cases (Service)" width="20" height="20"> **Alert** | At 30 C the board's own motor turns at once (it works offline), and AWS flags the reading so Salesforce opens one Case for the care team. A ward board spins while that queue has work. |
| <img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> <img class="pi" src="images/platforms/bedrock.svg" alt="Amazon Bedrock" title="Amazon Bedrock" width="20" height="20"> **Act** | The Patient Care Agent (Agentforce, new builder) reads the device, cites the ward's SOPs found with Bedrock embeddings, and escalates only after you confirm. Guardrails and PII masking run outside the model. |
| <img class="pi" src="images/platforms/portal.svg" alt="Portal (Experience Cloud)" title="Portal (Experience Cloud)" width="20" height="20"> <img class="pi" src="images/platforms/slack.svg" alt="Slack" title="Slack" width="20" height="20"> **Reach** | Patients sign in to a **React site on Salesforce** (Multi-Framework, React 19) and chat with their own care assistant through **Enhanced Chat v2**: a second Agentforce agent that only ever sees the signed-in patient's devices and can send a nurse request. Staff use **Slack**: `/patient-status <device>` answers with no Salesforce login (JWT integration user), and the Patient Care Agent answers in Slack DMs. |
| <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> **Measure** | The app's Home tab shows the month's AWS spend against its limit, the org's limits, and a Business Value dashboard: alert response, chat deflection, hours avoided and cost per device. |

## How it works

![From a warm sensor to an agent answer: eight steps, animated](images/process-flow.svg)

## Install

New here? **[Start here](START-HERE.md)** picks your path: clinic Salesforce admin, device builder, developer, or a team with pipelines. Everyone follows the Quick Install Guide, with a check after each step; the Detailed Install Guide explains the why.

| | [Quick Install Guide](INSTALL.md) | [Detailed Install Guide](INSTALL-GUIDE.md) |
|---|---|---|
| For | Getting it running | Understanding every step |
| What you get | Every feature as execution steps in order, deployed in one run by `scripts/install.sh` | Each step, why it is done that way, and what to check when it fails |
| Time | About two hours for every feature, plus 20 min per board | About a day for the full pipeline setup |

## Documentation

Grouped by what you came to do, after the [Diátaxis](https://diataxis.fr/) framework.

| Learn by doing | Get a task done |
|---|---|
| [Start here](START-HERE.md): the four paths (admin, device builder, developer, pipelines) | |
| <img class="pi" src="images/platforms/terminal.svg" alt="Terminal" title="Terminal" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> [Quick Install Guide](INSTALL.md): every feature, step by step | [Detailed Install Guide](INSTALL-GUIDE.md): every step, explained |
| <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> [Use case scenarios](TRY-IT.md): after install, test every feature as one real situation each, by who you act as | <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> [Setup](SETUP.md): accounts, identities, licences, Connected Apps, GitHub secrets |
| <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> [Platform primer](PLATFORM-PRIMER.md): Apex, SOQL and LWC through their Python equivalents | <img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> [Development](DEVELOPMENT.md): laptop to Dev to Prod |
| | <img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> [Migration runbook](MIGRATION-RUNBOOK.md): phased cutover with a rollback per phase |
| | [Troubleshooting](TROUBLESHOOTING.md): what broke, why, and the fix |

| Understand the design | Look something up |
|---|---|
| [The chapters](CHAPTERS.md): 14 capabilities, one system | <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> [Data model](DATA-MODEL.md): why each object is standard or custom |
| [How it connects](HOW-IT-CONNECTS.md) and [Architecture overview](ARCHITECTURE-OVERVIEW.md) | <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> [Cost model](COST-MODEL.md): per device, per user, per customer |
| <img class="pi" src="images/platforms/esp32.svg" alt="ESP32" title="ESP32" width="20" height="20"> <img class="pi" src="images/platforms/iot-core.svg" alt="AWS IoT Core" title="AWS IoT Core" width="20" height="20"> [Device identity](DEVICE-IDENTITY.md): certificates and WiFi that survive OTA | <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> [Spend and limits](SPEND-AND-LIMITS.md): the Home page's numbers |
| <img class="pi" src="images/platforms/bedrock.svg" alt="Amazon Bedrock" title="Amazon Bedrock" width="20" height="20"> <img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> [SOP grounding](SOP-GROUNDING.md) and [Guardrails and MCP](GUARDRAILS-AND-MCP.md) | <img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> [CI/CD and secrets](CI-CD-SECRETS.md): what is automated and the conventions |
| <img class="pi" src="images/platforms/portal.svg" alt="Portal (Experience Cloud)" title="Portal (Experience Cloud)" width="20" height="20"> <img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> [Patient portal](PATIENT-PORTAL.md): the React site, Enhanced Chat and the patient agent | <img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> <img class="pi" src="images/platforms/bedrock.svg" alt="Amazon Bedrock" title="Amazon Bedrock" width="20" height="20"> [Agent evals](AGENT-EVALS.md): Testing Center specs and retrieval scores |
| <img class="pi" src="images/platforms/slack.svg" alt="Slack" title="Slack" width="20" height="20"> [Slack](CHAPTERS.md#04--headless-slack-integration): `/patient-status` with no login, and [the agent in Slack](SETUP.md#talk-to-the-agent-from-slack-optional) | <img class="pi" src="images/platforms/data-cloud.svg" alt="Data Cloud" title="Data Cloud" width="20" height="20"> [Business value](BUSINESS-VALUE.md): the KPI dashboard and its assumptions |
| <img class="pi" src="images/platforms/esp32.svg" alt="ESP32" title="ESP32" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> [Live status](LIVE-STATUS.md), [Data Cloud](DATA-CLOUD.md), [Scaling](SCALING.md) | |

## KPIs and cost

| Measure | Value | Source |
|---|---|---|
| AWS per monitored device | ≈ $0.08 a month (readings every 30 s) | [COST-MODEL.md](COST-MODEL.md) |
| Total per patient and device | ≈ $0.60 to $2.50 a month, driven by Agentforce use | [COST-MODEL.md](COST-MODEL.md) |
| Hardware per board | ≈ $37 CAD retail | [COST-MODEL.md](COST-MODEL.md) |
| SOP search | Under a cent a month, nothing runs while idle | [SOP-GROUNDING.md](SOP-GROUNDING.md) |
| Alert on the board | Within about 5 s of reaching 30 C, offline too | [CHAPTERS.md §03](CHAPTERS.md#temperature-alert-demo-rule) |
| Business value | Net value, deflection vs break-even, response time before vs after, hours avoided | [BUSINESS-VALUE.md](BUSINESS-VALUE.md) |
| Retrieval quality | hit@1, hit@3 and MRR on every eval run | [AGENT-EVALS.md](AGENT-EVALS.md) |
| Spend guard | An AWS project spend limit, shown on the Home tab | [SPEND-AND-LIMITS.md](SPEND-AND-LIMITS.md) |
