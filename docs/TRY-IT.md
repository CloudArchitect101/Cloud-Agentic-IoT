# Try it on your own AWS project and Salesforce org

Cloned this repo to learn or experiment? Run it on two things of your own: an
AWS **project** with a spend limit, and a free Salesforce Developer Edition
org. You deploy both from your laptop and skip the GitHub setup until you need
it. At the limit AWS pauses the project instead of billing you more, so a bug or
a loop cannot run up a large bill.

**Give both the same name.** Use one name for your AWS CLI profile and your
Salesforce CLI alias, for example `test-<your GitHub name>`. This guide calls it
`<name>`, and its commands read it from `NAME`. It is not called a sandbox here,
because in Salesforce a sandbox is a copy of a production org, which a
Developer Edition org is not.

When you are ready for the pipelines, move to regular AWS accounts:
[Moving to the pipelines](#moving-to-the-pipelines).

## Why a project, and what it costs you

| | Project with a spend limit | Regular AWS account |
|---|---|---|
| Spending | Capped. AWS pauses the project at the limit. | Not capped. A budget alert is your protection. |
| Who deploys | You, from your laptop | GitHub Actions, signed in with OIDC |
| GitHub OIDC | Not possible: projects block IAM identity providers | Yes |
| Region | Set by your contact address (a Canadian address gets `us-east-2`) | Your choice |
| Console | Your AWS Builder ID. IAM users are command line only. | IAM users with console access and MFA |

**You can't have both in one account.** Activating a project's advanced
features lifts the OIDC block, but it removes every spend limit for good, and it
can't be undone. A regular account can't hand access to a project either,
because a project only trusts accounts in its own organization. So this guide
deploys from your laptop, and GitHub comes in only with the regular account.

## 1. Create the project and the org

1. Sign up through the new AWS experience, or add a project in
   [AWS Settings](https://settings.aws.com).
2. Upgrade to the paid plan, then set a monthly spend limit. The lowest is $20.
3. Note the project's Region: AWS Settings, **Projects**, your project,
   **Overview**, **Additional Info**.
4. Sign up for a Developer Edition org, as in
   [SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin). It is free.
5. In the org, Setup → **Einstein Setup** → **Turn on Einstein**.
6. Then Setup → **Agentforce Agents** → turn on **Agentforce**. If it is not
   there yet, wait a few minutes after step 5 and reload.

Steps 5 and 6 accept Salesforce's terms for generative AI and Agentforce, so
whether to turn them on is the org admin's decision, which here is you. Do
both before the first Salesforce deploy, in section 4 below: the deploy creates
the Patient Care Agent, and an org without Agentforce is expected to refuse
it, which fails the whole deploy. Neither costs anything in a Developer
Edition org.

## 2. Sign both CLIs in as `<name>`

`aws login` needs AWS CLI 2.32.0 or later. It opens a browser, and you choose
your project to finish signing in. Give the project's Region when it asks.
`sf org login web` opens a browser too: sign in as the org's admin.

```bash
NAME=test-yourname
aws login --profile "$NAME"
sf org login web --alias "$NAME"
export AWS_PROFILE="$NAME" SF_TARGET_ORG="$NAME"
aws sts get-caller-identity
sf org display
```

Put your own `<name>` in the first line. The `export` holds for this shell only,
as in [DEVELOPMENT.md](DEVELOPMENT.md), so set `NAME` and export again in each
new terminal. The last two commands show the project's account ID, and the org
with your admin username.

The AWS credentials refresh themselves and last up to 12 hours. Run the same
`aws login` again when they expire. No access key is created, so there is none
to leak.

## 3. Put the Salesforce settings in SSM

In a regular account the pipeline writes these from GitHub secrets. Here you
put them once, by hand. Type the values in your terminal, never into a chat
or a file in the repo.

```bash
aws ssm put-parameter --type String --name /cloud-agentic-iot/salesforce/login-url    --value https://login.salesforce.com
aws ssm put-parameter --type String --name /cloud-agentic-iot/salesforce/username     --value '<integration username>'
aws ssm put-parameter --type String --name /cloud-agentic-iot/salesforce/consumer-key --value '<integration consumer key>'
aws ssm put-parameter --type SecureString --name /cloud-agentic-iot/salesforce/jwt-private-key --value file://scripts/server-integration.key
```

The last three come from step 5, so you won't have them on a first deploy. Put
`placeholder` as each of their values for now. The stacks deploy, and only the
calls to Salesforce fail until step 5 replaces the values and deploys again.

## 4. Deploy and test

`scripts/check.sh` needs no credentials. `scripts/deploy-aws.sh Dev` deploys
every stack and the real Lambda code, and `scripts/deploy-salesforce.sh Dev`
deploys everything in `force-app/` and runs every local Apex test.

```bash
scripts/check.sh
scripts/deploy-aws.sh Dev
scripts/deploy-salesforce.sh Dev
```

The `<name>` project is your Dev environment. Its first deploy labels the
account `Dev` in SSM (`/cloud-agentic-iot/environment`), and every later deploy
checks that label, so a wrong `AWS_PROFILE` stops before it changes anything.

The Salesforce deploy goes to the org in `SF_TARGET_ORG`, as your admin, and the
script warns that you aren't the deploy user. That is expected here. The deploy
user matters once a pipeline deploys, because an admin deploy can pass where the
pipeline's would fail, and [Moving to the pipelines](#moving-to-the-pipelines)
sets it up.

Then give yourself the interface. The deploy adds the **Cloud Agentic IoT** app,
with tabs, record pages and page layouts for devices, patient vitals, device
commands and Wi-Fi networks, but the app and the device fields stay hidden
until you hold the `Device_Platform_Admin` permission set. Being System
Administrator isn't enough: fields deployed through the Metadata API come with
no field access.

```bash
sf org assign permset --name Device_Platform_Admin
sf org assign permset --name Platform_Usage_Viewer
```

That assigns the sets to you, in the org `SF_TARGET_ORG` names. The Home page
shows the project's spend against its spend limit once Salesforce can call AWS
(step 5) and the budget below exists. Open the app from
the App Launcher. In an org without Person Accounts, any Account will do for a
device's Account.

## 5. Connect the org and the project

Each direction has its own identity, made once.

**AWS to Salesforce** (readings, alerts, whether a board is online, and the
boards' answers to commands) signs in as the integration user:

1. Create the `integration@…` user from
   [SETUP.md §2.2](SETUP.md#22-create-the-two-service-users), and the
   Integration app with its certificate from
   [§2.4](SETUP.md#24-two-external-apps-not-one).
2. Give the user the **Salesforce API Integration** permission set license
   (the user's page → Permission Set License Assignments → Edit Assignments),
   then the `Device_Integration` permission set, which step 4 deployed.
   Without that license, Salesforce refuses the permission set: "The user
   license doesn't allow the permission: Create Assets".
3. Replace the three placeholders, typing the values in your terminal, and
   deploy again. The third command reads the key from
   `scripts/server-integration.key`; change the path if yours is elsewhere.

```bash
aws ssm put-parameter --overwrite --type String --name /cloud-agentic-iot/salesforce/username     --value '<integration username>'
aws ssm put-parameter --overwrite --type String --name /cloud-agentic-iot/salesforce/consumer-key --value '<integration consumer key>'
aws ssm put-parameter --overwrite --type SecureString --name /cloud-agentic-iot/salesforce/jwt-private-key --value file://scripts/server-integration.key
scripts/deploy-aws.sh Dev
```

The deploy at the end is needed. Four functions sign in to Salesforce as the
integration user: `cloud-agentic-iot-salesforce-sync` for readings,
`cloud-agentic-iot-alert-dispatcher` for alerts,
`cloud-agentic-iot-device-presence` for the Asset's Connection fields and
`cloud-agentic-iot-device-command-ack` for the boards' answers to Device
Commands, and `cloud-agentic-iot-slack-integration` too once Slack is set up.
CloudFormation copies the username and consumer key from SSM into their
settings only when it deploys, so until then they still hold `placeholder`.
They read the private key from SSM each time they sign in, so it needs no
deploy.

To check, this prints the integration username, not `placeholder`:

```bash
aws lambda get-function-configuration --function-name cloud-agentic-iot-salesforce-sync \
  --query Environment.Variables.SALESFORCE_USERNAME --output text
```

The deploy user and the Deploy app aren't needed until the pipelines.

**Salesforce to AWS** (provisioning, the queue indicator, Wi-Fi pushes) signs
with the `AWS_IoT_Relay` named credential:
[README, Stage 2, step 1](../README.md#stage-2--connect-the-seams-ci-cannot-reach).
Make its IAM user as `<name>`, the profile you signed in with in step 2.

Boards are provisioned as in the [README, Stage 3](../README.md#stage-3--hardware),
against the `<name>` project's IoT endpoint, and
[DEVELOPMENT.md, "On your laptop"](DEVELOPMENT.md#1-on-your-laptop) covers
flashing and watching one.

The pipeline never deploys to `<name>`, so no release reaches its boards. To
update them over the air, as every update after the first USB flash is meant to
arrive, send your working copy to every board of a type:

```bash
scripts/ota.sh try Dev patient-monitor
```

It compiles the sketch as `<version>-try.<n>` from a copy, so your checkout
stays as it is, uploads it to the firmware bucket under `firmware/<type>/try/`,
creates one AWS IoT job for `fleet-<type>` at the pace and with the abort rule
of a Dev release, and prints each board's answer as it comes. A board that is
offline takes the job when it next connects, and `scripts/ota.sh status Dev`
shows where each one stands. A new try cancels an earlier one that a board has
not started, so a board that was offline installs only the newest. A board on
firmware 2.2.0 or later answers SUCCEEDED `running <version>` only once it has
restarted into the new build and reconnected, and FAILED `came back on
<version>` if the new build did not start. An older board answers SUCCEEDED
`rebooting` just before it restarts, so for that first update to 2.2.0 the
script points you to the serial console: first `OTA: complete, restarting`
and, after the restart, `aws: connected, patient-monitor v<version>-try.<n>`.
Either way the board keeps its Wi-Fi and certificate, which live in NVS,
outside the part of the flash an update rewrites. A try costs one upload and one job execution per board, a fraction
of a cent.

To watch a board, open its Asset in the Cloud Agentic IoT app. The Live Status
card shows whether it is connected and, from firmware 2.2.0, a reading every 2
seconds while the card is on screen, straight from AWS IoT to your browser.
Readings never pass through Salesforce, and an hour of watching costs about a
third of a cent in AWS. [LIVE-STATUS.md](LIVE-STATUS.md) has the speeds, the
costs and what to check when the card waits for the board.

To send a board a command, open its Asset and choose **Send Command**, then
`DISPENSE_MEDICATION` or `RESTART`. The Device Command shows `Sent` within
seconds and, from firmware 2.2.0, `Acked` once the board answers, or `Failed`
with the reason (a board that is offline is not sent anything). The command is
sent as you, so you need the `AWS_IoT_Relay` principal access from
[README, Stage 2 part d](../README.md#stage-2--connect-the-seams-ci-cannot-reach).
[DATA-MODEL.md](DATA-MODEL.md#device-command-lifecycle) explains each status.

The card and Send Command both need a board provisioned from its Asset
([README, chapter 13](../README.md#13--device-provisioning-automation)). An
Asset made by hand, as in Stage 3, has no Thing ARN: its Connection stays *Not
reported yet*, the card says it has no AWS IoT Thing, and a command fails as
not provisioned.

## Warm the sensor, get a Case and a dose

The room-temperature demo rule ([README, chapter 03](../README.md#room-temperature-demo-rule)):
when the patient monitor's DHT11 reads 30 C or more, Salesforce opens a Case
for the device in Care_Team_Queue, the queue indicator moves, and the
dispenser's servo turns. It is a demo rule, not a clinical alert: the sensor
measures room air. It is on in Dev (`RoomTempAlert` in `config/Dev.json`) and
off in Prod.

**Deploy Salesforce first, then AWS.** A flagged record that reaches an org
without the `Room_Temperature_Alert__c` field, or without its field access, is
refused with `INVALID_FIELD`; the sync queue retries it 5 times over about 30
minutes, then moves it to the dead-letter queue and `SyncDeadLetterAlarm`
fires. So when you first bring this rule to a project and org:

```bash
scripts/check.sh
scripts/deploy-salesforce.sh Dev     # the field, the trigger, the settings; runs every local Apex test
# verify in the org: the list below, and Device_Integration has Room Temperature Alert
scripts/deploy-aws.sh Dev            # patient-vitals with RoomTempAlert "true" from config/Dev.json
```

The pipeline deploys AWS before Salesforce (`.github/workflows/deploy.yml`),
so through CI ship it in two pushes: first with `"RoomTempAlert": "false"` in
`config/Dev.json`, and once the Salesforce side is verified, a second push that
sets it to `"true"`.

**Before you start**

- The board's Asset (Test8 here) has a SerialNumber equal to its Thing name,
  and is Provisioned and Online. Without a matching Asset there is no Case,
  only a WARN in the debug log.
- Care_Team_Queue lists Case as a supported object (Setup → Queues). If not,
  the Case lands with the integration user, an ERROR is logged, and the
  indicator does not count it.
- `Device_Queue_Binding.Care_Team_Queue` names your queue indicator's Thing.
  It ships as `ESP32-Patient-Monitor-01`; change the record if your indicator
  board has another name, or step 2's indicator will not move.
- The integration user has the `AWS_IoT_Relay` principal access
  ([README, Stage 2 part d](../README.md#stage-2--connect-the-seams-ci-cannot-reach)):
  the dose is a Device Command sent as the user who created it.
- Optional: add `Room Temperature Rule` to the Case Origin picklist, so it
  shows as a label. An unlisted value works while the picklist is not
  restricted, which is the default.

**Steps**

1. Cup your hand around the DHT11, or breathe on it, until it reads 30 C (its
   maximum is 50 C). Allow 1 to 3 readings, about 30 s each.
2. A Case appears in Care_Team_Queue, the indicator board moves, and the
   servo turns.
3. Keep it warm: no new Case. AWS reports the device again every re-alert
   interval (15 minutes in Dev), and Salesforce sees the open Case and stops.
4. Close the Case while it is still warm: within 15 minutes a new Case
   appears. No dose this time: the 60-minute cooldown is running, and the
   Case Description says so.
5. Let it cool below 29 C, then warm it again while a Case is open: no new
   Case.
6. If the servo did not turn, look for a `DISPENSE_MEDICATION` Device Command
   for Test8. If there is none, send it from the Asset with **Send Command**:
   a failed dose is not retried.

**For a live talk**, step 4 waits up to `RealertIntervalMinutes`. To shorten
it, deploy Dev with `"RealertIntervalMinutes": 2` for the session and set it
back after. That also speeds up the clinical reminders for devices that are
not STABLE; Test8 on a desk is always STABLE.

**Check it**

```sql
SELECT CaseNumber, Owner.Name, Asset.SerialNumber, Status, CreatedDate
FROM Case WHERE Origin = 'Room Temperature Rule' ORDER BY CreatedDate DESC
```

```sql
SELECT Name, Device__c, Status__c, Status_Detail__c, CreatedDate
FROM Device_Command__c WHERE Requested_By__c = 'Room Temperature Rule' ORDER BY CreatedDate DESC
```

A flagged reading is a `Patient_Vitals__c` row with Room Temperature Alert
checked. In AWS, the salesforce-sync function logs each batch it writes (use
your project's Region):

```bash
aws logs tail /aws/lambda/cloud-agentic-iot-salesforce-sync --since 15m --region us-east-2 \
  --filter-pattern '"Synced to Salesforce"'
# ... Synced to Salesforce { records: 1, returned: 0 }
```

That line counts every synced record, flagged or not. A record Salesforce
refused (for example `INVALID_FIELD` on `Room_Temperature_Alert__c`, when AWS
was switched on before the Salesforce deploy) logs `Salesforce refused a
record` instead.

**Emergency stop**: in Setup → Custom Settings → Integration Control, at org
level, add `PatientVitalsTriggerHandler` to Bypass Handlers. It takes effect
at once, with no deploy. To stop AWS sending flagged readings, set
`RoomTempAlert` to `"false"` in `config/Dev.json` and deploy AWS. To keep the
Cases but stop the doses, set `Room_Temp_Dispense__c` to false in
`force-app/main/default/customMetadata/Device_Platform_Setting.Default.md-meta.xml`
and deploy Salesforce; a Setup edit is overwritten by the next deploy.

## See what it costs

The app's Home page shows this month's AWS spend against the project's spend
limit. No AWS API returns a spend limit, so the card reads it from a budget of
the same amount, named `cloud-agentic-iot-monthly`. As the project owner, in the
project's CloudShell, first see what budgets the project lists:

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws budgets describe-budgets --region us-east-1 --account-id "$ACCOUNT" --show-filter-expression \
  --query 'Budgets[].{name:BudgetName,type:BudgetType,unit:TimeUnit,limit:BudgetLimit.Amount,filter:FilterExpression,old:CostFilters}'
```

Then create `cloud-agentic-iot-monthly` with its amount equal to the spend
limit, with the command in
[SPEND-AND-LIMITS.md](SPEND-AND-LIMITS.md#give-the-account-a-budget). Change
both together from then on. A budget without actions is free, and the card
reads it at no charge.

## What happens near the limit

- As spending nears the limit, AWS denies Lambda invocations, Bedrock calls and
  new compute in the project. Readings stop flowing, which is the point.
- At the limit, AWS pauses the project and stops its resources for the rest of
  that month. Your data is kept. To resume, raise the limit in AWS Settings;
  some resources may need a manual restart.
- A paused project left untouched for 90 days is deleted, after reminder emails.
- The Home page's AWS spend may stop answering, because it runs on Lambda. The
  card says so, points to AWS Settings, and shows the last spend it read. Its
  Salesforce half keeps working.
- Deploy changes that add Lambda functions well before the limit: once AWS
  stops new resource creation, a stack update that adds a function fails.

## Moving to the pipelines

When you want GitHub Actions to deploy for you, and later a Prod environment,
move to regular AWS accounts:

1. Set up a regular account for Dev as in [SETUP.md §3](SETUP.md#3-aws-dev-account)
   (the OIDC deploy role) and [§5](SETUP.md#5-github) (environments, secrets
   and variables). Create an AWS Budget alert before you deploy anything
   ([COST-MODEL.md §6](COST-MODEL.md)).
2. Deploy through the pipeline. Stacks don't move between accounts: the regular
   account gets new resources, a new IoT endpoint and new certificates, so
   provision each board again against it.
3. Keep `<name>` for trying changes from your laptop. It stays connected, and
   the pipelines never touch it. If you'd rather not keep it, copy anything you
   want out of its S3 buckets and DynamoDB table, then delete its
   `cloud-agentic-iot-*` stacks, or close the project.

## Sources

- [AWS reimagines the getting started experience](https://aws.amazon.com/blogs/aws/aws-reimagines-the-getting-started-experience/): spend limits from $20, pausing, the 90-day deletion
- [New AWS builder experience (What's New, September 2026)](https://aws.amazon.com/about-aws/whats-new/2026/09/New-AWS-Builder-Experience)
- [Service and resource control policies for projects](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html): the identity-provider block, what is denied near the limit, the organization-only trust
- [Activate advanced features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html): removes spend limits, can't be reversed
- [Project Regions](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html)
- [Connect an AI coding tool](https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html) and [Login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html): `aws login`, CLI 2.32.0, 12-hour sessions
