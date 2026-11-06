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
```

That assigns the set to you, in the org `SF_TARGET_ORG` names. Open the app from
the App Launcher. In an org without Person Accounts, any Account will do for a
device's Account.

## 5. Connect the org and the project

Each direction has its own identity, made once.

**AWS to Salesforce** (readings and alerts) signs in as the integration user:

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

The deploy at the end is needed. Two functions sign in to Salesforce as the
integration user: `cloud-agentic-iot-salesforce-sync` for readings and
`cloud-agentic-iot-alert-dispatcher` for alerts. CloudFormation copies the
username and consumer key from SSM into their settings only when it deploys, so
until then they still hold `placeholder`. They read the private key from SSM
each time they sign in, so it needs no deploy.

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
not started, so a board that was offline installs only the newest. A board
answers SUCCEEDED once the build is written, just before it restarts into it,
so the serial console is where you see the new build start: first
`OTA: complete, restarting` and, after the restart,
`aws: connected, patient-monitor v<version>-try.<n>`: the board kept its Wi-Fi
and certificate, which live in NVS, outside the part of the flash an update
rewrites. A try costs one upload and one job execution per board, a fraction
of a cent.

## What happens near the limit

- As spending nears the limit, AWS denies Lambda invocations, Bedrock calls and
  new compute in the project. Readings stop flowing, which is the point.
- At the limit, AWS pauses the project and stops its resources for the rest of
  that month. Your data is kept. To resume, raise the limit in AWS Settings;
  some resources may need a manual restart.
- A paused project left untouched for 90 days is deleted, after reminder emails.

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
