# Detailed Install Guide

> [!TIP]
> New here? [Start here](START-HERE.md) shows which guide to follow. The [Quick Install Guide](INSTALL.md) is the one list of commands; this page explains them.

<a id="quick-install-explained"></a>

This page has the same steps as the [Quick Install Guide](INSTALL.md), with the same numbers and titles, from 0 to 14. The Quick Install Guide says what to paste. This page says what each step builds in AWS and Salesforce, how it works under the commands, which design was chosen and what else was considered, and what it means for security, scale and cost. It quotes a command only where the command needs explaining. When a step shows something else than the Quick Install Guide says, see [If a Quick Install Guide step goes differently](TROUBLESHOOTING.md#install-steps).

Every step below ends with a link back to the same step in the Quick Install Guide.

<a id="step-map"></a>

| # | Step | What it builds |
|---|---|---|
| [0](#step-0) | [Order the parts and print the cases](#step-0) | Two devices: the monitored device (arm cuff) and the corp ticket gauge (desk gauge with a bell) |
| [1](#step-1) | [Install the tools](#step-1) | The command-line tools every later step drives |
| [2](#step-2) | [Create the AWS project and the Salesforce org](#step-2) | A spend-limited AWS project and a free Developer Edition org |
| [3](#step-3) | [Turn on the org's features](#step-3) | The org features that accept terms or can't be turned off again |
| [4](#step-4) | [Clone and sign in](#step-4) | The repo on your computer, and both CLIs signed in without a stored key |
| [5](#step-5) | [Make what the deploy reads](#step-5) | The identities and keys only this org can make |
| [6](#step-6) | [Deploy everything in one run](#step-6) | Every AWS stack, all Salesforce metadata, the permission sets and the staff agent |
| [7](#step-7) | [Let Salesforce call AWS](#step-7) | The one signed credential every Salesforce to AWS call uses |
| [8](#step-8) | [Slack](#step-8) | `/patient-status` and the Patient Care Agent in Slack |
| [9](#step-9) | [Data Cloud](#step-9) | Every reading in Data Cloud, for history and trends |
| [10](#step-10) | [Patient portal with Enhanced Chat](#step-10) | A React site for patients with a verified chat to its own agent |
| [11](#step-11) | [MCP servers](#step-11) | Your devices as tools for Claude Code, and Espressif's catalogs in both agents |
| [12](#step-12) | [Add the boards](#step-12) | Each board's identity in AWS IoT, its firmware and its Wi-Fi |
| [13](#step-13) | [Check that it works](#step-13) | Proof that every hop of the loop works |
| [14](#step-14) | [Dev and Prod pipelines](#step-14) | Two environments deployed by GitHub Actions |

## The system you are installing

**The loop in one sentence.** A sensor on a board sends a reading, AWS takes it in and decides whether it matters, Salesforce stores what someone must act on and opens a Case, an agent helps the care team decide what to do, and the decision travels back out to move a motor on a desk. [How the pieces connect](HOW-IT-CONNECTS.md) draws it chapter by chapter, and the [architecture overview](ARCHITECTURE-OVERVIEW.md) draws the services.

**The path of one reading**, which most steps below add a piece to:

1. The board publishes a reading every 30 seconds to AWS IoT Core over MQTT with TLS, signed in with its own certificate (step 12).
2. AWS IoT **Basic Ingest** hands it straight to the IoT rule `cloud_agentic_iot_patient_vitals`, skipping the message broker, which is why AWS does not bill it as a message ([SCALING.md](SCALING.md#levers-in-order-of-effect)).
3. The rule puts it on an SQS telemetry queue, and the `patient-vitals` Lambda takes the queue in batches.
4. `patient-vitals` keeps each board's current state in DynamoDB, writes every reading to the S3 archive (and a CSV copy for Data Cloud, step 9), and passes on only what changed: a state change, a reminder, or a crossing of the 30 C temperature alert threshold.
5. A second queue and the `salesforce-sync` Lambda write those few readings to `Patient_Vitals__c` in Salesforce, signed in as the integration user (step 5b).
6. A trigger opens a Case in `Care_Team_Queue`, and the corp ticket gauge, which follows that queue, starts to sweep and ring (step 12b).
7. Every call from Salesforce back to AWS (a command, provisioning, the live card, the spend card, the agent's procedure search) goes through one signed named credential, `AWS_IoT_Relay` (step 7), to API Gateway, and from there to a board through the `device-command` Lambda and its guardrails (step 11).

**Rules every step follows.** They explain most of the choices below:

| Rule | What it means for the install |
|---|---|
| The pipeline runs the same scripts you do | `scripts/install.sh` in step 6 only chains `check.sh`, `deploy-aws.sh`, `deploy-salesforce.sh` and the rest, which GitHub Actions runs in step 14. A green run on your laptop predicts a green pipeline ([DEVELOPMENT.md](DEVELOPMENT.md)) |
| Nothing secret in the repo, the firmware or a chat | Keys are typed hidden into a terminal or into Setup. `.gitignore` keeps `*.key` and `*.crt` out of Git, a test fails if a template creates an IAM user or key, and the firmware carries no certificate or Wi-Fi ([DEVICE-IDENTITY.md](DEVICE-IDENTITY.md)) |
| Numbers are configuration, not code | Batch sizes, thresholds, retention and rate limits live in `config/Dev.json` and `config/Prod.json` and in custom metadata, so Dev and Prod differ only there. `test/config/environments.test.js` fails when a key is not a parameter of its template |
| Every part is safe to run again | Each script checks what exists before it creates anything, so a step that stopped halfway is fixed by running it again |
| Least privilege by default | Each identity (the board, the integration user, the caller IAM user, Data Cloud's reader, the MCP server) can do one job and nothing else, and each step below says what that job is |

<a id="why-these-stay-manual"></a>

**What stays by hand, and why.** The Quick Install Guide has Setup clicks between its commands. Each one is there for a reason that a script can't remove:

| By hand | Step | Why it is not automated |
|---|---|---|
| Creating the AWS project, the org and the Slack workspace | 2, 5d | Billing identity, sign-up and terms belong to a person |
| Turning on Einstein, Agentforce, Person Accounts, Digital Experiences, Omni-Channel and Messaging | 3 | Each accepts terms or can't be turned off. The settings that switch Einstein and Agentforce on are documented for scratch orgs, not for deploying to an existing org ([SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin)) |
| The integration user, its External Client App and the chat certificate | 5 | Each holds something only this org can make: a username in your domain with its own licence, a consumer key Salesforce generates on save, a private key that never leaves Salesforce |
| The caller IAM user, its access key and the role ARN in the external credential | 7 | The deploy identities may not create IAM users or access keys (`NoBillingNoUsers` in [`scripts/aws-project-policy.json`](../scripts/aws-project-policy.json)), and Salesforce stores the key and the ARN as credentials, not as metadata a file can carry |
| Connecting Slack and installing the agent in it | 8 | It lives in Slack's console and needs the workspace owner |
| The Data Cloud connection, data stream and mapping | 9 | The connection holds a credential, and Data Cloud metadata moves between orgs as a data kit built in an org first ([DATA-CLOUD.md](DATA-CLOUD.md#why-the-data-cloud-side-is-not-in-force-app)) |
| The chat deployment, user verification, agent user, CORS and guest access | 10 | Salesforce keeps them out of metadata, or they hold org-specific Ids |
| Registering Espressif's MCP servers and adding their actions | 11 | The Agentforce Registry is Setup clicks today |
| A board's first flash over USB | 12 | A blank ESP32 has no network stack: over-the-air updates work only once this firmware runs |
| Approving a Prod deploy and promoting a release to the whole fleet | 14 | They are deliberate human checkpoints |

## The name and the resume lines

**The name `test-cloud-agentic-iot`.** The Quick Install Guide calls the AWS CLI profile and the Salesforce CLI org alias `test-cloud-agentic-iot`, so every block pastes as it is. The name lives only on your computer: no AWS resource or Salesforce record is named after it (bucket names use the account ID and Region), so two people using the same name never collide. Any name of letters, digits and `-` works. Every `sf` command names its org with `--target-org "$NAME"`, so a command always goes to that org, never to whichever org the CLI last used. `test/config/install-doc.test.js` fails the checks when a block in the Quick Install Guide leaves the org out.

**What a new terminal keeps** (the resume lines):

| What | After a restart |
|---|---|
| `NAME`, `AWS_PROFILE`, `SF_TARGET_ORG` (step 4) | **Gone.** Run the resume lines |
| `sf` org login (step 4) | Kept on disk. Nothing to do |
| `aws login` session (step 4) | Kept on disk for some hours. On a new day, run `aws login --profile "$NAME"` once |
| Variables set inside one command block (`ACCOUNT`, `LIMIT`, `EMAIL`, `STACK`, `CALLER`, `ROLE_ARN`, `INTEGRATION_USER`, `MEMBER`, `AGENT_USER`, `PATIENT_USER`, `CRT`, `BUNDLE`, `MCP_URL`, `REGION`, `MY_DOMAIN`) | Used only in that block. In a new terminal, run the whole block again |
| Pipelines (step 14): `AWS_PROFILE=iot-dev`, `SF_TARGET_ORG=iot-dev-admin` | **Gone.** Run their `export` lines again |
| Files you made: keys in `scripts/`, the portal key in `~/Downloads` | Kept. Nothing to do |

<a id="step-0"></a>

## 0. Order the parts and print the cases

**What it builds.** Two physical devices that run the same firmware but play different roles. The **monitored device** (`PatientExternalESP32`) is an arm cuff with a DHT11 temperature and humidity sensor and a servo: its sensor measures whatever it sits on (in the demo, under an arm; it could as well be a fridge or a room), and its servo sweeps while the reading is at or above 30 C. The **corp ticket gauge** (`CompanyInternalESP32`) has a servo and a bell and no sensor: its needle sweeps and rings the bell while the care team's queue has open Cases.

**Why these parts.** Each is chosen for the code and the cases in this repo:

- The 38-pin ESP-WROOM-32 board (about 55 x 28 mm) fits the hub's board bay and the gauge's cradle. The firmware reads the DHT11 on P4 and drives the servo on P5.
- The DHT11 is the **bare 4-leg** part, not one on a breakout board, because the cuff's sensor pocket is shaped for it. The bare part needs a 10 kΩ pull-up between legs 1 and 2, which is why a soldering iron is on the list; nothing else is soldered.
- The SG90 is a **positional** servo (0 to 180°), not a continuous-rotation one. The firmware sweeps it like a gauge needle, faster as the queue deepens, which reads clearly on camera. A continuous-rotation FS90R also works with `#define CONTINUOUS_ROTATION_SERVO` ([CHAPTERS.md, chapter 03](CHAPTERS.md#03--physical-case-queue-indicator)).
- The packs hold spares: a DHT11 can fail after weeks of use, and three sensors cost less than one replacement shipped.
- Both boards run from one 2-port USB charger with a cable each, and the same cables flash them in step 12.
- The bell is iron, 36 mm across, open at the bottom, and hangs from a loop: the 36 mm hanger in the print files holds it so the needle's hammer strikes its rim.

**The cases.** The print files hold the default set: the cuff for a 27 to 31 cm upper arm (`r46`), the bell on the left of the gauge and the 36 mm hanger. For another arm size (`r40` for 24 to 27 cm, `r52` for 31 to 35 cm), or a servo that turns clockwise and needs the `bell-right` parts, swap that part in the slicer: every part is also a single STL in [`hardware/cases/stl`](https://github.com/CloudArchitect101/Cloud-Agentic-IoT/tree/Dev/hardware/cases/stl). The [cases README](https://github.com/CloudArchitect101/Cloud-Agentic-IoT/tree/Dev/hardware/cases) explains each part, how to check the servo's direction before printing, and the assembly. PLA is enough, since nothing gets hot and nothing flexes; PETG or ABS also work. No part needs supports. The dial plate's art is raised in three steps (3.4, 3.8 and 4.2 mm): painting the tops is simplest, and a printer that changes filament mid-print can print them in colour instead. The photos in the parts table are freely licensed stand-ins ([credits](images/parts/CREDITS.md)).

**Cost.** About CA$127 plus tax for the parts of both devices, plus about CA$20 for a spool of PLA (both devices use about 270 g), so about CA$75 per device. Bought by the hundred, parts cost roughly half ([COST-MODEL.md §1](COST-MODEL.md#1-one-time-hardware-cad-retail-single-units)). The hardware is not where the money goes: spread over 24 months it is about six cents a month per device, less than the AWS line in step 6.

**Scale.** One board per patient is the unit the whole system is sized around. For a fleet made by the hundred thousand, the boards would get their certificates on the factory line instead of from step 12 ([SCALING.md, Provisioning a million boards](SCALING.md#provisioning-a-million-boards)).

[Quick Install Guide, step 0](INSTALL.md#step-0) · [Step map](#step-map) · [1. Install the tools →](#step-1)

<a id="step-1"></a>

## 1. Install the tools

**Why each tool.**

| Tool | What it does here |
|---|---|
| Node.js 22+ | Runs the Lambda tests and `scripts/check.sh`, reads `config/<env>.json` for the deploy scripts, turns the portal's certificate into a key (step 5e), and builds the React portal |
| Salesforce CLI `sf` | Deploys `force-app/`, assigns permission sets, publishes the agents, runs queries |
| AWS CLI 2.32.0+ | Deploys the CloudFormation stacks. 2.32.0 is the first version with `aws login`, the browser sign-in step 4 uses, so no access key is stored on your computer ([AWS docs: Login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)) |
| jq | Reads the JSON the two CLIs print, inside the scripts |
| arduino-cli | Builds and flashes the firmware. `scripts/firmware.sh` wraps it, and the over-the-air pipeline builds with the same script, so the binary you flash and the one the pipeline sends come from one command |
| uv | Runs `uvx mcp-proxy-for-aws`, which signs Claude Code's calls to the MCP server in step 11 |
| GitHub CLI `gh` | Stores the pipelines' secrets and variables in step 14 without a browser |

**The firmware's libraries.** `esp32:esp32` is Espressif's board support for Arduino. `PubSubClient` is the MQTT client that talks to AWS IoT Core, `ArduinoJson` reads commands and builds readings, `DHT sensor library` reads the DHT11, and `ESP32Servo` drives the servo. The repo's own library, `firmware/libraries/CloudAgenticDevice`, is compiled in from the repo: it holds the connection, the Wi-Fi slots, commands, live mode and over-the-air updates ([firmware/README.md](../firmware/README.md)).

**Design choice.** Everything is a command-line tool, so every step is a command you can read, repeat and later automate. There is no installer or wizard to trust blindly, and `scripts/check.sh` skips a part whose tool is missing on a laptop, so you can start with Node alone. In CI a missing tool is an error, since a check that quietly did not run is worse than no check.

[Quick Install Guide, step 1](INSTALL.md#step-1) · [← 0. Order the parts and print the cases](#step-0) · [Step map](#step-map) · [2. Create the AWS project and the Salesforce org →](#step-2)

<a id="step-2"></a>

## 2. Create the AWS project and the Salesforce org

**What it builds.** An AWS **project** on the paid plan with a monthly spend limit, Amazon Bedrock opened in it, and a free Salesforce **Developer Edition** org. Steps 3 to 13 deploy into these two.

<a id="aws-project-or-regular-account"></a>

<a id="why-a-project-and-what-it-costs-you"></a>

**Why a project and not a regular AWS account.** A project has a hard monthly spend limit, from $20: at the limit AWS pauses the project instead of billing more, so a bug or a loop can't run up a large bill. The price is that a project can't hold an IAM identity provider, so GitHub Actions can't sign in to it with OIDC. That is why steps 1 to 13 deploy from your laptop, and step 14 moves to regular accounts for the pipelines:

| | Project with a spend limit | Regular AWS account |
|---|---|---|
| Spending | Capped. AWS pauses the project at the limit | Not capped. A budget alert is the protection |
| Who deploys | You, from your laptop | GitHub Actions, signed in with OIDC |
| GitHub OIDC | Not possible: projects block IAM identity providers | Yes |
| Region | Set by your contact address (a Canadian address gets `us-east-2`) | Your choice |
| Console | Your AWS Builder ID. IAM users are command line only | IAM users with console access and MFA |

**You can't have both in one account.** Activating a project's **advanced features** lifts the OIDC block, but it removes every spend limit for good, and it can't be undone, so they stay off. A regular account can't hand access to a project either, because a project only trusts accounts in its own organization. So the project is deployed from your laptop, and GitHub comes in only with the regular accounts. For the same reason Data Cloud signs in to a project's bucket with an IAM user's access key, not the keyless way (step 9).

**The pipeline never deploys to the project**, so no firmware release reaches its boards on its own: firmware goes to them with `scripts/ota.sh try Dev patient-monitor` (step 12).

<a id="near-the-limit"></a>
<a id="what-happens-near-the-limit"></a>

**What happens near the spend limit.**

- As spending nears the limit, AWS denies Lambda invocations, Bedrock calls and new compute in the project. Readings stop flowing, which is the point.
- At the limit, AWS pauses the project and stops its resources for the rest of that month. Your data is kept. To resume, raise the limit in AWS Settings; some resources may need a manual restart.
- A paused project left untouched for 90 days is deleted, after reminder emails.
- The Home page's AWS spend may stop answering, because it runs on Lambda. The card says so, points to AWS Settings, and shows the last spend it read (a last-known snapshot, kept in Salesforce for exactly this). Its Salesforce half keeps working.
- Deploy changes that add Lambda functions well before the limit: once AWS stops new resource creation, a stack update that adds a function fails.

Sources for the project's behaviour:

- [AWS reimagines the getting started experience](https://aws.amazon.com/blogs/aws/aws-reimagines-the-getting-started-experience/): spend limits from $20, pausing, the 90-day deletion
- [New AWS builder experience (What's New, September 2026)](https://aws.amazon.com/about-aws/whats-new/2026/09/New-AWS-Builder-Experience)
- [Service and resource control policies for projects](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html): the identity-provider block, what is denied near the limit, the organization-only trust
- [Activate advanced features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html): removes spend limits, can't be reversed
- [Project Regions](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html)
- [Connect an AI coding tool](https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html) and [Login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html): `aws login`, CLI 2.32.0, 12-hour sessions

**Why the Bedrock check comes first.** The staff agent's **Find Procedure** action answers from an index of the ward's procedures (SOPs) that Amazon Bedrock builds with **Titan Text Embeddings V2** during step 6. A new account can be held from Bedrock for up to 72 hours, and the playground's "hello" and `get-foundation-model-availability` printing `AUTHORIZED` both prove the hold is lifted before the deploy needs it. The index and why it is built this way: [SOP-GROUNDING.md](SOP-GROUNDING.md).

**Why a Developer Edition org.** It is free, and a new one comes with Agentforce and Data Cloud, which steps 8 to 11 use, with a limited allowance of credits. Its limits shape the design: about 5 MB of data storage and 15,000 API calls a day. That is less than a day of readings at one every 30 seconds, which is one reason Salesforce receives only the readings someone must act on, and AWS keeps the rest ([COST-MODEL.md §6](COST-MODEL.md#6-can-the-whole-build-run-free-nearly--with-four-traps)). Agentforce Voice in the portal's chat needs a licence a Developer Edition lacks, so this install is text chat only ([PATIENT-PORTAL.md](PATIENT-PORTAL.md#why-enhanced-chat-v2-and-not-a-chat-drawn-in-react)).

**Cost.** The whole AWS side costs well under a dollar a month for two boards, inside the lowest spend limit. The org costs nothing.

[Quick Install Guide, step 2](INSTALL.md#step-2) · [← 1. Install the tools](#step-1) · [Step map](#step-map) · [3. Turn on the org's features →](#step-3)

<a id="step-3"></a>

## 3. Turn on the org's features

**Why before the deploy.** The deploy in step 6 builds on each of these features, and none of them can be deployed as metadata: each one accepts terms or can't be turned off again, so it is a click of the org's admin. One pass through Setup, all before the deploy.

| Setting | What uses it |
|---|---|
| **Einstein** and **Agentforce** | Both agents. The staff agent is published in step 6 and the portal agent in step 10; neither publishes without them |
| **Person Accounts** | Each patient is a Person Account, the B2C model where a person is the account. Person Accounts need no licence of their own. A Patient Device Asset must sit on one: the validation rule `Patient_Device_Needs_Person_Account` refuses a business account, so Person Account is made the default record type and the New button offers it first |
| **Digital Experiences**, with **Allow using standard external profiles for self-registration, user creation, and login** | The patient portal is an Experience Cloud site. The second switch lets Salesforce create users on the standard Customer Community User profile: without it, the portal's Apex tests fail with `FIELD_INTEGRITY_EXCEPTION` on `ProfileId`, and so does the deploy. The portal itself has no self-registration: the care team creates each patient's user |
| **Omni-Channel** | Routes the portal's chats: an Omni-Channel flow hands each chat to the portal agent, with `Care_Team_Queue` as the fallback (step 10) |
| **Messaging** | Enhanced Chat, the portal's chat window, runs on a Messaging channel |

Person Accounts can't be turned off once on, which is a reason to turn them on in a fresh org rather than one with years of business accounts. The patient portal needs one Customer Community licence per test patient; step 4 lists how many the org has.

[Quick Install Guide, step 3](INSTALL.md#step-3) · [← 2. Create the AWS project and the Salesforce org](#step-2) · [Step map](#step-map) · [4. Clone and sign in →](#step-4)

<a id="step-4"></a>

## 4. Clone and sign in

**What it builds.** The repo on your computer, an AWS CLI profile and a Salesforce CLI alias, both called `test-cloud-agentic-iot`.

**How the sign-ins work.** `aws login` opens a browser, you sign in to the project, and the CLI stores a session for some hours. **No access key is created**, so there is none on your computer to leak or rotate; when the session expires, you run `aws login` again ([AWS docs: Login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)). `sf org login web` also signs in through the browser and stores a refresh token for the org on disk, so it survives a restart. Neither puts a password in a file or in your shell history.

**Why the Region is set right after the login.** An AWS project works in its own Region only: a command sent to another Region fails with `explicit deny in a service control policy`. Setting it on the profile once means no later command has to name it.

**Why the licence query.** Each patient in the portal (step 10) needs a Customer Community user licence, and the number a Developer Edition comes with varies. Counting them now means step 10 doesn't stop halfway.

[Quick Install Guide, step 4](INSTALL.md#step-4) · [← 3. Turn on the org's features](#step-3) · [Step map](#step-map) · [5. Make what the deploy reads →](#step-5)

<a id="step-5"></a>

## 5. Make what the deploy reads

**What it builds.** Five things that only this org or you can make, which step 6 reads: a certificate and key for AWS to sign in to Salesforce, the integration user AWS signs in as, the External Client App that lets it, a Slack app, and the portal chat's signing certificate.

**Why they come before the deploy.** Step 6 stores the integration user's username, the app's consumer key, the private key and the Slack signing secret in AWS SSM Parameter Store, where the Lambdas read them at runtime. They must exist first. One piece comes after the deploy: the app's policy needs the `Device_Integration` permission set, which lives in the repo and so exists in the org only once step 6 has deployed it. That order is the "chicken and egg" of every new environment ([SETUP.md §2.3](SETUP.md#23-the-bootstrap-order--read-this-before-clicking-anything)).

**a. The integration certificate.** AWS signs in to Salesforce with the **JWT Bearer Flow**: the Lambda signs a short token with `scripts/server-integration.key`, and Salesforce checks it against `server-integration.crt`, uploaded to the app in 5c. No password exists anywhere. The certificate is self-signed, which is fine here because Salesforce trusts exactly the certificate you upload, not a certificate authority. It lasts 10 years (`-days 3650`). `.gitignore` keeps `*.key` and `*.crt` out of Git, and the key stays on your computer until step 6 stores it in SSM.

**b. The integration user.** A separate, least-privilege user for runtime calls, never the admin and never the deploy user ([CI-CD-SECRETS.md](CI-CD-SECRETS.md)). Its **Salesforce Integration** licence and **Salesforce API Only System Integrations** profile allow API access and nothing else, and the profile grants almost nothing: all of its access arrives through the `Salesforce API Integration` permission set licence and the repo's `Device_Integration` permission set. So what it can do is answered by reading one permission set, not by auditing a profile ([SETUP.md §2.2](SETUP.md#22-create-the-two-service-users)). Its email is a plus address of yours, never the admin's, because Slack links people to Salesforce users by email and refuses an address that more than one active user has (step 8).

**c. The External Client App.** The app is what the JWT in 5a signs in through. External Client Apps are the current form of the OAuth apps Connected Apps used to provide, and new orgs have creating legacy Connected Apps switched off. Its scopes are `api` and `refresh_token, offline_access`, enough for the REST calls and nothing more. Salesforce generates the **Consumer Key** when the app is saved, so it can't be in the repo; step 6 asks for it. Its policy, set after the deploy, pre-authorizes only users who hold `Device_Integration`, so the app can't be used by anyone else.

**d. The Slack workspace and app.** A free workspace of your own: slash commands and Agentforce in Slack both work on the free plan, and as its **owner** you can install apps and connect a Salesforce org (step 8), which in a company workspace needs an admin. The app's **Signing Secret** lets AWS prove each request really comes from Slack (step 8).

**e. The portal chat's certificate.** The portal proves to Enhanced Chat who the patient is with a token that Apex signs with this certificate (step 10). **Exportable Private Key** stays off, so the private key never leaves Salesforce: not to you, not to the repo. `scripts/portal-chat-jwk.mjs` turns the downloaded public certificate into the JSON Web Key that Messaging's user verification asks for. The key file is public, but it belongs in Setup, not in the repo.

[Quick Install Guide, step 5](INSTALL.md#step-5) · [← 4. Clone and sign in](#step-4) · [Step map](#step-map) · [6. Deploy everything in one run →](#step-6)

<a id="step-6"></a>

<a id="stage-1--push-to-dev"></a>

## 6. Deploy everything in one run

**What it builds.** Every CloudFormation stack and its real Lambda code in AWS, everything in `force-app/` in Salesforce (the **Cloud Agentic IoT** app, objects, Apex, Flows, the React portal, the agents' actions, permission sets, the queue and its settings), the `AWS_IoT_Relay` credential pieces, your permission sets, and the published Patient Care Agent.

**What `scripts/install.sh` runs, in order.** It only chains scripts that exist on their own, each with its own guards ([`scripts/install.sh`](../scripts/install.sh)):

1. Creates Data Cloud's IAM reader user, `cloud-agentic-iot-data-cloud-reader`, when `DATA_CLOUD_READER_USER` names it. It must exist before the deploy, because S3 refuses a bucket policy that names a user who doesn't exist (step 9).
2. `seed-ssm.sh`. It asks for the integration **username** (5b), the **consumer key** (5c), offers `scripts/server-integration.key` (5a), and asks for the **Slack signing secret** (5d). Nothing you type is shown, and no value passes through a command line: each is written to a private temporary file and handed to the AWS CLI as `file://`. A value you don't have yet is written as `placeholder`, so the stacks still deploy; a value already in SSM is never replaced by a placeholder.
3. `check.sh`, the local tests: Lambda tests, template lint, shellcheck, Salesforce metadata checks, the portal build and a firmware build. The same parts the pull request checks run.
4. `deploy-aws.sh`. It validates every template before deploying any, publishes the clinical bands from `config/vital-thresholds.json` to SSM (the Lambdas read them at runtime, so a change needs no code), checks that every SSM parameter a template reads exists, then deploys each stack as `cloud-agentic-iot-<directory>-Dev`, sized by that directory's section of `config/Dev.json`. It ends by building the SOP index with Bedrock (`scripts/index-sops.sh`), and records the commit it shipped in SSM.
5. `deploy-salesforce.sh`. It builds the React app, then validates and deploys all of `force-app/`. Before anything changes, it checks that the org is the one paired with this AWS account (SSM `/cloud-agentic-iot/salesforce/org-id`, written by the first deploy), so the wrong alias can't deploy over another environment's org. A laptop deploy to Dev skips Apex tests to keep iterating fast; the pipeline, Prod and `--with-tests` always run them.
6. `bootstrap-salesforce.sh`: creates the `AWS_IoT_Relay_Credential` external credential, the `AWS_IoT_Relay` named credential and the `AWS_IoT_Relay_Callers` permission set with this project's URL and Region (step 7 explains them).
7. Gives you `Device_Platform_Admin`, `Platform_Usage_Viewer`, `Patient_Care_Agent`, `AWS_IoT_Relay_Credential_Reader` and `AWS_IoT_Relay_Callers`, gives the integration user `Device_Integration`, and gives the hidden **Automated Process** user `AWS_IoT_Relay_Callers` and the reader, because the queue's platform event trigger runs as that user and calls AWS (step 7d).
8. `publish-agent.sh`: publishes and activates the Patient Care Agent, on a first install only.
9. Prints every value the next steps ask for: the role ARN and URL for step 7, the Slack Request URL, the Data Cloud bucket and folder, and the MCP endpoint and client role.

Every part is safe to run again: a permission set that is already assigned is left alone, one the org lacks is reported, not failed, and what `bootstrap-salesforce.sh` finds is never changed.

**How the AWS side is laid out.** One stack per directory with a `cloudformation.yaml`: `patient-vitals` (the IoT rule, the queues, the ingest and sync Lambdas, the DynamoDB table and the S3 archive), `queue-relay` (the device API on API Gateway, provisioning, commands, live readings, the spend card's function, the device policy and the caller role), `knowledge-indexer` (the SOP index and procedure search), `streaming` (the alert event stream), `mcp-server`, `guardrails`, `slack-integration` and `ota-saga` under `lambda/`, and `alarms` and `ota` under `infra/`. Each account is labelled by its first deploy (SSM `/cloud-agentic-iot/environment`), and every later deploy checks the label, so the wrong `AWS_PROFILE` stops before it changes anything. Function and group names are fixed, which is why Dev and Prod must be separate accounts (step 14).

**Why the agent is published only once.** The Patient Care Agent is written in Agent Script for the new Agentforce Builder (`aiAuthoringBundles/Patient_Care_Agent/Patient_Care_Agent.agent`). Publishing compiles the script into a new agent version, then activates it. A publish replaces the org's agent with the repo's copy, which would drop actions added in Agentforce Builder since, such as the Espressif actions in step 11. So `install.sh` publishes only when the org has no active version, and `REPUBLISH_AGENT=yes` forces it. `publish-agent.sh` also puts `force-app` back to the commit afterwards, because a publish writes generated files (a `bots/` and a `genAiPlannerBundles/` folder) into the checkout, which the next deploy would refuse as uncommitted. The staff agent is an **employee agent**: it acts as the person talking to it, with that person's own sharing and permissions, so it has no agent user of its own. After a change to the `.agent` file, publish again: each publish is a new version.

**The permission sets you get.** The app and the device fields stay hidden until a person holds `Device_Platform_Admin`, System Administrators included, because fields deployed through the Metadata API come with no field access for any profile. `Platform_Usage_Viewer` (with View Setup and Configuration, which System Administrator has) shows the Home page's costs and limits; it is a custom permission rather than a profile, so costs are for admins in every org whatever its profiles are called. `Patient_Care_Agent` opens the agent and gives its actions the device, reading and Case access they run with. Every capability arrives through a permission set, so who can do what is readable in the repo.

**The three follow-ups.**

1. **The app's policy.** **Admin approved users are pre-authorized**, with permission set `Device_Integration`, means the app needs no person to approve a sign-in, and only holders of that set (the integration user) can sign in through it.
2. **The queue.** The deploy creates `Care_Team_Queue`, a Case queue, as metadata; who is on the ward is data, so its members are added in Setup. The agent's escalations and the temperature alert rule's Cases go to the queue `Device_Platform_Setting__mdt.Default` names (`Escalation_Case_Queue__c` and `Room_Temp_Case_Queue__c`), so a queue of another name means changing those two values, not code.
3. **The budget.** The Home page's spend card compares this month's AWS spend with a number, and the spend limit has no API to read it from. So the limit is mirrored in an AWS budget named `cloud-agentic-iot-monthly`, which emails you at 80% of actual spend and when the forecast passes 100%. Reading a budget costs nothing, while Cost Explorer costs $0.01 a read: about $30 a month per account if the page asked it on every load. Cost Explorer stays off unless `SpendCostExplorer` turns it on ([SPEND-AND-LIMITS.md](SPEND-AND-LIMITS.md#why-it-is-built-this-way)). The budget is created in `us-east-1` because the Budgets API is served there for every account.

**What the install leaves off: the Business Value dashboard.** The deploy ships the **Business Value** dashboard, which compares what the platform saves (staff time, chats the agent handled, faster responses) with what it costs (Agentforce and AWS), but the Quick Install Guide doesn't turn it on. It needs two things a deploy doesn't do: the `Business_Value_Viewer` permission set to read its snapshots, and a nightly scheduled Apex job, `ValueSnapshotJob`, that measures the trailing week once a day. A scheduled job is a record in the org, not metadata, so it is started with `System.schedule` rather than deployed. The business owner scenario does both once ([use case scenario 10](TRY-IT.md#scenario-10), [BUSINESS-VALUE.md](BUSINESS-VALUE.md#set-it-up)). Its as-is baseline (minutes a manual check, checks a device a day, the price of a staff hour) is custom metadata, **Value Assumption**, so each org compares against its own numbers.

The Lambda check at the end prints the username AWS signs in to Salesforce as, read from the `salesforce-sync` function's settings. It must be the user from 5b, the one the app's policy allows, or every write to Salesforce fails.

**Design choices.**

- **One script, not a page of commands.** Every piece it calls is the script the pipeline runs, so the first install already exercises the deploy path Prod will use.
- **EventBridge is deliberately not on the per-reading path.** At a million boards it would cost about $86,000 a month at $1 per million events, so readings move through SQS in batches ([SCALING.md](SCALING.md#levers-in-order-of-effect)).
- **MuleSoft is an alternative ingestion path, not part of the install.** `mulesoft/` holds an Anypoint flow that can take the readings instead of the Lambda; chapter 07 explains when that is the right call. Anypoint has only a 30-day trial ([CHAPTERS.md, chapter 07](CHAPTERS.md#07--cross-cloud-integrations-ipaas--mulesoft)).
- **Salesforce gets state changes, not readings.** Of every reading, only a state change, a reminder or a 30 C crossing becomes a `Patient_Vitals__c` record, which keeps the org inside its storage and API limits at any fleet size.

**Security.** Secrets are typed hidden and go straight to SSM. The deploy identities may not create IAM users, access keys or billing changes. The integration user signs in with a key, never a password, and can do only what `Device_Integration` allows. The Salesforce deploy refuses an org that isn't paired with the AWS account, and both deploys refuse uncommitted changes, so what runs is always a commit.

**Scale and cost.** AWS costs about $0.077 a month per monitored device at Prod settings: readings skip IoT messaging through Basic Ingest, and the Lambdas work in batches ([COST-MODEL.md §2](COST-MODEL.md#2-aws--per-device-per-month-usd-us-east-1west-2)). Dev and Prod differ only in `config/<env>.json`: for example Dev takes readings in batches of 100 and Prod in batches of 1,000. [SCALING.md](SCALING.md) carries the same design to a million boards, with a simulation behind it.

[Quick Install Guide, step 6](INSTALL.md#step-6) · [← 5. Make what the deploy reads](#step-5) · [Step map](#step-map) · [7. Let Salesforce call AWS →](#step-7)

<a id="step-7"></a>

<a id="stage-2--connect-the-seams-ci-cannot-reach"></a>

## 7. Let Salesforce call AWS

**What it builds.** One named credential, `AWS_IoT_Relay`, that signs every call from Salesforce to AWS with **AWS Signature Version 4**: device provisioning, re-provisioning and teardown, the Wi-Fi push, Device Commands, the live status card, the ticket gauge's queue depth, the Home page's AWS spend and the agent's Find Procedure. The device API on API Gateway accepts only requests signed by an AWS identity (`AWS_IAM`), so the credential has four parts: an IAM user, an external credential, a named credential and a permission set.

**a. The caller IAM user and its key.** The `queue-relay` stack creates `SalesforceCallerRole`, which may call this API (`execute-api:Invoke` on its `POST` routes) and nothing else. Salesforce reaches it through an IAM user that may only assume that role. The deploy identities may not create users or access keys (`NoBillingNoUsers` in [`scripts/aws-project-policy.json`](../scripts/aws-project-policy.json)), so you make the user once, as an identity that may: your `aws login` profile in a project, root in a regular account. The role trusts the account narrowed by a condition on the user's ARN rather than naming the user as its principal, so the stack deploys before the user exists. The first `echo` must print the role's ARN before anything is created; an empty line means the stack name or the profile's Region is wrong. `create-access-key` prints the key once: type it into Salesforce in part b and nowhere else, not a file, not the repo, not a chat. In Prod the stack is `cloud-agentic-iot-queue-relay-Prod`, and the user's name comes from `SalesforceCallerUserName` in `config/<env>.json`.

**b. The external credential.** `scripts/install.sh` created it in step 6 with your Region. You type the key and the role ARN because Salesforce stores them as credentials, not as metadata a script can deploy. What the external credential holds:

| Setting | Value |
|---|---|
| Authentication Protocol | **AWS Signature Version 4** |
| Service | `execute-api` |
| Region | Your project's Region |
| Obtain Temporary IAM Credentials via STS | On, **IAM User Identified by Access Key** |
| STS Access Key / STS Access Secret | The key from a |
| STS Duration | Empty, or 3600 or less: the role's `MaxSessionDuration` is 3600 |
| Additional Status Codes for Token Refresh | `403` |
| Principal `SalesforceCaller` → IAM Role ARN | The role ARN that step 6 printed. It has `:role/`; the caller user's ARN, with `:user/`, looks much the same, and STS refuses it |

**Why `403` is in the refresh codes.** Salesforce asks STS for a new session only when a call comes back 401 or with one of these codes, and API Gateway answers an expired session with 403. Without it, every call fails from the moment the first session expires, an hour after it was issued.

**Why STS and a role, not the user's key directly.** Each call is signed with a temporary session of a role that can do one thing, so the long-lived key Salesforce holds can do nothing on its own except ask for that session. Rotating the key or narrowing the role changes nothing in Salesforce but the key itself.

**c. The named credential.** Name `AWS_IoT_Relay`, URL = the stack's `QueueDepthEndpoint` output (the API's base URL; Apex adds `/provision-device`, `/device-command` and the other routes), the external credential from part b, and **Enabled for Callouts** and **Generate Authorization Header** both on. The name is a setting, `Named_Credential__c` on `Device_Platform_Setting__mdt.Default`, so an org can use another.

**Why the three pieces live in `bootstrap/`, not `force-app/`.** A deploy sets every value a file names. If the pipeline deployed these files on every merge, it would put placeholder values back over the URL and Region you set. So they ship in [`bootstrap/`](../bootstrap/README.md), outside every package directory, and `scripts/bootstrap-salesforce.sh` creates each one only when the org lacks it, never changes one that exists, and refuses to run in the pipeline. Without the URL and Region options it puts in placeholders (`https://dummy-replace-me.example.com`, Region `us-east-1`) for you to replace in Setup.

**d. Who may use it.** The permission set `AWS_IoT_Relay_Callers` gives **External Credential Principal Access** to the principal `SalesforceCaller` and nothing else, because portal patients hold it too, and their Customer Community licence refuses **Read** on **User External Credentials** ("Read ExternalDataConnector"), which a callout also needs. That Read comes from the repo's `AWS_IoT_Relay_Credential_Reader`, which `deploy-salesforce.sh` gives to every internal holder of `AWS_IoT_Relay_Callers` and to the Automated Process user; `Device_Integration` and `Patient_Portal_Agent` carry it too. A callout runs as the user whose action caused it: a Device Command is sent as the user who created it, a change to an Asset or a Wi-Fi Network as whoever saved it, a live card as whoever opened it. So the set goes to every user whose actions reach a device, to the integration user, to the portal agent's user and to each patient (step 10). The queue's platform event trigger runs as the Automated Process user, which Setup's user list doesn't show, so `install.sh` assigns that one through the API.

`test/config/relay-callers-license.test.js` keeps the Read out of `AWS_IoT_Relay_Callers` and out of the patients' set, and checks that the deploy hands out the reader before it assigns portal users.

**How a call travels.**

```
Apex callout to callout:AWS_IoT_Relay/<route>
  -> Salesforce asks STS (with the caller user's key) for a session of SalesforceCallerRole, kept until it expires
  -> Salesforce signs the request with SigV4 for execute-api in your Region
  -> API Gateway checks the signature (AWS_IAM) and its rate limit
  -> the route's Lambda: device-command, device-provisioning, device-live, aws-spend, procedure-search ...
```

The Home tab's cost card comes through `AWS_IoT_Relay`, so a card that shows this month's spend proves every link of the chain works.

<a id="callout-fails"></a>

**If a callout fails.** `HTTP 0` with *We couldn't get credentials from Amazon Session Token Service* means STS refused the AssumeRole call. CloudTrail's record of it, in the stack's Region, names the cause:

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole \
  --max-results 5 --query 'Events[].CloudTrailEvent' --output text \
  | grep -oE '"(eventTime|errorCode|errorMessage)":"[^"]*"'
```

- `AccessDenied` on the caller user's own ARN (`…:user/cloud-agentic-iot-salesforce-caller`): the principal's **IAM Role ARN** holds the user's ARN. Put the role's there (part b).
- `AccessDenied` on the role's ARN: the user's policy is missing or names another role (part a).
- An error about `DurationSeconds`: **STS Duration** is over 3600 (part b).
- No AssumeRole event within a few minutes: usually a mistyped **STS Access Key** or **STS Access Secret** (part b).

`HTTP 0` with *We couldn't access the credential(s)* means the user making the callout lacks `AWS_IoT_Relay_Callers` or the reader (part d). `HTTP 403: {"message":"Forbidden"}` means API Gateway refused the signed request. If calls worked and then stopped about an hour later, Salesforce is still signing with an expired STS session: add `403` to **Additional Status Codes for Token Refresh** (part b). Otherwise check the Region and Service in part b, and the URL in part c. More causes: [Troubleshooting, Salesforce to AWS](TROUBLESHOOTING.md#salesforce-to-aws-identity-and-permissions).

**Design choices.** One credential for every route keeps one place to rotate, audit and switch off. A keyless alternative is the external credential's **Roles Anywhere** option, which replaces the access key with a certificate and an AWS trust anchor; this repo doesn't set that up yet. Salesforce never stores an AWS key in a custom setting or in code.

**Security, scale and cost.** The key can only ask for a one-hour session of one role, the role can only call this API's `POST` routes, and API Gateway throttles the whole API (`ApiRateLimit` 20 a second and `ApiBurstLimit` 40 in Dev, in `config/<env>.json`). Each Lambda may be invoked only by this API. A call costs one API Gateway request and one Lambda run, fractions of a cent; on the Salesforce side, callouts don't count against the org's daily API requests.

[Quick Install Guide, step 7](INSTALL.md#step-7) · [← 6. Deploy everything in one run](#step-6) · [Step map](#step-map) · [8. Slack →](#step-8)

<a id="step-8"></a>

## 8. Slack

**What it builds.** Two ways to reach the system from Slack: the `/patient-status` slash command, which needs nobody signed in to Salesforce, and the Patient Care Agent as a Slack app the care team can message.

**a. How `/patient-status` works.** Slack sends the command to the Slack Request URL step 6 printed, an API Gateway route in front of the `slack-integration` Lambda. The function checks Slack's signature on every request (an HMAC of the body with the app's signing secret, with a timestamp so an old request can't be replayed), answers within Slack's 3 seconds, then does the work in an asynchronous call of itself and posts the result to the command's `response_url`. The answer has two lines: the live reading from AWS (the newest reading in the patient-vitals table, or "offline since" once it is older than five minutes), and the last event Salesforce saved, read as the integration user through the same JWT sign-in AWS uses everywhere. If either side can't be read, the other still answers and the reply says which part is missing ([CHAPTERS.md, chapter 04](CHAPTERS.md#04--headless-slack-integration)). The usage hint `PatientExternalESP32` is the monitored device's name from step 12.

**b. How the agent in Slack works.** Connecting the org to Slack lets Slack pass a member's messages to Agentforce as that member's Salesforce user. Slack finds the user by **email**, so each Slack member's email must match exactly one active Salesforce user; that is why every service and test user has its own plus address. Members are added individually, so each is linked to the user you choose. Each needs two permission sets: `SlackSalesCloud` (Sales Cloud for Slack), which gives the Slack capabilities, and `Patient_Care_Agent`, which opens the agent. The agent's own permission set alone is not enough: Slack then answers "You don't have permission to message this app" ([Troubleshooting, Slack](TROUBLESHOOTING.md#slack)). Because it is an employee agent, it answers in Slack with exactly the access the member has in Salesforce.

**Design choices.** The slash command is **headless**: a Slack user never signs in to Salesforce, so the integration user's access, not each nurse's, decides what it can read, which is why it is read-only. The agent is the opposite: each member's own user, so its answers respect their sharing. Both together show the two patterns an integration can take.

**Security.** A request without Slack's valid signature is refused before any work. The signing secret lives in SSM, read at runtime. The slash command reads and never writes.

**Cost.** Each `/patient-status` costs two Lambda runs and one DynamoDB query (well under a thousandth of a cent) and one Salesforce API call for the last saved event. The live reading never touches Salesforce's daily API limit. The agent in Slack costs agent actions like any other channel.

[Quick Install Guide, step 8](INSTALL.md#step-8) · [← 7. Let Salesforce call AWS](#step-7) · [Step map](#step-map) · [9. Data Cloud →](#step-9)

<a id="step-9"></a>

## 9. Data Cloud

**What it builds.** Every reading from every board in **Data Cloud** (Data 360), Salesforce's platform for large volumes, as the `Room_Readings` data model object. Step 12c then adds two calculated insights per device: how long it read at or above 30 C each day, and when it last sent anything. The staff agent's **Get Device History** reads both, and the raw readings, so a nurse can ask whether a device has been running hot all week.

**The path.**

```
patient-vitals Lambda
  -> S3 archive  readings/date=.../hour=.../  (gzipped NDJSON, every reading, for Athena)
  -> S3 archive  datacloud/room-readings/     (the same readings as CSV, Dev: DataCloudExport on)
       -> Amazon S3 connection -> data stream -> data lake object Room_Readings
            -> mapping -> data model object Room_Readings -> calculated insights
```

**Why a second copy, in CSV.** Data Cloud's Amazon S3 connector reads CSV or Parquet files, and ignores files in subfolders of the folder a stream reads. The archive is gzipped NDJSON in day and hour folders, built for Athena. Rather than change a format other readers rely on, the Lambda writes a copy shaped for Data Cloud: one flat folder, the day and hour in the file name (no colons, which Data Cloud refuses), a header row, and a missing value as nothing, so a failed sensor read loads as null, not 0. Both writes must succeed, or the batch is retried. The CSV files stay 30 days (`DataCloudExportRetentionDays`): they are only Data Cloud's pickup folder ([DATA-CLOUD.md](DATA-CLOUD.md#why-a-second-copy-in-csv)).

**1. The reader user and its key.** `cloud-agentic-iot-data-cloud-reader` has no IAM policy of its own. The archive bucket's policy (`ArchiveBucketPolicy` in [`lambda/patient-vitals/cloudformation.yaml`](../lambda/patient-vitals/cloudformation.yaml)) gives it three permissions, the three Salesforce lists for an S3 source, and only when `DATA_CLOUD_READER_USER` named it in step 6:

| Action | Resource | Condition |
|---|---|---|
| `s3:GetBucketLocation` | the archive bucket | none |
| `s3:ListBucket` | the archive bucket | `s3:prefix` like `datacloud/*` |
| `s3:GetObject` | `<bucket>/datacloud/*` | none |

It can't write, delete, read `readings/` or call any other AWS service, and the bucket accepts it over TLS only. To see that it holds nothing else: `aws iam list-attached-user-policies --user-name cloud-agentic-iot-data-cloud-reader` and `aws iam list-user-policies --user-name cloud-agentic-iot-data-cloud-reader` both print empty lists. Its key is typed into the Data Cloud connection and nowhere else.

**Why a key here, and a role in the pipelines.** A role is the better design: Data Cloud gets a token from the org's own identity provider and assumes `cloud-agentic-iot-data-cloud-reader` as a role that trusts only the connection whose External ID it names, with no secret anywhere. An AWS project can't hold an IAM identity provider, so the key is the only way in step 9; step 14 uses the role in regular accounts ([DATA-CLOUD.md, How Data Cloud signs in to AWS](DATA-CLOUD.md#how-data-cloud-signs-in-to-aws)).

**2 to 4. The connection, the stream and the mapping.** Why each setting:

| Setting | Why |
|---|---|
| **Parent Directory** `datacloud/room-readings/` | The only folder the reader may list |
| Source name `AWS_IoT` | Data Cloud builds API names from it, so it must be letters, digits and single underscores, and unique in the org |
| Data lake object `Room_Readings`, typed fields | `reading_ts` and `received_ts` as DateTime and the two measurements as Number, so the insights can compare and sum them |
| Date format `yyyy-MM-dd'T'HH:mm:ss.SSSXXX` | The Lambda writes timestamps with JavaScript's `toISOString()`, such as `2026-11-19T18:00:00.123Z`. `XXX` reads the literal `Z` as UTC; a bare `Z` expects `+0000` and fails |
| Category **Engagement**, event time `reading_ts` | Readings are time-stamped events, which is what the Engagement category is for |
| Primary key `reading_id`, refresh **Upsert** | `reading_id` is `<device>-<timestamp>`, the same id as `Patient_Vitals__c.Device_Reading_Id__c`, so a reading delivered twice is one row |
| The most frequent refresh schedule | The insights are only as fresh as the stream's last refresh |
| Mapping to a data model object of the same name | The data model object is the shape every Data Cloud feature reads, whatever source the data came from |

**Why by hand, and not in `force-app/`.** Salesforce documents one way to move Data Cloud configuration between orgs: build it in an org, add it to a **data kit**, and retrieve the kit. The connection's credential never travels. And `scripts/deploy-salesforce.sh` deploys all of `force-app/` at once, so one refused Data Cloud component would fail the whole deploy, Apex and agent included ([DATA-CLOUD.md](DATA-CLOUD.md#why-the-data-cloud-side-is-not-in-force-app)). The calculated insights are an exception: each is one Connect REST API call, so a script creates them from SQL in the repo (step 12c).

**5. Who may ask for history.** Get Device History queries Data Cloud as the person asking, and the `Patient_Care_Agent` permission set can't grant Data Cloud access, so each asker holds the standard **Data Cloud User** permission set ([DATA-CLOUD.md, How the agent reads it](DATA-CLOUD.md#how-the-agent-reads-it)).

**Design choices.**

- **SQL, not a search index, for history.** "How long was it at or above 30 C yesterday" is a question about numbers over time. A search index would chunk and embed readings and leave the model to count minutes, at a cost that grows with the fleet (2,880 rows a device a day). The action sends three Data Cloud SQL queries and returns a summary line the agent quotes as written; the model never adds readings up itself.
- **Insights for trends, not alarms.** A stream and an insight each run on a schedule, so the newest hour or two may be missing. Live signals stay where they are: a board's Connection on its Asset changes within seconds, and a high reading opens a Case through the temperature alert rule.

**Security.** The reader can read one folder and nothing else. Get Device History looks the Asset up first as the person asking, so a device they can't see gets the same answer as one that doesn't exist, and Data Cloud is not asked. A serial number must match `^[A-Za-z0-9_-]{1,64}$` before it is written into the SQL, because the query API takes no bind variables.

**Cost.** In AWS: one more S3 PUT per batch and 30 days of CSV storage, cents a month for a ward. In Salesforce: rows ingested and insight runs count against the org's Data Cloud credits, which the org's consumption pages show. Each history question is one agent action, about $0.10, plus query credits ([COST-MODEL.md §9](COST-MODEL.md#9-device-history-for-the-staff-agent-get-device-history)).

[Quick Install Guide, step 9](INSTALL.md#step-9) · [← 8. Slack](#step-8) · [Step map](#step-map) · [10. Patient portal with Enhanced Chat →](#step-10)

<a id="step-10"></a>

## 10. Patient portal with Enhanced Chat

**What it builds.** A React site on Salesforce where a patient signs in, sees the readings of their own monitored device on **My monitor**, and chats with the **Patient Portal Agent**, which sees only that patient's devices and can send the care team a nurse request. The deploy in step 6 already brought the site, the React app, the Apex, the agent's actions and the permission sets. This step does the Setup pieces Salesforce keeps out of metadata.

**How the patient is proven, end to end.**

```
Patient signs in to the site -> the React app runs as the patient
  GET  /portal/my-devices  -> PortalIdentityService.forCurrentUser(): User.AccountId = their Person Account -> their devices only
  POST /portal/chat-token  -> a JWT {iss, sub = the patient's User Id, exp = 5 min}, signed RS256 in Apex with Patient_Portal_Chat
Enhanced Chat v2 -> setIdentityToken(JWT) -> Messaging checks it against the keyset (the certificate's public key)
Patient Portal Agent (runs as its agent user)
  Get My Devices / Request a Nurse -> PortalIdentityService.forMessagingSession(RoutableId): verified? active portal user? -> that AccountId
```

An Agentforce **service agent** runs as its own agent user, not as the patient, so sharing rules describe the agent user and say nothing about who is chatting. The patient therefore comes from the conversation itself, and only if Messaging verified the token. The Agent Script binds each action's session input to the `RoutableId` variable, so the model never supplies the patient. Another patient's device answers "No device X is linked to your account", the same answer as for a device that doesn't exist, and the Apex tests prove it with two patients ([PATIENT-PORTAL.md](PATIENT-PORTAL.md#how-the-patient-is-proven-end-to-end)).

**What each item does.**

1. **Chat deployment.** An Enhanced Chat web deployment on the site's `*.my.site.com` domain, with its own Messaging channel. **Switch to V2** because only Enhanced Chat v2 supports Agentforce Voice, for an org licensed for it later.
2. **User verification.** The JSON Web Key from 5e goes into a keyset with the issuer `cloud-agentic-iot-patient-portal` (the setting's `Issuer__c`), and the channel requires it. From then on an unverified conversation gets nothing from the agent.
3. **The agent user.** The service agent's own user, licence **Einstein Agent**. Its four permission sets let it run as an Agentforce service agent, use prompt templates, and run the portal agent's Apex. `publish-portal-agent.sh` writes this username into the Agent Script for the publish only, then puts the repo's placeholder back, because the username differs in every org. The agent is published, not deployed: Salesforce compiles the script into the agent with its version and planner. `deploy-portal-routing.sh` fills the agent's, the channel's and the queue's Ids into the Omni-Channel flow `Route_Patient_Portal_Chat` and deploys it; the flow lives in `salesforce-templates/portal-routing/` with placeholders, because its Route Work action stores org-specific Ids. The agent user also needs `AWS_IoT_Relay_Callers`, so the chat can fetch the device's newest reading from AWS.
4. **Routing.** The channel hands each chat to the flow, which gives it to the agent, with **Care Team Queue** as the fallback, so a chat is never dropped.
5. **The site's chat link.** The chat URL differs in every org, so it is not in `force-app/`. `set-portal-chat-url.sh` deploys a copy of `Patient_Portal_Setting.Default` that names only `Chat_Site_Url__c`; later deploys from `force-app/`, which don't name that field, keep it.
6. **CORS.** The chat script on the portal fetches its configuration from the messaging host (`*.salesforce-scrt.com`), which answers only origins on the org's CORS list. The deploy already ships the Trusted URLs for that host.
7. **Guest user.** The sign-in page runs before anyone is signed in, as the site's guest user, so `Patient_Portal_Guest_Api` lets it call only the sign-in Apex.
8. **Patients.** Salesforce enables a portal user only on an account whose owner has a role ("portal account owner must have a role"), so you take the deployed role **Care Team Administrator**. Each patient is a Person Account with their own plus address and a Customer Community user. `Patient_Portal_User` gives site access and the API access the React app's calls need; `AWS_IoT_Relay_Callers` lets **My monitor** take live readings from AWS.
9. **Try it.** "I need a nurse" proves the whole chain at once: the verified chat, the agent, its action and the queue.

**Why two agents and not one.** An agent has exactly one type. An employee agent can't sit on a public chat channel, and a service agent's sharing describes its agent user, not the person chatting. Two agents give a hard boundary instead of a judgement call: staff never reach the portal agent from Salesforce, and a staff user who signs in to the portal chat counts as unverified and is pointed to the Patient Care Agent ([PATIENT-PORTAL.md](PATIENT-PORTAL.md#why-two-agents-and-not-one)).

**Why Enhanced Chat v2 and not a chat drawn in React.** Agentforce Voice runs only in Salesforce's own Enhanced Chat v2 window on an Enhanced Web Chat channel. A chat drawn in React would talk to the Messaging REST API as a custom client and lose Salesforce voice. So the React site embeds Enhanced Chat, and every other part of the page is React.

**Why Customer Community, not Customer Community Plus.** A patient sees only their own account's records, so the portal needs no roles or sharing rules; Plus costs more and adds nothing the portal uses.

**Security.** The patient is proven by a 5-minute token signed with a key that never leaves Salesforce, checked by Messaging, and scoped in Apex to one Person Account. A patient never sees an internal board or another account's device. The model never chooses whose data it reads. Live readings come from AWS IoT with a short, narrow link that can only subscribe to one board's live topic for 15 minutes.

**Scale and cost.** An open **My monitor** tab costs 1 Salesforce API call plus 6 an hour, not 120, because live readings come straight from AWS IoT ([SCALING.md](SCALING.md#salesforce-api-calls-per-device)). The licence dominates the cost: about $10 per member a month, or $4 per login for patients who sign in rarely, plus about $0.10 per agent action. In a Developer Edition it costs nothing within its allowance ([COST-MODEL.md §7](COST-MODEL.md#7-patient-portal-react-site-enhanced-chat-and-agentforce-voice)).

[Quick Install Guide, step 10](INSTALL.md#step-10) · [← 9. Data Cloud](#step-9) · [Step map](#step-map) · [11. MCP servers →](#step-11)

<a id="step-11"></a>

## 11. MCP servers

**What it builds.** The Model Context Protocol in both directions. In **a**, the ward's devices become MCP tools that Claude Code (or any MCP client) can call. In **b**, both agents become MCP clients of Espressif's open servers, so anyone can ask a generic ESP32 question in Lightning, Slack or the portal.

**a. Our MCP server in Claude Code.** `lambda/mcp-server` is an MCP server over Streamable HTTP, answered as plain JSON with no session, so each request stands alone and a Lambda can answer it. Its tools:

| Tool | What it does |
|---|---|
| `get_room_status` | One monitored device: newest reading and when, online or stale, its state, and whether a high temperature alert is open |
| `list_rooms_out_of_range` | Every device at or above 30 C, with an open alert, or gone quiet for `OfflineAfterMinutes` (5) |
| `send_device_command` | `RESTART`, `CASE_ALERT` or `SET_TELEMETRY_INTERVAL` to one device, through the guardrails |

The tool names still say "room"; they are renamed later. Its function URL's auth type is **`AWS_IAM`**: Lambda checks each request's SigV4 signature before the code runs. MCP clients don't sign SigV4 themselves, so AWS's open-source **MCP Proxy for AWS** (`uvx mcp-proxy-for-aws-cli`) runs locally as a stdio MCP server and signs each request with your `test-cloud-agentic-iot` profile. The stack also creates `McpClientRole`, which may call this URL and nothing else, for a client that should hold no other rights ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#the-mcp-server)).

**Why the guardrails sit where they do.** Every command to a board, from Salesforce or from the MCP server, ends in the `device-command` Lambda, which runs `checkCommand` from `lambda/shared/guardrails.js` before it publishes anything. The rule set fails closed: only the five commands a board takes, only each command's own fields, only the ranges the firmware accepts, at most 200 devices a request. An agent outside Salesforce gets a narrower profile: three commands, one device at a time, and never `WIFI_UPDATE`, which carries credentials. The alternatives were weighed:

| Option | Why not |
|---|---|
| A guardrails Lambda in front of `device-command` | A second hop inside Salesforce's callout timeout, one more thing to fail, and `device-command` could still be invoked around it |
| Calling the guardrails from Apex before each callout | Each caller has to remember; one forgotten call means no guardrails |
| Guardrails in the agent's prompt | A prompt is a request, not a control |

The MCP server's own role may read the patient-vitals table and invoke `device-command`, and has no `iot:Publish`, so it can't reach a board around the guardrails. `maskPii` and `checkOutput` run on every tool answer. In Salesforce, the agent's Get Device Readings masks the device's name and disconnect reason, and Find Procedure the passages it returns ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#guardrails-where-they-run-and-why-there)).

<a id="espressif-mcp"></a>

**b. Espressif's MCP servers in both agents.** ESP Pilot answers which chips ESP-IDF supports and Espressif's board catalog; the ESP Component Registry answers which drivers and components exist. **Nobody signs in**, so the patient agent can use them too.

- **Read-only.** Only the five tools in the table are allowlisted, and the ESP32 subagents have no device, procedure, escalation or nurse action.
- **No org data leaves.** The subagents send Espressif only generic terms (a chip, board or component name), never a patient, a serial number, a reading or a Case number. Because no one signs in, Espressif sees only Salesforce's servers, not who asked.
- **Grounded.** The subagents answer from the tools and a short reference card, and link to `docs.espressif.com` for the rest, never from memory. Agentforce turns any link whose host is not in the org's Trusted URLs into `URL_Redacted`, so the deploy ships Espressif's two hosts as Trusted URLs.
- **Not chosen:** Espressif's documentation server would answer full datasheet specs, but it needs each user to sign in with GitHub or WeChat and allows 40 searches an hour, so it could serve employee agents only, never the portal ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#espressif-mcp-servers-for-the-agents)).

**Why the agents are retrieved into the repo afterwards.** The actions are added in Agentforce Builder, so the repo's `.agent` files don't have them yet. `sf project retrieve start` writes them back to `force-app/`, and once committed, a later publish keeps them instead of dropping them (step 6). `config/mcp-servers.json` records what each org registers.

**Cost.** Our MCP server costs a Lambda run per request; `list_rooms_out_of_range` scans the table and is capped by `MaxRoomsScanned` (500 in Dev). Espressif's servers are free; each answer costs one or two agent actions, about $0.15 a question ([COST-MODEL.md §8](COST-MODEL.md#8-espressif-mcp-servers-for-the-agents)).

[Quick Install Guide, step 11](INSTALL.md#step-11) · [← 10. Patient portal with Enhanced Chat](#step-10) · [Step map](#step-map) · [12. Add the boards →](#step-12)

<a id="step-12"></a>

<a id="stage-3--hardware"></a>

## 12. Add the boards

**What it builds.** For each board: an AWS IoT **Thing** named after its serial number, a certificate and private key of its own, a place in a Thing Group for over-the-air updates, the firmware, and its Wi-Fi networks. Then, once readings flow, Data Cloud's two calculated insights.

**One firmware, two roles.** Both boards run `firmware/patient-monitor` 1.0.0. The Asset's **record type** decides what a board is for, not the code: a **Patient Device** (the monitored device) sweeps its servo while its own DHT11 reads 30 C or more, and an **Internal Device** (the corp ticket gauge) ignores its own sensor and follows `Care_Team_Queue`, sweeping while at least one open Case is in it, faster as the queue deepens (`Full_Speed_Depth__c` 5 in `Device_Queue_Binding__mdt`). Apex turns the queue depth into a 0 to 100 intensity before it leaves Salesforce, so the firmware stays simple and the business rule stays where an admin can change it ([CHAPTERS.md, chapter 03](CHAPTERS.md#03--physical-case-queue-indicator)). Step 12 is split per device because the two are wired differently: the gauge has no sensor.

**How an Asset becomes a provisioned board.**

1. You create a **Wi-Fi Network** record: the SSID, and the passphrase in an Encrypted Text field.
2. You create the **Asset**: Serial Number = the Thing name, the record type, the Account, the Wi-Fi Network. A Patient Device needs a Person Account, an Internal Device a business account such as your ward.
3. `AssetTrigger` calls `DeviceProvisioningService`, which calls AWS through `AWS_IoT_Relay` (step 7).
4. The `device-provisioning` Lambda creates the Thing and a certificate, attaches the `cloud-agentic-iot-device` policy, adds the Thing to its group (`fleet-patient-monitor` or `internal-devices`), writes the bundle to S3 (encrypted, AES-256) and returns a **15-minute pre-signed link**. If a step fails, it undoes what it did, so a failed attempt leaves only an empty Thing.
5. The Asset turns **Provisioned** with the link and its expiry.

**Why the private key never lands in Salesforce.** AWS returns a device's private key exactly once. Routing it through Salesforce would put a device identity into every CRM backup, export and report. So the bundle goes to S3, Salesforce stores only the link, its expiry and the certificate id, and the bundle bucket deletes the file after `BundleRetentionDays` (1). The block deletes your downloaded copy as soon as the board has it ([CHAPTERS.md, chapter 13](CHAPTERS.md#13--device-provisioning-automation)).

**Why flash first, then send the bundle.** A blank ESP32's ROM bootloader speaks serial and nothing else: no Wi-Fi, no TLS, no MQTT. So `firmware.sh flash` writes the firmware over USB, the firmware boots, finds no identity and waits on serial, and `provision-device.sh` sends the bundle. The script restarts the board, waits for it to ask, and sends the bundle in small paced pieces, because the ESP32 holds only a few hundred bytes between reads, and a character lost inside the certificate or key would still be stored, once. The board writes it to its **NVS** flash, reboots and connects ([DEVICE-IDENTITY.md](DEVICE-IDENTITY.md#why-the-firmware-has-to-be-flashed-first)).

**Why nothing secret is compiled in.** Wi-Fi belongs to the location and the certificate to the device, so neither is in the binary. One `.bin` serves every board of its type, which is what lets one over-the-air job update a whole fleet. Over-the-air updates rewrite the application partition only; NVS is a separate partition, so the identity and Wi-Fi survive every update. The only thing that destroys them is `esptool erase_flash`, which no script runs. If it happens, the Asset's **Re-provision** button rotates the certificate and keeps the Thing and all its history.

**Why the hotspot goes in second.** NVS holds three networks, tried in the order they were added, and only the third is ever overwritten. So the first two are permanent anchors: your desk Wi-Fi, then your phone's hotspot. Because the board can almost always reach AWS through the hotspot, the third slot can be changed remotely from the Wi-Fi Network record, with no USB. An LRU policy would let a venue's Wi-Fi push out the hotspot, and the board would be unreachable the first time that happened ([DEVICE-IDENTITY.md, What the 3 slots actually do](DEVICE-IDENTITY.md#what-the-3-slots-actually-do)).

**What the device policy allows.** `cloud-agentic-iot-device` uses the policy variable `${iot:Connection.Thing.ThingName}`, so one policy serves every board and each is scoped to its own topics: it can connect only as the Thing its certificate is attached to (`iot:Connection.Thing.IsAttached`), publish its readings through Basic Ingest, its status, its live readings and its command answers, and subscribe only to its own command topic and its own jobs. A board can't read another board's commands, which carry Wi-Fi passphrases, or publish as another patient.

**12c. The insights.** `scripts/data-cloud-insights.sh` creates the two insights from the SQL in [`datacloud/calculated-insights.json`](../datacloud/calculated-insights.json), each with its schedule: **Room Device Silence** (each board's last reading time) every hour, **Room Out Of Range Daily** every 6 hours, to spend fewer Data Cloud credits. They wait for the boards because Data Cloud checks the SQL against the data model object and refuses an insight over fields it has no data for yet. `--dry-run` prints each request first. An insight that exists is left as it is.

**The videos.** The assembly animations are renders of the printed cases in [`docs/videos/`](videos/): `assembly-monitored-device.mp4` and `assembly-corp-gauge.mp4`, each with a `.jpg` poster frame. A real video saved under the same name replaces a render with no page edit. Step 13 shows two more renders the same way.

<a id="create-the-thing-and-its-certificate"></a>

<details markdown="1">
<summary><strong>The same identity by hand, without Salesforce</strong>: what the Asset automates, worth doing once to understand it</summary>

This is the path the Asset automates. The Quick Install Guide never uses it; `scripts/setup-device.sh` exists for a certificate made this way.

**1. Create a Thing.** AWS IoT Core → Manage → Things → Create things → Create single thing. Name it, for example, `ESP32-Patient-Monitor-01`: the name becomes the device's identity. Choose *Auto-generate a new certificate*.

**2. Create the policy.** Secure → Policies → Create policy, named `ESP32-Patient-Monitor-Policy`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:REGION:ACCOUNT_ID:client/${iot:ClientId}" },
    { "Effect": "Allow", "Action": "iot:Publish",
      "Resource": [
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/$aws/rules/cloud_agentic_iot_patient_vitals/device/${iot:Connection.Thing.ThingName}/telemetry",
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/telemetry",
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/status",
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/live",
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/ack",
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*"
      ] },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:REGION:ACCOUNT_ID:topicfilter/device/${iot:Connection.Thing.ThingName}/command",
        "arn:aws:iot:REGION:ACCOUNT_ID:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*"
      ] },
    { "Effect": "Allow", "Action": "iot:Receive",
      "Resource": [
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/device/${iot:Connection.Thing.ThingName}/command",
        "arn:aws:iot:REGION:ACCOUNT_ID:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*"
      ] }
  ]
}
```

Replace `REGION` and `ACCOUNT_ID`. Readings go to the `$aws/rules/cloud_agentic_iot_patient_vitals/...` topic, Basic Ingest, which hands them straight to the rule. The `status` topic is where an Internal Device reports back, `live` carries live readings while someone has its card open, and `ack` answers commands. The `$aws/things/.../jobs/*` lines are over-the-air updates. None is optional: IoT Core disconnects a client that publishes to a topic its policy doesn't allow, and without the jobs lines the board reconnects in a loop, since the firmware asks for pending jobs every time it connects. This hand-made policy keys `iot:Connect` on the client id; the stack's `cloud-agentic-iot-device` policy also requires the certificate to be attached to the Thing it connects as, which is the stricter of the two.

**3. Download and attach.** Download the certificate, the private key and Amazon Root CA 1 into one folder, and attach the policy to the certificate.

**4. Create the Salesforce Asset** in the Cloud Agentic IoT app, with Serial Number = the Thing name and the patient's Person Account. Its Connection field, Live Status card and **Send Command** need a device provisioned from Salesforce, whose Asset carries its Thing ARN, so on a hand-made one they stay empty.

**5. Flash and send the credentials** with the wizard, which compiles, flashes over USB, sends the credentials and prints what the board says back:

```bash
./scripts/setup-device.sh
```

It asks for the folder with the downloaded files, the Thing name, the endpoint and the Wi-Fi, filling in a default wherever it can, and shows everything (passphrase masked) before it writes, because the `identity` namespace is write-once. The Windows wizard still sends the credentials in one burst without waiting for the board to ask, which can store a damaged identity; use the macOS or Linux one. Then add your hotspot with `./scripts/update-wifi.sh "<hotspot-SSID>"`, as in the Quick Install Guide.

</details>

**Scale and cost.** This is the one-device-at-a-time pattern, automated: it scales to hundreds, because nothing is manual except a USB cable. AWS allows about 10 new certificates a second, so a million boards would take 28 hours of calls; at that size, **fleet provisioning by claim** replaces the bundle, with the same Things, groups and over-the-air updates ([SCALING.md](SCALING.md#provisioning-a-million-boards)). After an outage, boards reconnect with a random backoff that doubles from 1 second to 5 minutes, which asks AWS for 57 times fewer connections than retrying every second ([SCALING.md, Reconnect storms](SCALING.md#reconnect-storms)). Later firmware goes over the air: `scripts/ota.sh try Dev patient-monitor`.

[Quick Install Guide, step 12](INSTALL.md#step-12) · [← 11. MCP servers](#step-11) · [Step map](#step-map) · [13. Check that it works →](#step-13)

<a id="step-13"></a>

<a id="stage-4--verify-end-to-end"></a>

## 13. Check that it works

**Why in this order.** Start at the device and walk outward: a break is easiest to find at the first hop that goes quiet. The board's own serial console comes first:

```bash
scripts/firmware.sh monitor
```

Expect the Wi-Fi and AWS IoT connection lines, then a reading line every 30 seconds (or at the interval the fleet set). Then each check below proves one hop:

| Check | Where | Expect | What it proves |
|---|---|---|---|
| The board is publishing | S3 → the patient-vitals archive bucket, `readings/date=<today>/` | A new `.ndjson.gz` object for each batch | The certificate, the policy, Basic Ingest, the rule, the queue and `patient-vitals`. Readings skip the broker, so the MQTT test client doesn't show them |
| The board is online | The board's Asset in the Cloud Agentic IoT app | Connection `Online`, and a reading every 2 s on the Live Status card | AWS IoT's presence events reach Salesforce, and the live link reaches your browser ([LIVE-STATUS.md](LIVE-STATUS.md)) |
| Costs and limits show | The app's Home tab | This month's AWS spend against the limit, and the org's limits | `AWS_IoT_Relay` signs calls (step 7) and the budget exists (step 6) |
| The board takes commands | On the Asset, **Send Command** → `RESTART` | The Device Command goes `Sent`, then `Acked` | Apex, the device API, the guardrails, the command topic, and the board's answer on its `ack` topic |
| A high temperature opens a Case | Warm the DHT11 to 30 C, for example under an arm | The monitored device's servo sweeps within about 5 s, and a Case `High temperature ... C on <device>` with Origin `Room Temperature Rule` opens in Care_Team_Queue | The board's own rule, and AWS flagging the crossing to Salesforce |
| The loop closes | The corp ticket gauge | It sweeps and rings while the Case is open, and stops when it is closed | Salesforce driving a motor: trigger, platform event, callout, IoT |
| The agent reads and cites | The agent panel: "What is PatientExternalESP32 reporting?", then what to do | The latest readings, then steps cited "per SOP-WARD-001" | Get Latest Device Readings and Find Procedure through Bedrock ([SOP-GROUNDING.md](SOP-GROUNDING.md)) |
| The agent knows the history | "How long was PatientExternalESP32 at or above 30 C yesterday?", the day after step 12 | An answer from Data Cloud, with a note that the newest hour or two may be missing | The stream, the insights and Data Cloud User (step 9) |
| Hardware questions | Any agent: "What is the spec of the ESP32-S3-DevKitC-1?" | An answer from Espressif's catalogs, with a docs.espressif.com link | The MCP actions and Trusted URLs (step 11) |
| Slack is headless | `/patient-status PatientExternalESP32` | The live reading, with nobody signed in to Salesforce | The signed Slack request and the JWT integration user (step 8) |
| The portal | Signed in as the patient | Their own device, and the assistant answering "what is my temperature?" | The verified chat and the patient's scoping (step 10) |

**How the temperature alert rule works.** A demo rule, not a clinical one. **AWS decides when, Salesforce decides what**: the threshold lives once, as `RoomTempAlertCelsius` in `config/<env>.json` (30, inclusive), and AWS reports a device on the crossing and then at most every `RealertIntervalMinutes` while it stays high, never per reading. An episode ends only below 29 C, so a sensor wobbling around 30 C is one report. Salesforce opens one Case per device from this rule, and only after it is closed does the next report open a new one. The board's own servo follows its own sensor, every 5 s, with no Case or network, so it reacts in seconds and works offline. `RoomTempAlert` is on in Dev and off in Prod, and adding `PatientVitalsTriggerHandler` to `Integration_Control__c` Bypass Handlers stops it at once, with no deploy ([CHAPTERS.md, Temperature alert demo rule](CHAPTERS.md#temperature-alert-demo-rule)).

**After this step.** The Quick Install Guide's step 13 is a short check that the system is alive. Every feature, tested one real situation at a time with what you should see, is in [After install: use case scenarios](TRY-IT.md).

<div align="center" class="cta" markdown="1">

[![Test every feature: After install, use case scenarios](images/test-every-feature-button.svg)](TRY-IT.md)

</div>

**Why the checks are manual and also automated.** These checks are what a person sees. The same behaviour is pinned by tests that run on every pull request: the firmware contract, the guardrails, the fleet simulation, the Apex tests with two patients, and the agents' Testing Center specs in `test/agents/`, which `scripts/eval-agents.sh` and the **Agent evals** workflow run against an org ([AGENT-EVALS.md](AGENT-EVALS.md)).

[Quick Install Guide, step 13](INSTALL.md#step-13) · [← 12. Add the boards](#step-12) · [Step map](#step-map) · [14. Dev and Prod pipelines →](#step-14)

<a id="step-14"></a>

<a id="stage-5--promote-to-prod"></a>

## 14. Dev and Prod pipelines

**What it builds.** Two environments, each with its own branch, GitHub Environment, regular AWS account and Salesforce org, deployed by GitHub Actions. The names are case-sensitive and must match exactly:

| | Dev | Prod |
|---|---|---|
| Branch | `Dev`, the default branch (already exists) | `Prod`, created from `Dev`, changed only by pull requests from `Dev` |
| GitHub Environment | `Dev` | `Prod`, with you as the required reviewer |
| AWS account | A regular account (not a project), `ca-central-1` | A second regular account |
| Salesforce org | A new Developer Edition org | A separate org |
| A push deploys when | `AUTO_DEPLOY` contains `Dev` | `AUTO_DEPLOY` contains `Prod`, and you approve the run |
| Boards | Every Dev board, in `fleet-<type>` | `canary-<type>` first, then `fleet-<type>` |

**Why regular accounts, and why two.** A project can't hold GitHub's OIDC provider, which the pipeline signs in to AWS with. Function and group names are fixed, so two environments in one account would overwrite each other; separate accounts also mean separate IoT certificate authorities, so a Dev board physically can't connect to Prod. Stacks and certificates don't move between accounts, so each board is provisioned again against the new one ([DEVELOPMENT.md](DEVELOPMENT.md#the-two-environments)).

**1. The account, as root.** Root turns on MFA and creates one IAM user, `iot-operator`, with the `cloud-agentic-iot-operator` policy from [`scripts/aws-project-policy.json`](../scripts/aws-project-policy.json). From then on root is not used. The policy denies billing, account and Organizations changes and creating IAM users or access keys, so even the operator can't hand out new keys.

**2. The deploy role and the budget.** `bootstrap-aws.sh` deploys `infra/bootstrap/github-deploy.yaml`: the GitHub OIDC provider, the `github-actions-deploy` role that trusts only this repository's GitHub Environment of the same name, its `cloud-agentic-iot-deploy` policy, and the `cloud-agentic-iot-monthly` budget the Home page shows. It runs from a laptop because the pipeline can't create the role it signs in with. **No long-lived AWS key exists anywhere**: each workflow run presents a signed OIDC claim and gets a short-lived session ([CI-CD-SECRETS.md](CI-CD-SECRETS.md#the-model)).

**3. The org's service users.** Each environment's org gets the same integration user and app as step 5, and a **deploy user** the pipeline signs in as, with its own certificate and External Client App. Salesforce sign-in is the JWT Bearer Flow again, so no password exists anywhere. The deploy user is a **System Administrator** deliberately: Apex tests run as whoever deploys, two tests create a Queue as fixture data, and creating a Queue can't be granted by any narrower permission; reworking those tests to inject queues would allow a least-privilege deploy user ([SETUP.md §2.3](SETUP.md#23-the-bootstrap-order--read-this-before-clicking-anything)). `Metadata_Deploy` lives in `scripts/`, not `force-app/`, because the deploy user needs it before the first deploy can run.

**4. GitHub secrets and variables.** `setup-github-secrets.sh` creates the environment, limits it to its branch (so only `Prod` can read Prod's secrets), makes you Prod's reviewer, and asks for each value, hiding secrets and base64-encoding the key files itself. Secret values never pass through a browser, an automated agent or a chat. Every value, per environment (Settings → **Environments** → `Dev` or `Prod`):

| Name | Kind | Value, and where it comes from | Set by the script? |
|---|---|---|---|
| `AWS_ROLE_ARN` | Secret | `DeployRoleArn` of the bootstrap stack (2) | Yes, read from the stack |
| `AWS_REGION` | Variable | `ca-central-1` | Yes |
| `ALARM_EMAIL` | Variable | Who the CloudWatch alarms email | Yes |
| `SF_CONSUMER_KEY` | Secret | Consumer key of `Cloud Agentic IoT Deploy` (3) | Yes |
| `SF_USERNAME` | Secret | `deploy@iot-dev.<yourdomain>` (3) | Yes |
| `SF_JWT_KEY` | Secret | `scripts/server-deploy.key`, base64-encoded (3) | Yes, from the file |
| `SF_LOGIN_URL` | Variable | `https://login.salesforce.com` | Yes |
| `SF_INTEGRATION_CONSUMER_KEY` | Secret | Consumer key of `Cloud Agentic IoT Integration` (5c) | Yes |
| `SF_INTEGRATION_USERNAME` | Secret | `integration@iot-dev.<yourdomain>` (5b) | Yes |
| `SF_INTEGRATION_JWT_KEY` | Secret | `scripts/server-integration.key`, base64-encoded (5a) | Yes, from the file |
| `SLACK_SIGNING_SECRET` | Secret | The Slack app's signing secret (5d) | Yes |
| `DATA_CLOUD_OIDC_PROVIDER_ARN` | Variable | The provider ARN from the Data Cloud commands | **No, by hand** |
| `DATA_CLOUD_EXTERNAL_ID` | Variable | The Data Cloud connection's External ID, with **Identity Provider (IdP) Based** | **No, by hand** |

And on the repository (Settings → **Secrets and variables** → **Actions** → **Variables**):

| Name | Kind | Value | Set by the script? |
|---|---|---|---|
| `AUTO_DEPLOY` | Variable | `Dev`, later `Dev Prod`: which branches deploy on a push | Yes, when you answer `y` |
| `EVAL_DEVICE`, `EVAL_OTHER_DEVICE`, `EVAL_PATIENT_USERNAME` | Variable | For the **Agent evals** workflow: the test patient's board, a board that is not the patient's (the corp ticket gauge), and the test patient's username | **No, by hand** |

The evals need a board that is not the patient's to prove the portal agent refuses it.

**Data Cloud in a regular account** reads the bucket with a role and no key: an IAM identity provider for the org's My Domain (`/services/connectors`), and the stack's `cloud-agentic-iot-data-cloud-reader` role, which trusts only the connection whose External ID it names (step 9).

**5. The first run, then the switch.** The first deploy is a manual run of the **Deploy** workflow, so you watch it before anything deploys on its own; then the app's policy and steps 7 to 13 run against this org and account, as before. `AUTO_DEPLOY` is the switch that lets a push deploy, and it names branches, so Dev can deploy on every push while Prod's secrets aren't in yet ([DEVELOPMENT.md, Turning it on](DEVELOPMENT.md#turning-it-on)).

**What the workflows do.**

| Workflow | Trigger | What it does |
|---|---|---|
| `checks.yml` | every pull request | `scripts/check.sh`, one job per part: Lambda tests, cfn-lint, shellcheck, Salesforce metadata, the portal build, a firmware build. It also fails a firmware change that doesn't raise `FIRMWARE_VERSION` |
| `deploy.yml` | a push to `Dev` or `Prod` once `AUTO_DEPLOY` names the branch, or by hand | The checks on that commit, then AWS (`deploy-aws.sh`), Salesforce (`deploy-salesforce.sh`, with Apex tests) and the boards (`ota.sh release`: every Dev board, or the Prod canary ring). Prod waits for your approval |
| `ota-promote.yml` | by hand, Prod | Sends a release the canary ran cleanly to the whole Prod fleet, one device type at a time. It refuses unless that version's canary job updated a board and none failed |
| `fleet-interval.yml` | by hand | Changes the reading interval for a whole device type with one job |
| `agent-evals.yml` | by hand | Runs the agents' Testing Center specs against an org |

**Conventions the pipelines enforce**, because each would otherwise fail at deploy time rather than when the change is written:

- A Lambda's `FunctionName` in CloudFormation must be `cloud-agentic-iot-<source directory name>`, or the source upload can't find the function it belongs to.
- A sketch folder must contain a `.ino` named after the folder, or `arduino-cli` reports "main file missing from sketch".
- A sketch must declare `#define FIRMWARE_VERSION`, and raise it to ship a change. A board installs only a version it isn't already running.

**Deploy order for a new field AWS writes.** The pipeline deploys AWS before Salesforce. A change that adds a field AWS writes (such as `Room_Temperature_Alert__c`) would then have AWS sending it before Salesforce knows it, and Salesforce refuses those records with `INVALID_FIELD`. So such a change ships in two pushes: first with the AWS side switched off in `config/Dev.json`, then a push that turns it on. On a laptop, deploy Salesforce first, then AWS. The sync queue retries a refused record 5 times before its dead-letter queue, and `SyncDeadLetterAlarm` fires, so nothing is lost quietly ([Troubleshooting](TROUBLESHOOTING.md#install-steps)).

<a id="moving-to-the-pipelines"></a>

**Moving from the project.** Stacks don't move between accounts: the regular account gets new resources, a new IoT endpoint and new certificates, so provision each board again against it. Keep the project for trying changes from your laptop; the pipelines never touch it. If you'd rather not keep it, copy anything you want out of its S3 buckets and DynamoDB table, then delete its `cloud-agentic-iot-*` stacks, or close the project. Its budget can also come from the bootstrap stack without the GitHub role: `GITHUB_OIDC=no BUDGET_USD=20 BUDGET_EMAIL='<your email>' scripts/bootstrap-aws.sh Dev` (not tried in a project yet; if it fails with AccessDenied, use the budget command in step 6).

**6. Prod.** Prod is the same sequence against the second account and org, with two human checkpoints: you approve each Prod deploy, and you promote a firmware release from the canary boards to the whole fleet once the canary behaved. The one irreversible part is moving boards: Dev certificates can't connect to Prod, so re-provisioning the fleet is batched and comes last ([MIGRATION-RUNBOOK.md](MIGRATION-RUNBOOK.md)).

**7. Branch rules.** A pull request and green checks are required on both branches, so nothing reaches an environment without passing the same checks you ran on your laptop.

**Cost.** Both accounts and the GitHub workflows add next to nothing at this size: the AWS side is well under a dollar a month per account for a few boards, plus CloudWatch's few dollars of logs and alarms ([COST-MODEL.md §2](COST-MODEL.md#2-aws--per-device-per-month-usd-us-east-1west-2)). Each account's budget emails before it is spent.

**Installed. Now test what you built:**

<div align="center" class="cta" markdown="1">

[![Test every feature: After install, use case scenarios](images/test-every-feature-button.svg)](TRY-IT.md)

</div>

[Quick Install Guide, step 14](INSTALL.md#step-14) · [← 13. Check that it works](#step-13) · [Step map](#step-map) · [Docs home](index.md)

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
