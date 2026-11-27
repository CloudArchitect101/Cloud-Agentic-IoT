# Detailed Install Guide: every step, explained

> [!TIP]
> New here? [Start here](START-HERE.md) shows which guide to follow. The [Quick Install Guide](INSTALL.md) is the one list of steps; this page goes deeper.

This is the long version of the install: each step, plus **why** it is done that way and what to check when it fails. Want only the commands? Use the [Quick Install Guide](INSTALL.md); [Quick Install Guide, explained](#quick-install-explained) below follows its numbering. Want to know what you are installing first? Read [How the pieces connect](HOW-IT-CONNECTS.md), or the [README](../README.md) for the one-page overview.

Two ways to run it, same code:

| Path | Where it deploys | Start with |
|---|---|---|
| **Try it** | Your own AWS project with a spend limit (advanced features **not** activated: activating them removes the spend limit for good) and a free [Developer Edition org](https://developer.salesforce.com/signup), deployed from your laptop | [TRY-IT.md](TRY-IT.md), then Stages 2 to 4 below |
| **Pipelines** | Separate Dev and Prod AWS accounts and Salesforce orgs, deployed by GitHub Actions | [SETUP.md](SETUP.md), then every stage below |

**The whole system deploys once, in one sequence.** Work top to bottom; each stage assumes the previous one is done. Nothing here is per-chapter — the chapters explain what these pieces do, they do not install separately.

| Stage | What | How long |
|---|---|---|
| 0 | Prerequisites — [`docs/SETUP.md`](SETUP.md), including turning on Einstein and Agentforce in each org before its first deploy | Once, ~a day |
| 1 | Push to `Dev` → AWS, Salesforce and the Dev boards deploy automatically | Minutes |
| 2 | Connect the seams CI cannot reach (Named Credentials, Slack, Data Cloud, agent) | ~an hour |
| 3 | Hardware — create the Thing, flash and provision each device | ~20 min per device |
| 4 | Verify end to end | Minutes |
| 5 | Promote `Dev` → `Prod` when it all holds | Per [MIGRATION-RUNBOOK.md](MIGRATION-RUNBOOK.md) |

<a id="quick-install-explained"></a>

## Quick Install Guide, explained

The [Quick Install Guide](INSTALL.md) is commands only. This is the why behind each of its steps, in the same numbering. When a step shows something else than it says, see [If a Quick Install Guide step goes differently](TROUBLESHOOTING.md#install-steps).

**The name `test-cloud-agentic-iot`.** The Quick Install Guide calls the AWS CLI profile and the Salesforce CLI org alias `test-cloud-agentic-iot`, so every block pastes as it is. The name lives only on your computer: no AWS resource or Salesforce record is named after it (bucket names use the account ID and Region), so two people using the same name never collide. Any name of letters, digits and `-` works. Every `sf` command names its org with `--target-org "$NAME"`, so a command always goes to that org.

**What a new terminal keeps** (the resume lines):

| What | After a restart |
|---|---|
| `NAME`, `AWS_PROFILE`, `SF_TARGET_ORG` (step 4) | **Gone.** Run the resume lines |
| `sf` org login (step 4) | Kept on disk. Nothing to do |
| `aws login` session (step 4) | Kept on disk for some hours. On a new day, run `aws login --profile "$NAME"` once |
| Variables set inside one command block (`ACCOUNT`, `LIMIT`, `EMAIL`, `STACK`, `CALLER`, `ROLE_ARN`, `INTEGRATION_USER`, `MEMBER`, `AGENT_USER`, `PATIENT_USER`, `CRT`, `BUNDLE`, `MCP_URL`, `REGION`, `MY_DOMAIN`) | Used only in that block. In a new terminal, run the whole block again |
| Pipelines (step 14): `AWS_PROFILE=iot-dev`, `SF_TARGET_ORG=iot-dev-admin` | **Gone.** Run their `export` lines again |
| Files you made: keys in `scripts/`, the portal key in `~/Downloads` | Kept. Nothing to do |

**Step 0. Parts and cases.** Every part is chosen for the code and the cases in this repo: the 38-pin ESP32 (about 55 x 28 mm) fits the hub's board bay and the gauge's cradle, the firmware reads the DHT11 on P4 and drives the servo on P5, and the bare 4-leg DHT11 fits the cuff's sensor pocket, which a breakout board does not. The bare sensor needs the 10 kΩ pull-up between its legs 1 and 2, so a soldering iron is on the list; nothing else is soldered. The packs hold spares: a DHT11 can fail after weeks of use, and three sensors cost less than one replacement shipped. Both boards run from one 2-port USB charger with a USB cable each, and the same cables flash them in step 12. The bell is iron, 36 mm across, open at the bottom, and hangs from a loop: the 36 mm hanger in the print files holds it so the needle's hammer strikes its rim. Kit cost: about CA$127 plus tax for both devices, plus about CA$20 for a spool of PLA, so about CA$75 per device. The photos in the parts table are freely licensed stand-ins ([credits](images/parts/CREDITS.md)).

The print files hold the default set: the cuff for a 27 to 31 cm upper arm (`r46`), the bell on the left of the gauge and the 36 mm hanger. For another arm size (`r40` for 24 to 27 cm, `r52` for 31 to 35 cm), or a servo that turns clockwise and needs the `bell-right` parts, swap that part in the slicer: every part is also a single STL in [`hardware/cases/stl`](https://github.com/CloudArchitect101/Cloud-Agentic-IoT/tree/Dev/hardware/cases/stl). The [cases README](https://github.com/CloudArchitect101/Cloud-Agentic-IoT/tree/Dev/hardware/cases) explains each part, how to check the servo's direction before printing, and the assembly. PLA is enough, since nothing gets hot and nothing flexes; PETG or ABS also work. No part needs supports. The dial plate's art is raised in three steps (3.4, 3.8 and 4.2 mm): painting the tops is simplest, and a printer that changes filament mid-print can print them in colour instead.

**Step 2. The AWS project and the org.** A project on the paid plan has a hard monthly spend limit (the lowest is $20). Its advanced features stay off: activating them removes the spend limit for good, and they matter only for GitHub OIDC, which the pipelines (step 14) use with regular AWS accounts. Why a project, and what it costs: [TRY-IT.md](TRY-IT.md#why-a-project-and-what-it-costs-you). The Bedrock check comes first because the agent's Find Procedure answers from an SOP index that Amazon Bedrock builds (Titan Text Embeddings V2), and a new account can be held from Bedrock for up to 72 hours. A new Developer Edition org comes with Agentforce and Data Cloud (Data 360), which steps 8 to 11 use. Agentforce Voice in the portal's chat needs a licence a Developer Edition lacks, so the Quick Install Guide leaves it out ([PATIENT-PORTAL.md](PATIENT-PORTAL.md)).

**Step 3. The org's features.** One pass through Setup, all before the deploy. Each switch accepts terms or can't be turned off, so it is a click of yours, and the deploy in step 6 builds on it. The patient portal needs one Customer Community licence per test patient; step 4 lists them once the terminal knows your org.

**Step 4. Region.** An AWS project works in its own Region only: a command sent to another Region fails with `explicit deny in a service control policy`. So the profile is set to the project's Region right after the login.

**Step 5. What the deploy reads.** The one-time setup in [`bootstrap/`](../bootstrap/README.md) (the `AWS_IoT_Relay` named credential, its external credential and the `AWS_IoT_Relay_Callers` permission set) needs no step of its own: `scripts/install.sh` runs it in step 6, with your URL and Region. The integration user (5b) and its External Client App (5c) are made in Setup, because each holds something only this org can make: a username in your domain with its own licence, and a consumer key that Salesforce generates when the app is saved and that step 6 asks for. The access key and role ARN in step 7 are typed by hand too, since Salesforce stores them as credentials, not as metadata a script can deploy. The integration certificate is how AWS signs in to Salesforce (JWT), never with a password; `.gitignore` keeps `*.key` and `*.crt` out of Git. The External Client App's consumer key exists as soon as the app is saved; its policy gets the permission set after the deploy (step 6). The Slack workspace is your own and free: slash commands and Agentforce in Slack both work on the free plan, and as its **owner** you install apps and connect a Salesforce org (steps 8a and 8b), which in a company workspace needs an admin. The portal's chat key (5e) is a public key: it goes to Salesforce in step 10, never to the repo.

**Step 6. What `install.sh` does.** [`scripts/install.sh`](../scripts/install.sh) runs, in order:

1. Creates Data Cloud's IAM reader user, `cloud-agentic-iot-data-cloud-reader`.
2. `seed-ssm.sh`. It asks for the integration **username** (5b), the **consumer key** (5c), offers `scripts/server-integration.key` (5a), and asks for the **Slack signing secret** (5d). Type the values; nothing is shown.
3. `check.sh`, the local tests.
4. `deploy-aws.sh`: every stack, the guardrails, the MCP server, the Slack stack and the SOP index for the agent.
5. `deploy-salesforce.sh`: the app, the React portal, the agents' actions, the permission sets.
6. `bootstrap-salesforce.sh`: creates the `AWS_IoT_Relay_Credential` external credential, the `AWS_IoT_Relay` named credential and the `AWS_IoT_Relay_Callers` permission set with this project's URL and Region, and leaves the access key and the role ARN for you to type in step 7.
7. Gives you `Device_Platform_Admin`, `Platform_Usage_Viewer`, `Patient_Care_Agent`, `AWS_IoT_Relay_Credential_Reader` and `AWS_IoT_Relay_Callers`, and gives the integration user `Device_Integration`.
8. `publish-agent.sh`: publishes and activates the Patient Care Agent.
9. Prints every value the next steps ask for: the role ARN and URL for step 7, the Slack Request URL, the Data Cloud bucket and the MCP endpoint.

Every part is safe to run again. The budget gives the Home page's spend card a number to compare with: it equals the spend limit and emails you at 80% and when the forecast passes 100%. The Lambda check prints the username AWS signs in to Salesforce as, which must be the user from 5b and the one the app's policy allows.

**Step 7. The `AWS_IoT_Relay` credential.** One named credential, `AWS_IoT_Relay`, signs every call from Salesforce to AWS (provisioning, commands, the live card, the Home page's spend, the agent's Find Procedure) with AWS Signature Version 4. `scripts/install.sh` created the external credential in step 6 with your Region; the access key and the role ARN are typed in Setup because Salesforce stores them as credentials, not as settings a file can carry. Why a script and not the pipeline: the files are in [`bootstrap/`](../bootstrap/README.md), outside what the pipeline deploys, so no later deploy can put a placeholder back over your values. The IAM user from 7a can do one thing: assume the role step 6 made. Its key is printed once and typed only into Salesforce. What the script fills in on the external credential:

| Setting | Value |
|---|---|
| Authentication Protocol | **AWS Signature Version 4** |
| Service | `execute-api` |
| Region | Your project's Region |
| Obtain Temporary IAM Credentials via STS | On, **IAM User Identified by Access Key** |
| STS Access Key / STS Access Secret | The key from a (you typed it just now) |
| STS Duration | Empty, or 3600 or less |
| Additional Status Codes for Token Refresh | `403` |
| Principal `SalesforceCaller` → IAM Role ARN | The role ARN that step 6 printed (you typed it just now) |

`AWS_IoT_Relay_Callers` gives **External Credential Principal Access** to the principal and nothing else, because portal patients hold it too, and their Customer Community licence refuses **Read** on **User External Credentials**. That Read, which a callout also needs, comes from the repo's `AWS_IoT_Relay_Credential_Reader`, which `deploy-salesforce.sh` gives to every internal holder of `AWS_IoT_Relay_Callers`. The Home tab's cost card comes through `AWS_IoT_Relay`, so it proves the credential works.

**Step 9. Data Cloud's reader user.** Nothing of its own: it has no IAM policy. The archive bucket's policy (`ArchiveBucketPolicy` in [`lambda/patient-vitals/cloudformation.yaml`](../lambda/patient-vitals/cloudformation.yaml)) gives it three permissions, and only when `DATA_CLOUD_READER_USER` named it:

| Action | Resource | Condition |
|---|---|---|
| `s3:GetBucketLocation` | the archive bucket | none |
| `s3:ListBucket` | the archive bucket | `s3:prefix` like `datacloud/*` |
| `s3:GetObject` | `<bucket>/datacloud/*` | none |

It cannot write, delete, read `readings/` or call any other AWS service, and the bucket accepts it over TLS only. To see that it holds nothing else: `aws iam list-attached-user-policies --user-name cloud-agentic-iot-data-cloud-reader` and `aws iam list-user-policies --user-name cloud-agentic-iot-data-cloud-reader` both print empty lists. The agent's **Get Device History** action queries Data Cloud as the person asking, and the `Patient_Care_Agent` permission set can't grant Data Cloud access, so each asker holds the standard **Data Cloud User** set ([DATA-CLOUD.md](DATA-CLOUD.md#how-the-agent-reads-it)).

**Step 10. The portal.** The deploy brings the site, the React app, the Apex, the agent's actions and the permission sets; the Setup steps are the ones Salesforce keeps out of metadata. The portal agent user needs `AWS_IoT_Relay_Callers`, and so does each patient, so the chat and the **My monitor** page fetch the board's newest reading from AWS. `set-portal-chat-url.sh` stores the chat URL in the org's `Patient_Portal_Setting.Default` record; later deploys keep it, because the repo's copy of the record does not name that field.

**Step 11. MCP servers.** **a.** lets Claude Code reach your devices; **b.** lets every agent answer generic ESP32 questions, with no sign-in. Background: [GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#espressif-mcp-servers-for-the-agents).

**Step 12. The boards.** Step 12 is split per device (12a the monitored device, 12b the corp ticket gauge) because the two boards are wired differently: the gauge has no sensor. Both run the same firmware. The assembly animations are renders of the printed cases in [`docs/videos/`](videos/): `assembly-monitored-device.mp4` and `assembly-corp-gauge.mp4`, each with a `.jpg` poster frame. A real video saved under the same name replaces a render with no page edit. Each board's Serial Number becomes its identity in AWS IoT (letters, digits, `-` and `_`). The bundle holds the board's private key, so the block deletes it once the board has it. Later firmware updates go over the air: `scripts/ota.sh try Dev patient-monitor`. Each insight is created with its schedule from [`datacloud/calculated-insights.json`](../datacloud/calculated-insights.json): Room Device Silence (each board's last reading time) every hour, Room Out Of Range Daily every 6 hours, to spend fewer Data Cloud credits. Change one there, or on the insight in Data Cloud. The insights wait for the boards because Data Cloud computes them from the readings the stream (step 9) has taken in.

**Step 14. Dev and Prod.** Two environments, each with its own branch, GitHub Environment, AWS account and Salesforce org. The names are case-sensitive and must match exactly:

| | Dev | Prod |
|---|---|---|
| Branch | `Dev`, the default branch (already exists) | `Prod`, created from `Dev` in 6 below, changed only by pull requests from `Dev` |
| GitHub Environment | `Dev` | `Prod`, with you as the required reviewer |
| AWS account | A regular account (not a project), `ca-central-1` | A second regular account |
| Salesforce org | A new Developer Edition org | A separate org |
| A push deploys when | `AUTO_DEPLOY` contains `Dev` | `AUTO_DEPLOY` contains `Prod`, and you approve the run |

Why regular accounts: a project can't hold GitHub's OIDC provider, which the pipeline signs in to AWS with. Stacks don't move between accounts, so each board is provisioned again against the new one.

`bootstrap-aws.sh` creates the OIDC provider, the `github-actions-deploy` role and the `cloud-agentic-iot-monthly` budget, and offers to store the role's ARN as `AWS_ROLE_ARN`. `setup-github-secrets.sh` creates the environment, limits it to its branch, makes you Prod's reviewer, and asks for each value below, hiding secrets and base64-encoding the key files itself. Data Cloud in a regular account reads the bucket through the org's identity provider, with no key. Why each piece stays manual: [DEVELOPMENT.md](DEVELOPMENT.md#what-stays-manual-and-why).

Every value, per environment (Settings → **Environments** → `Dev` or `Prod`):

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
| `DATA_CLOUD_OIDC_PROVIDER_ARN` | Variable | For Data Cloud: the provider ARN from the commands below | **No, by hand** |
| `DATA_CLOUD_EXTERNAL_ID` | Variable | For Data Cloud: the connection's External ID (9, step 2, with **Identity Provider (IdP) Based**) | **No, by hand** |

And on the repository (Settings → **Secrets and variables** → **Actions** → **Variables**):

| Name | Kind | Value | Set by the script? |
|---|---|---|---|
| `AUTO_DEPLOY` | Variable | `Dev`, later `Dev Prod`: which branches deploy on a push | Yes, when you answer `y` |
| `EVAL_DEVICE`, `EVAL_OTHER_DEVICE`, `EVAL_PATIENT_USERNAME` | Variable | For the **Agent evals** workflow: the test patient's board, the corp ticket gauge, the test patient's username | **No, by hand**, below |

## Stage 1 — Push to `Dev`

Push to `Dev` and GitHub Actions deploys **everything at once**: every CloudFormation stack and the real Lambda code, all Salesforce metadata in `force-app/`, and any firmware whose version went up, over the air to the Dev boards. Each step is a script you can run from your laptop as well; [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) walks the whole path from laptop to Dev to Prod.

| Workflow | Trigger | What it does |
|---|---|---|
| `checks.yml` | every pull request | `scripts/check.sh`, one job per part: Lambda tests, cfn-lint, shellcheck, Salesforce metadata, a firmware build. Also fails a firmware change that does not raise `FIRMWARE_VERSION` |
| `deploy.yml` | push to `Dev`/`Prod` once `AUTO_DEPLOY` names the branch, or manual | Checks on that commit, then AWS (`scripts/deploy-aws.sh`), Salesforce (`scripts/deploy-salesforce.sh`) and the boards (`scripts/ota.sh release`: every Dev board, or the Prod canary ring). Prod waits for your approval |
| `ota-promote.yml` | manual, Prod | Sends a release the canary ran cleanly to the whole Prod fleet, one device type at a time |

Three conventions the pipelines enforce, because each would otherwise fail at deploy time rather than author time:

- A Lambda's `FunctionName` in CloudFormation must be `cloud-agentic-iot-<source directory name>`, or the source-upload step cannot find the function it belongs to.
- A sketch folder must contain a `.ino` named after the folder, or `arduino-cli` reports "main file missing from sketch".
- A sketch must declare `#define FIRMWARE_VERSION`, and raise it to ship a change. A board installs only a version it is not already running.

**Then give yourself the interface.** The Salesforce deploy adds a Lightning app, **Cloud Agentic IoT**, with tabs, record pages and page layouts for devices (Assets), patient vitals, device commands and Wi-Fi networks, and the Re-provision button on a device, and its Home page, which shows the month's AWS spend and the org's limits to admins. The app and the device fields stay hidden until a person holds the `Device_Platform_Admin` permission set, System Administrators included: fields deployed through the Metadata API come with no field access for any profile. Assign it to each person who runs the devices, then open the app from the App Launcher:

```bash
sf org assign permset --name Device_Platform_Admin --target-org <your admin alias>
```

Admins who should see costs need Platform_Usage_Viewer too (and View Setup and Configuration, which System Administrator has); the AWS half also needs part d of Stage 2:

```bash
sf org assign permset --name Platform_Usage_Viewer --target-org <your admin alias>
```

## Stage 2 — Connect the seams CI cannot reach

Everything below is manual for a structural reason, not an oversight: it stores a secret, lives in another vendor's console, or is a deliberate human checkpoint. Do it once, in this order — later steps consume outputs from earlier ones.

**1. Named Credential `AWS_IoT_Relay`.** This one credential carries every Salesforce → AWS callout in the system: the queue indicator, device provisioning, re-provisioning, teardown, the Wi-Fi credential push, Device Commands, the live status card and the Home page's AWS spend. The device API accepts only requests signed by an AWS identity, so it takes four parts.

*a. The IAM user Salesforce holds a key for.* The `queue-relay` stack creates `SalesforceCallerRole`, which may call this API and nothing else. Salesforce reaches it through a user that may only assume that role. The deploy identities may not create users or access keys (`NoBillingNoUsers` in [`scripts/aws-project-policy.json`](../scripts/aws-project-policy.json)), so make the user once, by hand, as an identity that may: your `aws login` profile in an [AWS project](TRY-IT.md), root in a regular account. In your own terminal, with the `-Prod` stack in Prod and `CALLER` set to `SalesforceCallerUserName` from `config/<env>.json`:

```bash
STACK=cloud-agentic-iot-queue-relay-Dev
CALLER=cloud-agentic-iot-salesforce-caller
ROLE_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='SalesforceCallerRoleArn'].OutputValue" --output text)
echo "$ROLE_ARN"
aws iam create-user --user-name "$CALLER" > /dev/null
aws iam put-user-policy --user-name "$CALLER" --policy-name assume-salesforce-caller-role \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Resource\":\"$ROLE_ARN\"}]}"
aws iam create-access-key --user-name "$CALLER"
echo "IAM Role ARN for part b: $ROLE_ARN"
```

The first `echo` must print the role's ARN before anything is created; an empty line means the stack name or the profile's Region is wrong. `create-access-key` prints the key once. Type it into Salesforce in part b and nowhere else: not a file, not the repo, not a chat. The last line repeats the role ARN for part b.

*Parts b to d as files.* The external credential, the named credential and the permission set ship in [`bootstrap/`](../bootstrap/README.md) with placeholder values, and [`scripts/bootstrap-salesforce.sh`](../scripts/bootstrap-salesforce.sh) creates each one the org lacks:

```bash
scripts/bootstrap-salesforce.sh <your admin alias> --url <QueueDepthEndpoint> --region <Region>
```

`scripts/install.sh` runs it with the stack's values. It never changes a piece that exists, it refuses to run in the pipeline, and the folder is outside every package directory, so no deploy can put a placeholder back over what you set. Without the two options the placeholders go in (`https://dummy-replace-me.example.com`, Region `us-east-1`) for you to replace in Setup. Either way the **STS Access Key**, the **STS Access Secret** and the principal's **IAM Role ARN** are yours to type in Setup: Salesforce stores them as credentials, not as metadata, so no file or option holds them. Parts b to d below say what each piece is, and how to make it by hand in an org where the script cannot.

*b. The external credential.* Setup → Named Credentials → External Credentials → New. Authentication Protocol **AWS Signature Version 4**, Service `execute-api`, Region = the stack's Region. Check **Obtain Temporary IAM Credentials via STS**, choose **IAM User Identified by Access Key**, and enter the key as the **STS Access Key** and **STS Access Secret**. Leave **STS Duration** empty, or at 3600 seconds or less, the role's maximum. Set **Additional Status Codes for Token Refresh** to `403`. Salesforce asks STS for a new session only when a call comes back 401 or with one of these codes, and API Gateway answers an expired session with 403. Without it, every call fails from the moment the first session expires, an hour after it was issued. Then add a principal whose **IAM Role ARN** is the stack's `SalesforceCallerRoleArn` output, the line part a printed last. That is the role, with `:role/` in it. The caller user's ARN, with `:user/`, looks much the same, and STS refuses it.

*c. The named credential.* Named Credentials → New. Name `AWS_IoT_Relay`, URL = the stack's `QueueDepthEndpoint` output (the API's base URL; Apex adds `/provision-device`, `/queue-depth` and the other routes), the external credential from part b, and **Enabled for Callouts** and **Generate Authorization Header** both on. The name is a setting, `Named_Credential__c` on `Device_Platform_Setting__mdt.Default`, so an org can use another.

*d. Who may use it.* The permission set `AWS_IoT_Relay_Callers` gives **External Credential Principal Access** to the principal from part b (the script names it `SalesforceCaller`, on the external credential `AWS_IoT_Relay_Credential`). Give it nothing else. A call also needs **Read** on the **User External Credentials** object (without it: "You don't have read permissions on the User External Credential object"), but never put that Read in this set: portal patients hold it too, and the Customer Community licence refuses the permission ("Read ExternalDataConnector"), so no patient could be given the set. The repo's `AWS_IoT_Relay_Credential_Reader` carries the Read, and `deploy-salesforce.sh` gives it to every internal holder of this set and to the Automated Process user. `Device_Integration` and `Patient_Portal_Agent` carry it too. Assign it to every user whose changes to Assets, Wi-Fi Networks or Cases should reach the devices, to everyone who sends Device Commands or opens a device's live status card, and every admin who views the Home page's usage card, to the integration user the Slack app signs in as, and to the integration user AWS writes readings as, portal patients and the portal agent's user (`deploy-salesforce.sh` assigns it to those once the set exists): a Device Command is sent as the user who created it, and a Case that moves the queue indicator as whoever saved it. The queue indicator's platform event trigger runs as the Automated Process user, which Setup's user list doesn't show, so assign it to that user through the API. The query picks it by its `autoproc@` username, because other hidden system users share its user type:

```bash
sf apex run --target-org <your admin alias> <<'EOF'
insert new PermissionSetAssignment(
    AssigneeId = [SELECT Id FROM User WHERE UserType = 'AutomatedProcess' AND Username LIKE 'autoproc@%' LIMIT 1].Id,
    PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'].Id);
EOF
```

*If a callout fails.* `HTTP 0` with *We couldn't get credentials from Amazon Session Token Service* means STS refused the AssumeRole call. CloudTrail's record of it, in the stack's Region, names the cause:

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole \
  --max-results 5 --query 'Events[].CloudTrailEvent' --output text \
  | grep -oE '"(eventTime|errorCode|errorMessage)":"[^"]*"'
```

- `AccessDenied` on the caller user's own ARN (`…:user/cloud-agentic-iot-salesforce-caller`): the principal's **IAM Role ARN** holds the user's ARN. Put the role's there (part b).
- `AccessDenied` on the role's ARN: the user's policy is missing or names another role (part a).
- An error about `DurationSeconds`: **STS Duration** is over 3600 (part b).
- No AssumeRole event within a few minutes: usually a mistyped **STS Access Key** or **STS Access Secret** (part b).

`HTTP 0` with *We couldn't access the credential(s)* means the user making the callout lacks the part d permission set.

`HTTP 403: {"message":"Forbidden"}` means API Gateway refused the signed request. If calls worked and then stopped about an hour later, Salesforce is still signing with an expired STS session: CloudTrail shows no AssumeRole since the last call that worked. Add `403` to **Additional Status Codes for Token Refresh** (part b), and the next call gets a new session. Otherwise check the Region and Service in part b, and the URL in part c.

A keyless alternative is the external credential's **Roles Anywhere** option, which replaces the access key with a certificate and an AWS trust anchor. This repo doesn't set that up yet.

**2. SSM Parameter Store.** Store `SLACK_SIGNING_SECRET` and the Salesforce JWT credentials the Slack Lambda uses at runtime. Use a **separate, least-privilege integration user** from the CI/CD deploy user — see [`docs/CI-CD-SECRETS.md`](CI-CD-SECRETS.md). Never reuse deploy credentials for runtime access, and never put either in code.

**3. Slack app.** Create it at api.slack.com, add the `/patient-status` slash command, and set its Request URL to the `SlackCommandsUrl` output of the Slack stack. Copy the Signing Secret into step 2's parameter.

**4. Data Cloud ingestion.** Every room reading reaches Data Cloud through the S3 archive: with `DataCloudExport` on (Dev), `patient-vitals` also writes each batch as CSV under `datacloud/room-readings/`, and the `patient-vitals` stack lets Data Cloud list and read that folder and nothing else. What stays by hand is in [SETUP.md §7](SETUP.md#7-data-cloud-room-readings-for-the-ward), in order:

1. Turn the CSV copy on with the AWS deploy (step 1).
2. Start the Amazon S3 connection in Data Cloud on the archive bucket, Parent Directory `datacloud/room-readings/` (step 2).
3. Make what Data Cloud signs in with (step 3): in an AWS project, an IAM user whose access key you type into the connection and nowhere else (`DATA_CLOUD_READER_USER`); in a regular account, the IAM identity provider for the org's My Domain, then the stack's `cloud-agentic-iot-data-cloud-reader` role (`DATA_CLOUD_OIDC_PROVIDER_ARN`, `DATA_CLOUD_EXTERNAL_ID`), with no key at all.
4. Test and save the connection (step 4).
5. Create the data stream into the `Room_Readings` data lake object (step 5) and map it to the `Room_Readings` data model object (step 6).
6. Create the two calculated insights, minutes out of the 30.0 C range per device per day and devices with no reading for 10 minutes, with `scripts/data-cloud-insights.sh` (step 7).

[`docs/DATA-CLOUD.md`](DATA-CLOUD.md) explains the path and how to check each step.

**5. Case queue and its indicator.** The deploy creates `Care_Team_Queue`, a Case queue (`force-app/main/default/queues/`); add its members in Setup → Queues. The indicator is any board whose Asset has the **Internal Device** record type: it follows the queue with no further setup (chapter 03). `Device_Queue_Binding.Care_Team_Queue` sets how fast it turns, and can name one more board; it is configuration, so it ships as metadata rather than being clicked in. The agent's escalations and the temperature alert rule's Cases go to the queue `Device_Platform_Setting__mdt.Default` names (`Escalation_Case_Queue__c` and `Room_Temp_Case_Queue__c`, both `Care_Team_Queue`), so a queue of another name means changing those two values.

**6. Publish and activate the agent.** The **Patient Care Agent** is an employee agent written in Agent Script for the new Agentforce Builder (`force-app/main/default/aiAuthoringBundles/Patient_Care_Agent/Patient_Care_Agent.agent`). The deploy stores the script; publishing compiles it into a new agent version, which starts inactive. It needs Einstein and Agentforce turned on in the org first ([SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin)). As the admin:

```bash
SF_TARGET_ORG=<your admin alias> scripts/publish-agent.sh Dev
```

`scripts/publish-agent.sh` publishes, activates the newest version and then resets `force-app` to the commit, because publishing writes generated files (a `bots/` and a `genAiPlannerBundles/` folder, reformatted `genAiFunctions`) back into the checkout, which the next deploy would refuse as uncommitted.

`--json` without `--version` activates the newest version. Or open it in Agentforce Builder and click **Activate**. Then assign the `Patient_Care_Agent` permission set to each care team member who will use it: it opens the agent to them and gives its three actions (`DeviceReadingsAgentAction`, `ProcedureSearchAgentAction`, `PatientCareAgentActions`) the device, reading and Case access they run with. Find Procedure calls AWS as that person, so they also need `AWS_IoT_Relay_Callers` (part d of step 1). An employee agent acts as the person talking to it, so there is no separate agent user. After changing the `.agent` file, publish and activate again: each publish is a new version. A routine deploy that leaves the script alone needs no publish.

```bash
sf org assign permset --name Patient_Care_Agent --target-org <your admin alias>
```

It ships inactive on purpose: activating an agent that can create clinical Cases should be a deliberate act, not a side effect of a deploy.

**7. Register the MCP endpoint** with whichever agent client you are using, so it can discover the device tools at runtime.

**8. Optional — MuleSoft.** Only if you want the iPaaS ingestion path instead of the Lambda. Open `mulesoft/` in Anypoint Studio, or `mvn package` and deploy to CloudHub; set the `sf.*` properties (consumer key, keystore, principal — JWT, no password); then point the AWS IoT rule at the flow's `/telemetry` endpoint. Chapter 07 explains when this is the right call and when it is not.

PII masking (chapter 10) is in the agent's actions: Get Device Readings masks the device's name and disconnect reason, and Find Procedure the passages it returns. The guardrails Lambda's `input`, `output` and `action` phases (chapter 11) guard the MCP server and every command to a room, not the agent's prompts.

## Why these stay manual

| Step | Why it cannot be automated |
|---|---|
| Flashing firmware | Needs a USB cable in a physical port. CI has no hardware |
| First-time device credentials | The AWS private key is issued once and must never transit CI |
| Creating the AWS IoT Thing + policy | One-time per device; the automated path is chapter 13 |
| Named Credentials in Salesforce | Store secrets; created in Setup, not in metadata |
| The Salesforce caller's IAM user and access key | The deploy identities may not create users or keys, and the key should exist only in Salesforce |
| Slack app creation + signing secret | Lives in Slack's console |
| Data Cloud connection, data stream and mapping | The connection holds a credential or a per-connection External ID, and Data Cloud metadata moves between orgs as a data kit retrieved from an org that has it, not as files written by hand ([DATA-CLOUD.md](DATA-CLOUD.md#why-the-data-cloud-side-is-not-in-force-app)) |
| The IAM user and key, or the identity provider, Data Cloud reads S3 with | The deploy identities may not create users, keys or identity providers |
| Turning on Einstein and Agentforce | Accepting their terms is the org admin's decision. The settings that switch them on are documented for scratch orgs, not for deploying to an existing org |
| Activating the Agentforce agent | A deliberate human checkpoint, not a deploy step |

## Stage 3 — Hardware

Only the device chapters (00, 03, 13) need hardware. Everything else is cloud-only, and the system deploys and runs without a board attached — you just will not see a motor move.

### What you need

The parts list with links, prices and photos, and the print files for the cases: [Quick Install Guide, step 0](INSTALL.md#step-0). Why each part: [step 0 explained](#quick-install-explained) above.

### Create the Thing and its certificate

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

Replace `REGION` and `ACCOUNT_ID`. `${iot:Connection.Thing.ThingName}` is a policy variable resolved per connection, so **one policy serves every device and each is scoped to its own topics** — a device physically cannot subscribe to another's commands. Readings go to the `$aws/rules/cloud_agentic_iot_patient_vitals/...` topic, AWS IoT Basic Ingest, which hands them straight to the rule. The `status` topic is where the queue indicator reports back; the board sends live readings on `live` while someone has its card open, and answers commands on `ack`. The `$aws/things/.../jobs/*` lines are OTA. None of them is optional: IoT Core disconnects a client that publishes to a topic its policy doesn't allow. Without the jobs lines the device reconnects in a loop, since the firmware asks for pending OTA jobs every time it connects; without any other line it is dropped each time it publishes there. A device provisioned from Salesforce (chapter 13) gets the same topics from the stack's own `cloud-agentic-iot-device` policy, which also lets it connect only as the Thing its certificate is attached to.

**3. Download and attach.** Download the certificate, the private key, and Amazon Root CA 1 into one folder. Attach the policy to the certificate.

**4. Create the Salesforce Asset.** Devices use the **standard Asset object** — no custom object. In the Cloud Agentic IoT app, Assets → New: Serial Number = the IoT Thing name, Account = the patient's Person Account (required for a Patient Device: the validation rule `Patient_Device_Needs_Person_Account` refuses a business account; make Person Account your default Account record type so New Account from this form creates one), Status = `Installed`.

### Getting a device online

Nothing secret is compiled into the firmware — one `.bin` is valid for every device of its type, which is what makes a single OTA job able to target a fleet. Credentials arrive afterwards, over the USB cable, and land in the ESP32's NVS flash.

Plug the ESP32 in and run the wizard:

```bash
./scripts/setup-device.sh          # macOS / Linux
.\scripts\setup-device.ps1         # Windows: not safe yet, see below
```

The Windows wizard still sends the credentials in one burst without waiting for the board to ask for them, and a burst that arrives while the board is asking can lose characters from inside the certificate or key and still be stored, once. Run the macOS / Linux one until it works the same way.

It asks for the folder holding your downloaded certificates, which file is which, the Thing name, the endpoint, and the WiFi network — filling in a default wherever it can work one out. Then it compiles, flashes over USB, sends the credentials, and prints what the device says back.

**Add your phone hotspot as the second network right after:**

```bash
./scripts/update-wifi.sh "<hotspot-SSID>"      # asks for the passphrase without showing it
```

NVS holds three networks and only the third ever rotates, so the first two are permanent anchors. A hotspot in slot 1 means the device can reach AWS from almost anywhere — which is what lets the third slot be updated remotely later, with no USB and no rebuild.

**Every firmware update after that is over the air.** OTA rewrites the application partition only, so NVS — WiFi *and* certificate — survives untouched. Full detail in [DEVICE-IDENTITY.md](DEVICE-IDENTITY.md).

> Do **not** run `esptool erase_flash` on a provisioned device. It wipes the NVS partition holding a private key that AWS issues exactly once and will never reissue. If it has already happened, use the Re-provision button on the Asset (chapter 13) — it rotates the certificate and keeps all device history.

## Stage 4 — Verify end to end

Start at the device and walk outward; a break is easiest to find at the first hop that goes quiet.

```bash
arduino-cli monitor -p <port> -c baudrate=115200
```

Expect the WiFi and AWS IoT connection lines, then a `telemetry:` line every 30 s (or at the interval the fleet set). Then work outward:

| Check | Where | Expect |
|---|---|---|
| Device is publishing | S3 → the patient-vitals archive bucket, `readings/date=<today>/`. Readings go through Basic Ingest, straight to the rule, so the MQTT test client does not see them | A new `.ndjson.gz` object for each batch |
| Device is online | The device's Asset in the Cloud Agentic IoT app ([LIVE-STATUS.md](LIVE-STATUS.md)) | Connection `Online`, and on the Live Status card a reading every 2 s |
| Costs and limits show | The app's Home tab | This month's AWS spend against its budget, and the org's limits by group, read when the page loads |
| Device accepts commands | On the Asset, **Send Command** with `RESTART`. By hand: publish `{ "operation": "RESTART", "commandId": "by-hand-1" }` to `device/<thing>/command` | The board restarts. From the Asset, the Device Command goes `Sent`, then `Acked` within seconds. By hand, the board's answer shows on `device/<thing>/ack` in the MQTT test client; it answers only a command that carries a `commandId` |
| Ingestion works | `Patient_Vitals__c` in Salesforce | Rows appearing |
| Events fire | Platform Event monitoring | `Patient_Vital_Alert__e` on a threshold breach |
| The loop closes | Assign a Case to the bound queue | The indicator servo starts |
| The agent acts | The agent's panel in Lightning, as a holder of `Patient_Care_Agent`: ask for a device's latest readings, then escalate | The readings, then a Case with `Origin = Agentforce` in Care_Team_Queue |
| High temperature Case | Warm the DHT11 above 30 C, for example under an arm (with `RoomTempAlert` on, [TRY-IT.md](TRY-IT.md#warm-the-sensor-get-a-high-temperature-alert)) | A Case `High temperature ... C on <device>` with Origin `Room Temperature Rule` in Care_Team_Queue, no Device Command, and the board sweeping until a reading is below 30 C |
| Temperature alert motor | Warm the DHT11 to 30 C on a monitored device | The board's servo sweeps back and forth within about 5 s, decided on the board with no Case, and stops at the first reading below 30 C |
| Slack is headless | `/patient-status <device-id>` | A reply, with nobody logged into Salesforce |

The Asset's Connection field, its Live Status card and **Send Command** need a device provisioned from Salesforce (chapter 13), whose Asset carries its Thing ARN. On an Asset made by hand in Stage 3, Connection stays *Not reported yet*, the card says the device has no AWS IoT Thing, and a command fails as not provisioned. The by-hand publish works either way.

## Stage 5 — Promote to `Prod`

Once it holds together on `Dev`, `Prod` is the same sequence against the second AWS account and Salesforce org — with one exception that makes it a project rather than a push: **device certificates cannot move between environments.** `iot-dev` and `iot-prod` have separate CAs, so a Dev certificate physically cannot connect to Prod. Re-provisioning the fleet is the one irreversible step, which is why [MIGRATION-RUNBOOK.md](MIGRATION-RUNBOOK.md) isolates it, batches it, and puts it last.

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
