# Try it on your own AWS project and Salesforce org

> [!TIP]
> New here? [Start here](START-HERE.md) shows which guide to follow. The [Quick Install Guide](INSTALL.md) is the one list of steps; this page goes deeper.

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
   Do not activate the project's advanced features: that removes the spend limit
   for good ([why](#why-a-project-and-what-it-costs-you)).
3. Note the project's Region: AWS Settings, **Projects**, your project,
   **Overview**, **Additional Info**.
4. Sign up for a Developer Edition org at
   [developer.salesforce.com/signup](https://developer.salesforce.com/signup), as in
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

In a regular account the pipeline runs `scripts/seed-ssm.sh` with the GitHub
secrets. Here you run the same script once:

```bash
scripts/seed-ssm.sh Dev
```

It checks that the project is labelled `Dev` (a fresh one gets the label),
then asks for the integration username, consumer key and key file, and the
Slack signing secret, hiding what you type. You won't have the integration
values on a first deploy: press Enter at each. What you skip is written as
`placeholder`, the login URL defaults to `https://login.salesforce.com`, and
Slack is left out. The stacks then deploy, and only the calls to Salesforce
fail until step 5 runs the script again with the real values.

## 4. Deploy and test

`scripts/check.sh` needs no credentials. `scripts/deploy-aws.sh Dev` deploys
every stack and the real Lambda code, and `scripts/deploy-salesforce.sh Dev`
deploys everything in `force-app/` and runs every local Apex test.

```bash
scripts/check.sh && scripts/deploy-aws.sh Dev && scripts/deploy-salesforce.sh Dev
```

Run them as one line joined by `&&`, so the first failure stops the rest.
Pasted as separate lines, zsh and bash run every line even after one fails,
so one environment can end up ahead of the other. Later deploys that add a
field AWS writes go Salesforce first; see
[Warm the sensor, get a high temperature alert](#warm-the-sensor-get-a-high-temperature-alert).

Both refuse uncommitted changes under `lambda/`, `infra/`, `force-app/`, `knowledge/`,
`config/` and `scripts/`, because a laptop deploy would otherwise ship what no
commit holds. Commit first; for a throwaway try, `ALLOW_DIRTY=yes` deploys
anyway. Each records the commit it shipped in SSM, so you can see what the
project runs:

```bash
aws ssm get-parameters --names /cloud-agentic-iot/deployed-commit/aws /cloud-agentic-iot/deployed-commit/salesforce \
  --query 'Parameters[].[Name,Value]' --output text
```

To have the alarms emailed to you, `export ALARM_EMAIL='<your email>'` before
`deploy-aws.sh`, then confirm the subscription in the email AWS sends.

The `<name>` project is your Dev environment. Its first deploy labels the
account `Dev` in SSM (`/cloud-agentic-iot/environment`), and every later deploy
checks that label, so a wrong `AWS_PROFILE` stops before it changes anything.
The first Salesforce deploy pairs the org with the project
(`/cloud-agentic-iot/salesforce/org-id`), and every later one stops if
`SF_TARGET_ORG` names another org, such as the pipeline's Dev org: both are
labelled `Dev`, so the label alone can't tell them apart.

The Salesforce deploy goes to the org in `SF_TARGET_ORG`, as your admin, and the
script warns that you aren't the deploy user. That is expected here. The deploy
user matters once a pipeline deploys, because an admin deploy can pass where the
pipeline's would fail, and [Moving to the pipelines](#moving-to-the-pipelines)
sets it up.

Then give yourself the interface. The deploy adds the **Cloud Agentic IoT** app,
with tabs, record pages and page layouts for devices, device readings, device
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
the App Launcher. A **Patient Device** must belong to a **Person Account**: the
validation rule `Patient_Device_Needs_Person_Account` refuses a business
account. Person Accounts must be on before the deploy, and Person Account
should be your profile's default Account record type, because **New Account**
from the Asset form never asks which type
([SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin), step 5). A
ward board (**Internal Device**) sits on the ward's business account, created
from the Accounts tab.

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
3. Replace the three placeholders and deploy again. Run the script, type the
   username and consumer key when it asks, and give it the key file (it
   offers `scripts/server-integration.key` when that exists):

```bash
scripts/seed-ssm.sh Dev
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
[Detailed Install Guide, Stage 2, step 1](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach).
Make its IAM user as `<name>`, the profile you signed in with in step 2.

Boards are provisioned as in the [Detailed Install Guide, Stage 3](INSTALL-GUIDE.md#stage-3--hardware),
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
not started, so a board that was offline installs only the newest. A board
answers SUCCEEDED `running <version>` only once it has restarted into the new
build and reconnected, and FAILED `came back on <version>` if the new build did
not start. On the serial console you see `OTA: complete, restarting` and, after
the restart, `aws: connected, patient-monitor v<version>-try.<n>`.
The board keeps its Wi-Fi and certificate, which live in NVS,
outside the part of the flash an update rewrites. A try costs one upload and one job execution per board, a fraction
of a cent.

To watch a board, open its Asset in the Cloud Agentic IoT app. The Live Status
card shows whether it is connected and a reading every 2
seconds while the card is on screen, straight from AWS IoT to your browser.
Readings never pass through Salesforce, and an hour of watching costs about a
third of a cent in AWS. [LIVE-STATUS.md](LIVE-STATUS.md) has the speeds, the
costs and what to check when the card waits for the board.

To send a board a command, open its Asset and choose **Send Command**, then
`RESTART`. The Device Command shows `Sent` within
seconds and `Acked` once the board answers, or `Failed`
with the reason (a board that is offline is not sent anything). The command is
sent as you, so you need the `AWS_IoT_Relay` principal access from
[Detailed Install Guide, Stage 2 part d](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach).
[DATA-MODEL.md](DATA-MODEL.md#device-command-lifecycle) explains each status.

The card and Send Command both need a board provisioned from its Asset
([Chapters, chapter 13](CHAPTERS.md#13--device-provisioning-automation)). An
Asset made by hand, as in Stage 3, has no Thing ARN: its Connection stays *Not
reported yet*, the card says it has no AWS IoT Thing, and a command fails as
not provisioned.

## Talk to the agent

The deploy created the **Patient Care Agent**, inactive: switching on an agent
that can create clinical Cases is left to a person. Activate it, check it, and
give yourself access:

```bash
scripts/publish-agent.sh Dev
sf data query --query "SELECT VersionNumber, Status FROM BotVersion WHERE BotDefinition.DeveloperName = 'Patient_Care_Agent'"
sf org assign permset --name Patient_Care_Agent
```

Or activate it in Setup → **Agentforce Agents** → **Patient Care Agent**. The
query shows the newest version `Active`. `Patient_Care_Agent` opens the agent to you
and gives its actions what they read and create; it is an employee agent, so
it acts as you. Open it from the Lightning header, then:

1. Ask what a device is reporting, by its serial number (Test8, say). It
   answers from the device's latest readings and connection status.
2. Ask it to escalate a reading. It says which device and reading, and asks
   you to confirm.
3. Confirm. It reports the Case number, and the Case (`Origin = Agentforce`)
   is in Care_Team_Queue, so the indicator board moves.

## Warm the sensor, get a high temperature alert

The temperature alert demo rule ([Chapters, chapter 03](CHAPTERS.md#temperature-alert-demo-rule)):
the monitored device's DHT11 can sit wherever the temperature matters, against
a patient (the demo puts it under an arm), in a medication fridge, in a room.
When it reads 30 C or more, the board itself sweeps its servo back and forth to
tell whoever is near, and stops at the first reading below 30 C (decided on the board, so closing the Case does not stop it,
cooling the sensor does). Salesforce also opens a Case for the device in
Care_Team_Queue, and the ward board moves. The motor only ever means
"temperature high": there is no dose. It is a demo rule, not a
clinical alert: a DHT11 is not a calibrated thermometer. It is on in Dev
(`RoomTempAlert` in `config/Dev.json`) and off in Prod.

**Deploy Salesforce first, then AWS.** A flagged record that reaches an org
without the `Room_Temperature_Alert__c` field, or without its field access, is
refused with `INVALID_FIELD`; the sync queue retries it 5 times over about 30
minutes, then moves it to the dead-letter queue and `SyncDeadLetterAlarm`
fires. So when you first bring this rule to a project and org:

```bash
scripts/check.sh
scripts/deploy-salesforce.sh Dev --with-tests
# verify in the org: the list below, and Device_Integration has Temperature Alert
scripts/deploy-aws.sh Dev            # patient-vitals with RoomTempAlert "true" from config/Dev.json
scripts/ota.sh try Dev patient-monitor   # optional: send your working copy of the firmware over the air
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
  ward board does not count it.
- Your ward board's Asset has the Internal Device record type. Any such
  board follows Care_Team_Queue.
- The integration user has the `AWS_IoT_Relay` principal access
  ([Detailed Install Guide, Stage 2 part d](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach)):
  the Case moves the ward board through a callout made as that user.
- `Room Temperature Rule` (labelled Temperature Alert Rule) and `Agentforce` are Case Origin values: the
  deploy adds them (`standardValueSets/CaseOrigin`). A value you added to
  Case Origin by hand must be in that file too, or the deploy may take it
  off the list.

**Steps**

1. Put the DHT11 under your arm (it reads about 33 to 36 C there), or cup
   your hand around it, until it reads 30 C (its maximum is 50 C). Within
   about 5 s the board's servo starts sweeping (console:
   `temperature 30.0C: 30 C or more, motor turning`).
2. Within 1 to 3 stored readings (about 30 s each) a Case appears in
   Care_Team_Queue (Subject `High temperature ... C on Test8`) and the ward
   board moves. The servo goes on sweeping.
3. Keep it warm: no new Case. AWS reports the device again every re-alert
   interval (15 minutes in Dev), and Salesforce sees the open Case and stops.
4. Take the sensor out and let it cool below 30 C: the sweep stops within
   about 5 s of the first reading below 30 C (a DHT11 takes a minute or two
   to cool from body heat). The Case stays
   open, and the ward board keeps moving until someone closes or takes it.
5. Close the Case: the ward board stops (if it was the queue's last Case).
   Warm the sensor again: the sweep starts again at once; a new Case follows
   once a reading went below 29 C in between.
6. Unplug the board while it is warm, plug it back in: it sweeps again as
   soon as its first reading after the start is 30 C or more.
7. If it does not sweep while warm, check the console for the temperature
   it reads and for `motor turning`.
   SOP-WARD-004 is the procedure for a motor that does not follow the
   temperature.

**For a live talk**, step 4 waits up to `RealertIntervalMinutes`. To shorten
it, deploy Dev with `"RealertIntervalMinutes": 2` for the session and set it
back after. That also speeds up the clinical reminders for devices that are
not STABLE; Test8 on a desk is always STABLE.

**Check it**

```sql
SELECT CaseNumber, Owner.Name, Asset.SerialNumber, Status, CreatedDate
FROM Case WHERE Origin = 'Room Temperature Rule' ORDER BY CreatedDate DESC
```

The rule creates no Device Command. A flagged reading is a `Patient_Vitals__c`
(Device Reading) row with Temperature Alert (`Room_Temperature_Alert__c`)
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
`RoomTempAlert` to `"false"` in `config/Dev.json` and deploy AWS. The
board's own sweep follows only its sensor: cool the sensor, or unplug the servo.

## Device readings in Data Cloud

If the org has Data Cloud, every device reading can reach it from the S3
archive, with a daily count of minutes at or above 30 C per device and a
list of devices that went quiet: [SETUP.md §7](SETUP.md#7-data-cloud-room-readings-for-the-ward).
A project cannot hold the IAM identity provider the keyless way needs, so
here Data Cloud signs in with an access key of an IAM user you make as
`<name>` (step 3a), typed into Data Cloud and nowhere else.
[DATA-CLOUD.md](DATA-CLOUD.md) explains the path.

## Fire the vitals stream

The boards send only temperature and humidity, so the chapter 02 stream (EventBridge to
Salesforce Platform Events) never fires on its own. Send it one synthetic
reading with a heart rate of 135 and an SpO2 of 86, the way a wearable
would, from the repository root and signed in as in step 2:

```bash
scripts/streams-test.sh Dev Test8
```

It prints what the alert dispatcher decided (`CRITICAL_VITALS`). Within a few
seconds Salesforce has a Case **Critical vitals on Test8**, Origin **Vital
Alert**, in **Care Team Queue** on Test8's Asset, and the ward board starts
turning for it like for any other Case. Run it again while that Case is open
and no second one opens; close it and the next run opens a new one.
`scripts/streams-test.sh Dev Test8 warning` publishes an `ABNORMAL_TREND`
alert, which opens nothing, and `normal` is dropped in AWS. Nothing is
written to the device's readings and no board is contacted.

## Update one board through the saga

Chapter 09 sends one board one build as a saga: each step has a step that
undoes it. Use a build that is already published, for example the last try
(`scripts/ota.sh status Dev` names it):

```bash
scripts/ota-saga.sh send Dev Test8 patient-monitor 1.0.0-try.1
scripts/ota-saga.sh status Dev Test8
```

`status` shows the Thing's `otaState` (`UPDATING` while the saga runs,
`ACTIVE` with `otaVersion` once the board has installed it) and the board's
`saga-` jobs. A board already on that version reports it as current and the
saga completes. The trace is in
`aws logs tail /aws/lambda/cloud-agentic-iot-ota-saga --follow`.

To watch it unwind, unplug the board, send it again and wait: the job stays
`QUEUED`, and after 20 minutes the log shows `cancel_iot_job`,
`mark_device_active` and `delete_staged_firmware`, in that order, and
`status` shows the job `CANCELED` and the Thing `ACTIVE` on its old version.

## Ask the ward from Slack

Optional (chapter 04). Slack never signs in to Salesforce: a slash command
reaches the `cloud-agentic-iot-slack-integration` function through API
Gateway, the function checks Slack's signature, and it calls Salesforce as
the integration user from step 5, as every other function does. Use a
workspace where you may install apps; a free workspace of your own keeps the
demo apart from any team's. Slash commands work on the free plan.

1. **Make the app.** <https://api.slack.com/apps> → **Create New App** →
   **Pick features** (under **From scratch**; older dialogs call it **From
   scratch**), name it `Ward Bot`, and pick the workspace. Skip the **AI
   agent** and **Starter app** templates, which expect code hosted by
   Slack. **Paste a manifest** works too if it declares both commands with
   a placeholder URL such as `https://example.com/slack/commands`; replace
   it with the address from step 3.
2. **Store its signing secret in AWS.** **Basic Information** → **App
   Credentials** → **Signing Secret** → **Show**. Then, in your terminal:

   ```bash
   scripts/seed-ssm.sh Dev
   ```

   Press Enter at every question except **Slack signing secret**, and paste
   the secret there, where nothing is shown. A value already in SSM is kept
   when you press Enter.
3. **Deploy AWS again.** `scripts/deploy-aws.sh Dev` now finds the secret and
   deploys the Slack stack. Its address for Slack:

   ```bash
   aws cloudformation describe-stacks --stack-name cloud-agentic-iot-slack-integration-Dev \
     --query "Stacks[0].Outputs[?OutputKey=='SlackCommandsUrl'].OutputValue" --output text
   ```
4. **Add the command.** In the app, **Slash Commands** → **Create New
   Command**, with that address as **Request URL**: `/patient-status`
   (hint `Test8`).
5. **Install it.** **Install App** → **Install to Workspace** → **Allow**.
6. **Try it.** In any channel: `/patient-status Test8`. The answer shows
   only to you: first "Looking up `Test8`…", then the live reading from AWS
   (or "offline since" when the board has not sent for five minutes) and the
   last event Salesforce saved, which can be hours older because Salesforce
   keeps only state changes and alerts. Slack sends no commands to a board;
   that is **Send Command** on the Asset.

If Slack says `dispatch_failed` or the command times out, the address is
wrong or the stack is not deployed; `aws logs tail
/aws/lambda/cloud-agentic-iot-slack-integration --since 10m` shows whether
the call arrived and why it was refused.

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
both together from then on.

The pipeline accounts get the same budget from the bootstrap stack. It also
runs in a project, without the GitHub role, which a project can't hold; this
has not been tried in a project yet, so if the stack fails with AccessDenied,
use the command above instead:

```bash
GITHUB_OIDC=no BUDGET_USD=20 BUDGET_EMAIL='<your email>' scripts/bootstrap-aws.sh Dev
```

A budget without actions is free, and the card
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
   (`scripts/bootstrap-aws.sh`: the OIDC deploy role and the budget) and
   [§5](SETUP.md#5-github) (`scripts/setup-github-secrets.sh`: environments,
   secrets and variables).
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

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
