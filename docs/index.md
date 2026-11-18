---
title: Cloud-Agentic-IoT
---

# Cloud-Agentic-IoT

A healthcare IoT + Agentforce system, built from scratch and in public. A physical ESP32 board measures temperature, AWS IoT streams it, Salesforce turns it into Cases, and an Agentforce agent answers from the readings and the ward's procedures, in Salesforce, Slack and a patient portal.

> [!NOTE]
> **Video walkthrough: coming soon.** A short video showing the end result and where each part lives in the repository.

**[Step through the process →](process/)** · **[Quick install](INSTALL.md)** · **[Install guide](INSTALL-GUIDE.md)** · **[Code on GitHub](https://github.com/CloudArchitect101/Cloud-Agentic-IoT)**

## What it does

| Part | What happens |
|---|---|
| **Sense** | An ESP32 with a DHT11 sends readings to AWS IoT Core over mutual TLS. No secrets are compiled into the firmware, and every update after the first USB flash goes over the air. |
| **Alert** | At 30 C the board's own motor turns at once (it works offline), and AWS flags the reading so Salesforce opens one Case for the care team. A ward board spins while that queue has work. |
| **Act** | The Patient Care Agent (Agentforce, new builder) reads the device, cites the ward's SOPs found with Bedrock embeddings, and escalates only after you confirm. Guardrails and PII masking run outside the model. |
| **Reach** | Patients sign in to a **React site on Salesforce** (Multi-Framework, React 19) and chat with their own care assistant through **Enhanced Chat v2**: a second Agentforce agent that only ever sees the signed-in patient's devices and can send a nurse request. Staff use **Slack**: `/patient-status <device>` answers with no Salesforce login (JWT integration user), and the Patient Care Agent answers in Slack DMs. |
| **Measure** | The app's Home tab shows the month's AWS spend against its limit, the org's limits, and a Business Value dashboard: alert response, chat deflection, hours avoided and cost per device. |

## How it works

![From a warm sensor to an agent answer: eight steps, animated](images/process-flow.svg)

## Install

| | [Quick install](INSTALL.md) | [Install guide](INSTALL-GUIDE.md) |
|---|---|---|
| For | Getting it running | Understanding every step |
| What you get | Commands in order, one line of context each | Each step, why it is done that way, and what to check when it fails |
| Time | About an hour, plus 20 min per board | About a day for the full pipeline setup |

## Documentation

Grouped by what you came to do, after the [Diátaxis](https://diataxis.fr/) framework.

| Learn by doing | Get a task done |
|---|---|
| [Quick install](INSTALL.md): the shortest path to a running system | [Install guide](INSTALL-GUIDE.md): every step, explained |
| [Try it](TRY-IT.md): your own project and org, then each demo (warm the sensor, the saga, Slack) | [Setup](SETUP.md): accounts, identities, licences, Connected Apps, GitHub secrets |
| [Platform primer](PLATFORM-PRIMER.md): Apex, SOQL and LWC through their Python equivalents | [Development](DEVELOPMENT.md): laptop to Dev to Prod |
| | [Migration runbook](MIGRATION-RUNBOOK.md): phased cutover with a rollback per phase |
| | [Troubleshooting](TROUBLESHOOTING.md): what broke, why, and the fix |

| Understand the design | Look something up |
|---|---|
| [The chapters](CHAPTERS.md): 14 capabilities, one system | [Data model](DATA-MODEL.md): why each object is standard or custom |
| [How it connects](HOW-IT-CONNECTS.md) and [Architecture overview](ARCHITECTURE-OVERVIEW.md) | [Cost model](COST-MODEL.md): per device, per user, per customer |
| [Device identity](DEVICE-IDENTITY.md): certificates and WiFi that survive OTA | [Spend and limits](SPEND-AND-LIMITS.md): the Home page's numbers |
| [SOP grounding](SOP-GROUNDING.md) and [Guardrails and MCP](GUARDRAILS-AND-MCP.md) | [CI/CD and secrets](CI-CD-SECRETS.md): what is automated and the conventions |
| [Patient portal](PATIENT-PORTAL.md): the React site, Enhanced Chat and the patient agent | [Agent evals](AGENT-EVALS.md): Testing Center specs and retrieval scores |
| [Slack](CHAPTERS.md#04--headless-slack-integration): `/patient-status` with no login, and [the agent in Slack](SETUP.md#talk-to-the-agent-from-slack-optional) | [Business value](BUSINESS-VALUE.md): the KPI dashboard and its assumptions |
| [Live status](LIVE-STATUS.md), [Data Cloud](DATA-CLOUD.md), [Scaling](SCALING.md) | |

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
