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

## See what you build

Two ESP32 boards in 3D-printed cases, AWS IoT, Salesforce with Agentforce and Data Cloud, all running together. Everything below comes from the [Quick Install Guide](INSTALL.md), steps 12 and 13.

<h3 class="sw-step">0. Tech stack</h3>
<div class="sw-grid">
<div class="sw-cell"><p class="sw-head"><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> Salesforce</p><p><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <b>Salesforce</b>: Service Cloud Cases, Apex, Lightning<br><img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> <b>Agentforce</b>: two agents, new builder<br><img class="pi" src="images/platforms/data-cloud.svg" alt="Data Cloud" title="Data Cloud" width="20" height="20"> <b>Data Cloud</b>: reading history and insights<br><img class="pi" src="images/platforms/slack.svg" alt="Slack" title="Slack" width="20" height="20"> <b>Slack</b>: slash command and agent DMs<br><img class="pi" src="images/platforms/portal.svg" alt="Salesforce Multi-Framework" title="Salesforce Multi-Framework" width="20" height="20"> <b>Multi-Framework React portal</b>: external patient site, React 19 on Salesforce<br><img class="pi" src="images/platforms/portal.svg" alt="Enhanced Chat v2" title="Enhanced Chat v2" width="20" height="20"> <b>Enhanced Chat v2</b>: the portal's verified chat with the patient agent<br><img class="pi" src="images/platforms/agentforce.svg" alt="MCP" title="MCP" width="20" height="20"> <b>MCP</b>: both agents use Espressif's MCP servers through Agentforce Registry</p></div>
<div class="sw-cell"><p class="sw-head"><img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> AWS</p><p><img class="pi" src="images/platforms/iot-core.svg" alt="AWS IoT Core" title="AWS IoT Core" width="20" height="20"> <b>AWS IoT Core</b>: mutual TLS, rules, OTA jobs<br><img class="pi" src="images/platforms/lambda.svg" alt="AWS Lambda" title="AWS Lambda" width="20" height="20"> <b>Lambda</b>: alerts, commands, Salesforce sync<br><img class="pi" src="images/platforms/bedrock.svg" alt="Amazon Bedrock" title="Amazon Bedrock" width="20" height="20"> <b>Bedrock</b>: SOP search with embeddings<br><img class="pi" src="images/platforms/aws.svg" alt="Amazon S3" title="Amazon S3" width="20" height="20"> <b>S3</b>: reading archive and firmware</p></div>
</div>

<h3 class="sw-step">1. Build two devices (<a href="INSTALL.md#step-12">step 12</a>)</h3>
<div class="sw-grid">
<div class="sw-cell"><video src="videos/assembly-monitored-device.mp4" poster="videos/assembly-monitored-device.jpg" autoplay muted loop playsinline controls width="640" aria-label="Animation: the ESP32, DHT11 sensor and servo go into the 3D-printed arm cuff"></video><p><b>Monitored device</b> <code>PatientExternalESP32</code>: an ESP32, a DHT11 temperature sensor and a servo in a 3D-printed arm cuff.</p><a href="images/wiring-monitored-device.svg"><img src="images/wiring-monitored-device.svg" alt="Wiring of the monitored device: DHT11 to 3.3V, P4 and GND with a 10 kΩ pull-up; servo to P5, 5V and GND"></a><p>Wiring, drawn from the real parts: DHT11 on P4 with a 10 kΩ pull-up, servo on P5.</p></div>
<div class="sw-cell"><video src="videos/assembly-corp-gauge.mp4" poster="videos/assembly-corp-gauge.jpg" autoplay muted loop playsinline controls width="640" aria-label="Animation: the ESP32 and servo go into the 3D-printed ticket gauge with its bell"></video><p><b>Corp ticket gauge</b> <code>CompanyInternalESP32</code>: an ESP32 and a servo that swings a needle and rings a bell for the care team.</p><a href="images/wiring-corp-gauge.svg"><img src="images/wiring-corp-gauge.svg" alt="Wiring of the corp ticket gauge: servo to P5, 5V and GND"></a><p>Wiring: one servo on P5. Saving the board's Asset in Salesforce gives it its own X.509 certificate, with no secrets in the firmware.</p></div>
</div>

<h3 class="sw-step">2. Watch it work (<a href="INSTALL.md#step-13">step 13</a>)</h3>
<div class="sw-grid">
<div class="sw-cell"><video src="videos/working-monitored-device.mp4" poster="videos/working-monitored-device.jpg" autoplay muted loop playsinline controls width="640" aria-label="Animation: the monitored device on the arm reaches 30 C and its servo starts to spin"></video><p><b>30 C on the arm.</b> The board's own servo spins within 5 s, even offline. AWS IoT Core flags the crossing, and Salesforce opens one Case for the care team.</p></div>
<div class="sw-cell"><video src="videos/working-corp-gauge.mp4" poster="videos/working-corp-gauge.jpg" autoplay muted loop playsinline controls width="640" aria-label="Animation: the corp ticket gauge sweeps its needle and rings the bell for the open Case"></video><p><b>The office hears it.</b> The open Case drives the gauge through a platform event, an AWS callout and MQTT: its needle sweeps and its bell rings until someone closes the Case. The Patient Care Agent then reads the device and cites the ward's procedure.</p></div>
</div>

<h3 class="sw-step">3. Run it as a business (the app's Home tab)</h3>
<div class="sw-grid">
<div class="sw-cell"><img src="images/home-cost-card-preview.png" alt="Home tab cost and limits card: AWS spend this month against the budget, and the Salesforce org's most used limits"><p><b>Cost and limits.</b> This month's AWS spend against its budget (about $0.08 per device a month), and the org's limits: storage, API calls, async Apex, streaming events.</p></div>
<div class="sw-cell"><img src="images/data-cloud-value-card-preview.png" alt="Data Cloud value card: out-of-range minutes, highest temperature, devices reporting, manual checks replaced, Data Cloud cost and return"><p><b>Data Cloud value.</b> Out-of-range minutes, the highest temperature, which devices went silent, and the manual checks the system replaces, measured against what Data Cloud costs.</p></div>
</div>

<p class="sw-note">The animations are renders of the real 3D models, and the Home cards show sample data. Real footage and org screenshots will replace them under the same file names.</p>

<div align="center" class="cta" markdown="1">

[![Start the install: open the Quick Install Guide](images/start-install-button.svg)](INSTALL.md)

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

## Reuse and licence

You can reuse this project, including commercially, as is or as a starting point. The code is under the [MIT licence](https://github.com/CloudArchitect101/Cloud-Agentic-IoT/blob/Dev/LICENSE). These docs, the diagrams, images, videos and the 3D case designs are under [CC BY 4.0](LICENSE-CC-BY-4.0.txt): credit **Cloud-Agentic-IoT by Vitaly Makarkin** with a link to [the repository](https://github.com/CloudArchitect101/Cloud-Agentic-IoT) and say what you changed. Part photos and product logos keep their owners' terms: see the [part photo](images/parts/CREDITS.md) and [icon](images/platforms/CREDITS.md) credits, and [what each licence covers](https://github.com/CloudArchitect101/Cloud-Agentic-IoT#license).
