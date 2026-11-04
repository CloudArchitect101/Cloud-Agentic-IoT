# Try it in a capped AWS sandbox

Cloned this repo to learn or experiment? Run the AWS side in an AWS **project**
with a spend limit, and deploy it from your laptop. At the limit AWS pauses the
project instead of billing you more, so a bug or a loop cannot run up a large
bill. You skip the GitHub setup until you need it.

When you are ready for the pipelines, move to a regular AWS account:
[Moving to the pipelines](#moving-to-the-pipelines). Salesforce needs no
sandbox of its own, because Developer Edition orgs are free.

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

## 1. Create the project

1. Sign up through the new AWS experience, or add a project in
   [AWS Settings](https://settings.aws.com).
2. Upgrade to the paid plan, then set a monthly spend limit. The lowest is $20.
3. Note the project's Region: AWS Settings, **Projects**, your project,
   **Overview**, **Additional Info**.

## 2. Sign the AWS CLI in to the project

`aws login` needs AWS CLI 2.32.0 or later. It opens a browser, and you choose
your project to finish signing in. Give the project's Region when it asks.

```bash
aws login --profile iot-sandbox
export AWS_PROFILE=iot-sandbox     # per shell, as in DEVELOPMENT.md
aws sts get-caller-identity        # shows the project's account ID
```

The credentials refresh themselves and last up to 12 hours. Run the same
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

No Salesforce org yet? Put `placeholder` as each value. The stacks deploy, and
only the calls to Salesforce fail until you replace the values with
`--overwrite`.

## 4. Deploy and test

```bash
scripts/check.sh            # no credentials needed
scripts/deploy-aws.sh Dev   # every stack and the real Lambda code
```

The sandbox is your Dev environment. Its first deploy labels the account `Dev`
in SSM (`/cloud-agentic-iot/environment`), and the rest of
[DEVELOPMENT.md, "On your laptop"](DEVELOPMENT.md#1-on-your-laptop) works
against it unchanged: flash a board, watch it, deploy Salesforce to a free
Developer Edition org. Boards are provisioned the same way as in the
[README, Stage 3](../README.md#stage-3--hardware), against the sandbox's IoT
endpoint.

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
3. Copy anything you want to keep out of the sandbox's S3 buckets and DynamoDB
   table, then delete its `cloud-agentic-iot-*` stacks, or close the project.

## Sources

- [AWS reimagines the getting started experience](https://aws.amazon.com/blogs/aws/aws-reimagines-the-getting-started-experience/): spend limits from $20, pausing, the 90-day deletion
- [New AWS builder experience (What's New, September 2026)](https://aws.amazon.com/about-aws/whats-new/2026/09/New-AWS-Builder-Experience)
- [Service and resource control policies for projects](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html): the identity-provider block, what is denied near the limit, the organization-only trust
- [Activate advanced features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html): removes spend limits, can't be reversed
- [Project Regions](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html)
- [Connect an AI coding tool](https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html) and [Login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html): `aws login`, CLI 2.32.0, 12-hour sessions
