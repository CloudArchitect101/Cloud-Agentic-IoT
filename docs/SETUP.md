# Setup: Accounts, Identities, Credentials

Everything needed to go from nothing to a working Dev environment, in order.
Run it once for **Dev**. **Prod is the identical sequence** against a second
Salesforce org and a second AWS account — the only differences are called out
in [Doing it again for Prod](#doing-it-again-for-prod) at the end.

What is code is a script you run (`scripts/bootstrap-aws.sh`,
`scripts/seed-ssm.sh`, `scripts/setup-github-secrets.sh`) or the pipeline
itself. What is left is billing identity, license allocation, terms only an
admin may accept, and credentials that must never pass through an automated
agent. About 90 minutes for the first run.

When a step fails, [TROUBLESHOOTING.md](TROUBLESHOOTING.md) lists every problem hit so far, with its root cause and fix.

### What stays manual, in order

Everything else is the pipeline's job. These are the steps a person does, once
per environment, in the order they come up below:

1. Sign up the Salesforce Developer Edition org, verify the email, set the
   password and register MFA (§2.1, step 1).
2. Check the licences, and that Setup shows both **Einstein Setup** and
   **Agentforce Agents**; turn both on (§2.1, steps 2 to 4).
3. Create the two service users (§2.2).
4. Deploy and assign `Metadata_Deploy` to the deploy user (§2.3, phase 1).
5. Make the two key pairs and the two External Client Apps (§2.4).
6. Create the AWS account, and `iot-operator` with
   `scripts/aws-project-policy.json` (§3.1).
7. Run `scripts/bootstrap-aws.sh` as `iot-operator` (§3.2).
8. Sign your laptop in to the org and the account (§4).
9. Run `scripts/setup-github-secrets.sh`, typing the secrets yourself (§5).
10. Start the first Deploy run, then attach `Device_Integration` to the
    Integration app and seed its real values (§6.3).
11. Give the integration user its permission set licence and permission set,
    confirm the alarm email, activate the agent and assign the permission sets
    (§6.4).
12. Make the IAM user Salesforce signs its calls with and type its access key
    into Salesforce (README, Stage 2, step 1). IAM Roles Anywhere could
    remove that key later.
13. On the `AWS_IoT_Relay` external credential, set **Additional Status Codes
    for Token Refresh** to `403` (README, Stage 2, part b). API Gateway
    answers an expired STS session with 403, and without this every call
    fails from an hour after the first one.
14. Optional: connect an MCP client to the Smart Ward MCP server (§6.5). The
    deploy creates the server, its IAM-authenticated URL and its client role;
    only your client's configuration is by hand.
15. Optional, for Data Cloud: make what Data Cloud signs in to AWS with. In
    an AWS project, the IAM user and its access key, typed into Data Cloud
    only; in a regular account, the IAM identity provider for the org's My
    Domain (§7, step 3).
16. Optional, for Data Cloud: create the Amazon S3 connection, the room
    readings data stream and its mapping to the `Room_Reading` data model
    object (§7, steps 2 and 4 to 6). The calculated insights are a script
    (§7, step 7).
17. For the ward procedures: give each care team member who uses the agent
    `AWS_IoT_Relay_Callers` as well as `Patient_Care_Agent`, because Find
    Procedure calls AWS as them (§8, step 2). The SOP index itself is built
    by every AWS deploy.
18. After the first Salesforce deploy that adds Find Procedure, deactivate
    and activate the agent again, so its active version runs the new topic
    (§8, step 3).

Not code yet, and still by hand in Stage 2 of the README: the `AWS_IoT_Relay`
named and external credentials, the `AWS_IoT_Relay_Callers` permission set
and its assignments to people (the deploy assigns it to the integration user
once it exists), queue members, and which boards are indicators (an Asset
record type, Internal Device, set per board). `Care_Team_Queue` itself ships
as metadata. They
depend on values from each org, and become per-org metadata next.

---

## 0. Prerequisites — install the tooling

Install everything first. Versions
shown are what this project was built and verified against — newer is fine.

### Salesforce CLI (`sf`) — 2.136+

The `sf` CLI is Node-based, so Node comes first:

```bash
brew install node                          # v26 here; 18+ works
npm install --global @salesforce/cli
sf --version                               # @salesforce/cli/2.136.8
```

> Do **not** install the older `sfdx` CLI. It is a different, deprecated
> binary — the modern one is `sf`, and every command in this repo uses it.
> `sf update` keeps it current; the CLI warns you when a release is available.

### AWS CLI — v2

```bash
brew install awscli
aws --version                              # aws-cli/2.34.57
```

v2 specifically: v1 is a separate package that lacks SSO login and some IoT
commands used here. If `aws --version` reports `aws-cli/1.x`, uninstall it
first — having both on PATH silently picks whichever comes first.

### GitHub CLI (`gh`)

Used to create the repo and set environment secrets from your terminal, so
credentials never pass through a browser paste buffer or a chat window.

```bash
brew install gh
gh --version                               # gh version 2.96.0
```

### arduino-cli — firmware only

Skip if you are not flashing hardware.

```bash
brew install arduino-cli
arduino-cli version                        # 1.5.1

arduino-cli config init
arduino-cli config set board_manager.additional_urls \
  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli lib install "PubSubClient" "ArduinoJson" "DHT sensor library" "ESP32Servo"
```

This is the only firmware toolchain used here, and the same one CI runs, so a
build that works locally works in the pipeline. ESP-IDF is the alternative if
you later need FreeRTOS internals or secure boot; this project does not, and
mixing toolchains gives a build two ways to diverge from CI.

### Verify everything at once

```bash
sf --version && aws --version && gh --version && arduino-cli version
```

All four must print a version before continuing.

## 1. The identities, and why there are five

The single most important idea in this setup: **deployment and runtime are
different jobs and get different identities with different permissions.** A
credential that can rewrite your Apex should not also be the one answering
device telemetry all day, and vice versa.

| # | Identity | System | Job | Can it do the other's job? |
|---|---|---|---|---|
| 1 | Signup admin | Salesforce | Setup changes, license allocation, activating the agent. Break-glass only. | — |
| 2 | `deploy@…` | Salesforce | CI/CD only: push metadata, run tests | No data-object permissions |
| 3 | `integration@…` | Salesforce | Runtime only: AWS ↔ Salesforce data traffic | No metadata permissions |
| 4 | `iot-operator` | AWS | Human console/CLI work | Cannot create users or touch billing |
| 5 | `github-actions-deploy` | AWS | CI/CD only, assumed via OIDC — **no access keys exist** | Scoped to this repo's GitHub Environment, which only its branch may use |

Plus Lambda **execution roles**, created per-function by CloudFormation, each
scoped to exactly what that function touches (the OTA relay may publish to one
MQTT topic and nothing else).

### Salesforce license allocation — read before creating users

Salesforce **Integration User** licenses are API-only (no UI login) and exist
precisely for system-to-system accounts. But:

- **Developer Edition includes 1 free Integration User license**
- **Enterprise/Unlimited/Performance include 5**; extras are ~$10/user/month

So in a Dev org you cannot make *both* service accounts Integration Users. Use:

| User | Dev Edition (what you have) | Enterprise+ (real deployment) |
|---|---|---|
| `integration@…` (runtime) | **Integration User** — the free one | Integration User |
| `deploy@…` (CI/CD) | Salesforce license (DE includes 2) | Integration User |

The runtime user gets the restricted license because it runs continuously and
touches patient data; the deploy user runs only during a pipeline execution.
In a real org, both should be Integration Users.

---

## 2. Salesforce Dev org

### 2.1 Create the org and secure the admin

1. Sign up at <https://developer.salesforce.com/signup> — free, permanent,
   ~5 MB data limit. Use an email alias you control, e.g. `you+iot-dev@…`.
2. Setup → **Company Information** → confirm your license counts. You should
   see 2 Salesforce and 1 Integration User license available.
3. Setup → **Einstein Setup** → **Turn on Einstein**. This turns on
   generative AI for the org and accepts its terms, so it is the org admin's
   decision, not something a deploy does for you.
4. Setup → **Agentforce Agents** → turn on **Agentforce**. If the page or
   the switch is missing, wait a few minutes after step 3 and reload. This
   also accepts terms, and is the admin's decision too.

Do 3 and 4 before the first deploy (§2.3, phase 2). The repo ships the
Patient Care Agent as Agent Script (`aiAuthoringBundles/`) and its actions
(`genAiFunctions/`). Expect an org
without Agentforce to refuse the agent, and one refused component fails
the whole deploy. A Developer Edition org has no charge for either
switch; agent conversations draw on its included Einstein allowance.

Why by hand: the Metadata API documents
`EinsteinGptSettings.enableEinsteinGptPlatform`, and Salesforce's Agentforce
scratch org guide switches both on with it and
`agentPlatformSettings.enableAgentPlatform`. Neither says that deploying
them to an existing Developer Edition org turns the features on without
accepting the terms in Setup, so the repo does not deploy them.

Note: For additional security, activate MFA, for sandbox/prod environmenta this is must.

### 2.2 Create the two service users

Setup → **Users** → New User, twice:

| Field | `integration@…` (runtime) | `deploy@…` (CI/CD) |
|---|---|---|
| User License | **Integration** | **Salesforce** |
| Profile | Salesforce API Only System Integrations | System Administrator (why: §2.3) |
| Username | `integration@iot-dev.<yourdomain>` | `deploy@iot-dev.<yourdomain>` |
| Gets permissions from | The `Salesforce API Integration` permission set license, then the `Device_Integration` permission set (from the repo) | Its profile, plus the `Metadata_Deploy` permission set from `scripts/` (§2.3) |

Note: For the last name, use "Integration" / "Deploy". Give each user its
own email, for example plus addresses of yours (`you+integration@…`,
`you+deploy@…`), which still reach your inbox. Never reuse the admin's
address: Slack links people to Salesforce users by email and refuses an
address that more than one active user has (see "Talk to the agent from
Slack"). The same goes for any test portal user.

Both profiles are minimal on purpose: **all** capability arrives via permission
sets. That is what makes "what can this user actually do?" answerable by
reading two permission sets rather than auditing a profile.

Sign your CLI in as the admin now; §2.3 uses it:

```bash
sf org login web --alias iot-dev-admin
```


### 2.3 The bootstrap order — read this before clicking anything

Every deployment in this project runs through GitHub Actions, **including the
first one**. But that creates a chicken-and-egg problem worth understanding,
because getting the order wrong is the most common way this setup stalls:

> The permission set that authorises the runtime user (`Device_Integration`)
> lives *in this repo*. It cannot exist in the org until something deploys it.
> So the deploy user's own permissions can never come from the repo — they must
> be granted by hand, once, before GitHub runs at all.

That gives three phases, and only the first is manual:

| Phase | Who does it | What happens |
|---|---|---|
| **1. Bootstrap** | You, in Setup UI | Turn on Einstein and Agentforce (§2.1, steps 3 and 4), and grant `deploy@…` the two permissions below. Nothing else. |
| **2. First deploy** | GitHub Actions | Deploys the entire repo — objects, Apex, LWC, the Patient Care Agent (inactive) with its planner, topic and actions, and the `Device_Integration` and `Patient_Care_Agent` permission sets |
| **3. Activation** | You, once | Give `integration@…` the Salesforce API Integration permission set license, then `Device_Integration`; activate the agent and assign `Patient_Care_Agent` to the people who use it (§6.4) |

Phases 1 and 3 are one-time. From then on, every change ships through GitHub.

**Phase 1 — make `deploy@…` able to deploy.**

> **The deploy user is a System Administrator, deliberately.** Apex tests run as
> whoever deploys, and two of ours create a **Queue** as fixture data. Creating a
> `Group` of `Type='Queue'` cannot be granted by permission: `ManageUsers` (which
> drags twelve more permissions with it) does not unlock it, nor does a role, nor
> Case access. The only route left is `ModifyAllData`, which demands thirty-three
> more permissions: System Administrator rebuilt by hand. Verified directly: the
> same Apex creating a queue succeeds as an admin and fails as a least-privilege
> deploy user, in the same org, seconds apart.
>
> The narrower fix is to rework those tests to inject queues instead of inserting
> setup objects (`CaseQueueMonitorService` already has a `testBindingOverride`
> seam for it). Worth doing before this pipeline ever points at an org with real
> data. Until then, the admin profile is what makes the pipeline work.

The `Metadata_Deploy` permission set is source-controlled at
[`scripts/Metadata_Deploy.permissionset-meta.xml`](../scripts/Metadata_Deploy.permissionset-meta.xml).
It sits in `scripts/`, not `force-app/`, on purpose: the deploy user needs it
*before* the pipeline can deploy anything, so it can't ship in the package the
pipeline deploys. Apply it once per org, as the admin:

```bash
sf project deploy start \
  --source-dir scripts/Metadata_Deploy.permissionset-meta.xml \
  --target-org iot-dev-admin

sf org assign permset --name Metadata_Deploy \
  --target-org iot-dev-admin --on-behalf-of deploy@iot-dev.<yourdomain>
```

Which system permissions it needs is decided by what the package contains.
`Modify Metadata Through Metadata API Functions` only opens the door; each
metadata type still demands its own permission behind it:

| Metadata type in this repo | System permission required |
|---|---|
| any | **API Enabled** (JWT login) and **Modify Metadata Through Metadata API Functions** |
| `ApexClass`, `ApexTrigger` | **Author Apex** |
| `LightningComponentBundle` | **Author Apex** *and* **Customize Application**. Author Apex alone fails with `insufficient access rights on entity: LightningComponentResource` |
| `CustomObject`, `CustomField`, `CustomMetadata`, `CustomApplication`, `CustomTab`, `FlexiPage`, `Layout`, `CompactLayout`, `QuickAction`, `StandardValueSet` | **Customize Application** |
| `PermissionSet`, `CustomPermission` | **Manage Profiles and Permission Sets**, **Manage Custom Permissions** |
| `GenAiFunction`, `GenAiPlannerBundle`, `GenAiPlugin` | An Agentforce permission set, not a checkbox: `CopilotSalesforceAdmin` ("Agentforce Default Admin"). `AgentPlatformBuilder` is narrower but not every org has it |
| `Bot`, `BotVersion` (the Patient Care Agent) | Einstein and Agentforce on in the org (§2.1). Expected to need the same Agentforce permission set as the GenAi types; a System Administrator deploy user covers it |

> **This gap hides longest.** Everything an admin runs locally succeeds, because
> a System Administrator holds all of these implicitly. Only a least-privilege
> deploy user sees the failure, so it reads as a CI problem rather than a
> permissions one. If you ever move the deploy user off System Administrator,
> check its effective permissions (profile plus every permission set) first.

### 2.4 Two External Apps, not one

One app per service user, each with its own certificate, so a leaked key
reaches one identity only.

**Step 1: Generate the certificates.** One key pair per app.

For the Deploy user:

```bash
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server-deploy.key -out server-deploy.crt \
  -subj "/CN=CloudAgenticIoT-Deploy/O=Personal/C=CA"
```

For the Integration user:

```bash
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server-integration.key -out server-integration.crt \
  -subj "/CN=CloudAgenticIoT-Integration/O=Personal/C=CA"
```

`.gitignore` keeps `*.key` and `*.crt` out of Git anywhere in the repo.

**Step 2: Create the External Client Apps.**

1. Setup → Quick Find → **External Client Apps** → **External Client App
   Manager** → **New External Client App** (if your view shows it).
2. Fill in the basic details for the first app, `Cloud Agentic IoT Deploy`.
3. Under **OAuth Settings**, check **Enable OAuth** and select these scopes:
   - Manage user data via APIs (`api`)
   - Perform requests at any time (`refresh_token`, `offline_access`)
4. Check **Enable JWT Bearer Flow** and upload the app's certificate from the
   table below.
5. Save the app.

Then repeat for the second app:

| App | Certificate to upload | Its user | Permission set in its policy |
|---|---|---|---|
| `Cloud Agentic IoT Deploy` | `server-deploy.crt` | `deploy@…` | `Metadata_Deploy` (§2.3) |
| `Cloud Agentic IoT Integration` | `server-integration.crt` | `integration@…` | `Device_Integration`, which the first deploy creates |

**Step 3: Authorize through the policies.** In the External Client App Manager
list, open each app's dropdown → **Manage Policies** (or edit its OAuth
policies). Set **Admin approved users are pre-authorized**, and add the app's
permission set from the table. Only users who hold that permission set can sign
in through the app.

Note: The app defines what mechanisms are technically open, but a user identity dictates who owns the data and which records they have the permission to modify.

**The known-good configuration.** For comparison when a JWT login breaks, this is
a deploy app that authenticates, with the secrets stripped:

```xml
<!-- ExtlClntAppGlobalOauthSettings -->
<certificate>…</certificate>                      <!-- present = JWT bearer flow on -->
<isNamedUserJwtEnabled>false</isNamedUserJwtEnabled>   <!-- MUST be false -->
<isClientCredentialsFlowEnabled>false</isClientCredentialsFlowEnabled>

<!-- ExtlClntAppOauthConfigurablePolicies -->
<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>
<commaSeparatedPermissionSet>Metadata_Deploy</commaSeparatedPermissionSet>
<ipRelaxationPolicyType>Bypass</ipRelaxationPolicyType>
```


---

## 3. AWS Dev account

> **Just trying it out?** [TRY-IT.md](TRY-IT.md) runs it on your own AWS project with a spend limit and a Developer Edition org, from your laptop, with no GitHub setup. Come back here when you're ready for the pipelines.

### 3.1 Root: create the account and `iot-operator`, then never again

The pipeline accounts are regular AWS accounts in `ca-central-1`. As root:

1. Create the account. Turn on MFA for root.
2. IAM → Policies → Create policy, JSON, paste
   [`scripts/aws-project-policy.json`](../scripts/aws-project-policy.json),
   name it `cloud-agentic-iot-operator`.
3. IAM → Users → Create `iot-operator`, console access on, MFA on, with that
   policy attached. Create its access key for the CLI (§4).

One more root step comes later: the IAM user Salesforce signs its calls with,
in the README's Stage 2, step 1. `iot-operator` can't make it, because its
policy denies creating users and access keys.

### 3.2 The deploy role and the budget: `scripts/bootstrap-aws.sh`

One stack per account, `cloud-agentic-iot-bootstrap-<env>`, from
[`infra/bootstrap/github-deploy.yaml`](../infra/bootstrap/github-deploy.yaml).
It holds the GitHub OIDC provider, the `github-actions-deploy` role, its
`cloud-agentic-iot-deploy` policy, and the `cloud-agentic-iot-monthly` budget
the app's Home page shows spend against. As `iot-operator` (its CLI profile
is set up in §4, AWS: do that first), from the repository root, with `gh`
signed in (`gh auth login`):

1. ```bash
   export AWS_PROFILE=iot-dev
   BUDGET_USD=20 BUDGET_EMAIL='<your email>' scripts/bootstrap-aws.sh Dev
   ```

   It checks the account's label first (on a fresh account it writes `Dev`),
   reads this repository's exact name and numeric IDs from `gh`, deploys the
   stack, and offers to store the role's ARN as the Dev environment's
   `AWS_ROLE_ARN` secret. Answer `y`, or let §5's script read it later.
2. Confirm the budget alert email AWS sends, if any arrives.
3. If the account already has a `token.actions.githubusercontent.com`
   provider, the script stops and prints the line to rerun with
   (`EXISTING_OIDC_PROVIDER_ARN=…`). If you made `cloud-agentic-iot-monthly`
   by hand earlier, delete it first, or run without `BUDGET_USD`.

Running it again is safe and keeps what you leave unset.

What the stack does, so a failed run can be read:

- **The role trusts `environment:Dev`, not `ref:refs/heads/Dev`.** Every
  deploy job declares `environment: ${{ github.ref_name }}` so that Prod can
  carry a required reviewer. Once a job references an environment, GitHub puts
  the environment in the OIDC subject claim instead of the branch, so a trust
  policy written against `ref:refs/heads/Dev` matches nothing and every run
  fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`.
- **Two subject forms.** GitHub is moving to immutable subject claims, which
  add the numeric owner and repository IDs that survive a rename
  (`repo:owner@98764954/repo@1317761754:environment:Dev`). The role trusts both.
- **The branch is pinned on the GitHub side**, by §5's script: only `Dev` may
  deploy to the `Dev` environment. Without it, any branch that can reach the
  environment could assume the role.
- **The policy is what the scripts and the stacks need**: the project's
  services, CloudFormation on `cloud-agentic-iot-*` stacks, SSM under
  `/cloud-agentic-iot/`, roles named `cloud-agentic-iot-*` passed only to
  Lambda and AWS IoT, and the alarm topic. It denies users, billing, the OIDC
  provider and the bootstrap stack itself. `test/config/deploy-policy.test.js`
  fails the checks when a script starts calling something it does not allow.
  Before turning on `AUTO_DEPLOY`, prove it once: as `iot-operator` (whose
  policy covers the role's), run `scripts/seed-ssm.sh Dev` and
  `scripts/deploy-aws.sh Dev`; an AccessDenied there names the missing action.

If a run still fails to sign in, read the claim AWS actually received:

```bash
aws cloudtrail lookup-events --region ca-central-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 3 --query 'Events[].CloudTrailEvent' --output text \
  | python3 -c "import sys,json;[print(json.loads(c)['userIdentity'].get('principalId')) for c in sys.stdin.read().split(chr(9)) if c.strip()]"
```

That prints the exact `sub` string; the role's trust has to match it.

---

## 4. Authorizing your local machine (VS Code / terminal)

### Salesforce

Three aliases per org, one per identity, so no login replaces another:

| Alias | Identity | Used for |
|---|---|---|
| `iot-dev-admin` | the signup admin | Setup work, assigning permission sets, activating the agent |
| `iot-dev-deploy` | `deploy@…` | `scripts/deploy-salesforce.sh` (§6.2) |
| `iot-dev-integration` | `integration@…` | only checking what the Lambdas can see |

```bash
sf org login web --alias iot-dev-admin           # if §2.2 did not already
```

Once the Integration app exists, add the least-privilege identity and make it
the default for day-to-day work:

```bash
sf org login jwt --client-id <INTEGRATION_CONSUMER_KEY> \
  --jwt-key-file server-integration.key \
  --username integration@iot-dev.<yourdomain> \
  --instance-url https://login.salesforce.com --alias iot-dev-integration
sf config set target-org iot-dev-integration
sf org display --target-org iot-dev-integration   # confirm: integration@, not admin
```

The `salesforce-dx` MCP server follows the default org, so this also makes
tooling operate least-privilege. The test org of [TRY-IT.md](TRY-IT.md) keeps
its one alias, `test-cloudarchitect101` (`<name>`), for the admin.

### AWS

```bash
aws configure --profile iot-dev     # iot-operator access key, region ca-central-1
aws sts get-caller-identity --profile iot-dev   # must show user/iot-operator
```

Deliberately set **no default profile**, so every command names its target and
nothing can silently run against the wrong account:

```bash
export AWS_PROFILE=iot-dev          # per shell, deliberate
```

### VS Code extensions

- **Salesforce Extension Pack** — Apex language server, org browser, deploy/retrieve
- **AWS Toolkit** — reads the profiles above

The Salesforce extensions pick up whatever `sf config set target-org` points at,
so the status bar shows which org you are about to deploy into. Check it before
every deploy.

### Firmware — already installed in §0

Install the ESP32 core and libraries once, then confirm every sketch builds:

```bash
scripts/firmware.sh setup
scripts/firmware.sh build
```

Day to day, `scripts/check.sh` runs every check the pull requests run, and
`scripts/firmware.sh flash <sketch>` puts your working copy on a board over
USB. [`DEVELOPMENT.md`](DEVELOPMENT.md) has the whole loop.

## 5. GitHub

### 5.1 Repository

```bash
gh auth login
gh repo create Cloud-Agentic-IoT --public --source=. --remote=origin
git push -u origin Dev
```

Then create `Prod` from `Dev` in the GitHub UI when you are ready to promote.
[`DEVELOPMENT.md`](DEVELOPMENT.md), "Turning it on", covers the branch rules and
the switch that lets a push deploy.

### 5.2 Environments

`scripts/setup-github-secrets.sh` (§5.3) creates each environment and its
rules: only the branch of the same name may deploy to it, and **Prod** has you
as its **required reviewer** — the only thing between a merge and a production
deployment. A required reviewer on a private repository needs a paid GitHub
plan; the script says so when GitHub refuses, and you set it in Settings →
Environments.

### 5.3 Secrets and variables, per environment

Secrets are write-only once saved. Variables are plain text — never put a
credential in one.

| Name | Type | Value | Used by |
|---|---|---|---|
| `AWS_ROLE_ARN` | Secret | `DeployRoleArn` of the bootstrap stack (§3.2) | every part: AWS deploys, the Salesforce org pairing, OTA |
| `AWS_REGION` | Variable | `ca-central-1` | all AWS jobs |
| `ALARM_EMAIL` | Variable | Optional: who the CloudWatch alarms email | the alarms stack |
| `DATA_CLOUD_OIDC_PROVIDER_ARN`, `DATA_CLOUD_EXTERNAL_ID` | Variable | Optional: what Data Cloud reads the readings archive as (§7, step 3b) | the patient-vitals stack |
| `SF_CONSUMER_KEY` | Secret | **Deploy** Connected App consumer key | Salesforce deploy |
| `SF_JWT_KEY` | Secret | `base64 -i server-deploy.key` | Salesforce deploy |
| `SF_USERNAME` | Secret | `deploy@iot-dev.<yourdomain>` | Salesforce deploy |
| `SF_LOGIN_URL` | Variable | `https://login.salesforce.com` | Salesforce deploy, and the Lambdas |
| `SF_INTEGRATION_CONSUMER_KEY` | Secret | **Integration** app consumer key | copied to SSM for the Lambdas |
| `SF_INTEGRATION_JWT_KEY` | Secret | `base64 -i server-integration.key` | copied to SSM for the Lambdas |
| `SF_INTEGRATION_USERNAME` | Secret | `integration@iot-dev.<yourdomain>` | copied to SSM for the Lambdas |
| `SLACK_SIGNING_SECRET` | Secret | Optional, from the Slack app | the Slack stack, skipped without it |

The pipeline deploys as the **deploy** app and user. The integration values are
only copied into SSM by `scripts/seed-ssm.sh`, where the Lambdas read them; one
not set yet is written as `placeholder`, so a first run still deploys (§6.3).

`AWS_REGION` must be a Region with a
`force-app/main/default/cspTrustedSites/AWS_IoT_WebSocket_<region>` file
(`ca-central-1` and `us-east-2` ship). The Live Status card connects to AWS IoT
from the browser, and Salesforce blocks any Region not listed: add one before
using a new Region. The script warns when it is missing. OTA needs nothing:
the firmware bucket and the role AWS IoT signs download links with come from
the `ota` stack.

One more value is a **repository** variable rather than an environment one,
because it decides whether a push deploys at all: `AUTO_DEPLOY`, set to `Dev`
and later `Dev Prod`.

Enter the values yourself, in your own terminal, so they never appear in any
transcript:

1. ```bash
   export AWS_PROFILE=iot-dev       # so it can read the role ARN from the bootstrap stack
   ./scripts/setup-github-secrets.sh
   ```
2. Choose `Dev`. It sets the environment's rules, then asks for each value in
   the table, hiding secrets, and reads the two key files and base64-encodes
   them itself (`scripts/server-deploy.key`, `scripts/server-integration.key`).
   No Integration app yet? Press Enter at its three prompts; §6.3 comes back
   to them.
3. Answer `n` to `AUTO_DEPLOY` until the first manual run is green (§6.3).

One value by hand, if you need to change it later:

```bash
gh secret set AWS_ROLE_ARN --env Dev
base64 < scripts/server-deploy.key | gh secret set SF_JWT_KEY --env Dev
```

---

## 6. Verify, in order

### 6.1 Local identities resolve

```bash
aws sts get-caller-identity --profile iot-dev   # expect user/iot-operator, never root
sf org display --target-org iot-dev-admin       # expect the signup admin
sf org display --target-org iot-dev-integration # expect integration@..., never the admin
```

### 6.2 The deploy user can actually deploy — check before pushing

This is the step that catches a wrong permission set or a broken Connected App
*before* a red pipeline makes you guess which of six credentials is at fault.
Authenticate as the deploy user exactly as GitHub will, then dry-run:

```bash
sf org login jwt --client-id <DEPLOY_CONSUMER_KEY> \
  --jwt-key-file server-deploy.key \
  --username deploy@iot-dev.<yourdomain> \
  --instance-url https://login.salesforce.com --alias iot-dev-deploy

# --dry-run validates everything and commits nothing
sf project deploy start --dry-run --target-org iot-dev-deploy
```

If that succeeds, the pipeline will too — it runs the same command with the
same identity. If it fails on privileges, revisit §2.3.

`scripts/deploy-salesforce.sh Dev --dry-run` runs the same check-only deploy
with every local Apex test, and checks that `iot-dev-deploy` is the org paired
with the AWS account `AWS_PROFILE` points at (nothing is paired yet on a first
run, which it says).

### 6.3 The real first deployment, via GitHub

A brand-new environment can't have everything at once: the Integration app's
policy needs `Device_Integration`, which only the first Salesforce deploy
creates. The seed step writes `placeholder` for any integration value with no
secret yet, so the first run deploys AWS, then Salesforce, in one go.

1. Have both External Client Apps saved (§2.4, steps 1 and 2). The Integration
   app's consumer key exists as soon as it is saved, before its policy lists a
   permission set, so §5.3 can already store all six `SF_*` secrets. If it
   doesn't exist yet, leave its three empty.
2. Actions → **Deploy** → *Run workflow* → branch `Dev` → part `everything`.
   It runs the checks, seeds SSM, deploys every stack and the Lambda code,
   validates and deploys `force-app/` with every local Apex test, pairs the org
   with the account (`/cloud-agentic-iot/salesforce/org-id`), and records the
   commit (`/cloud-agentic-iot/deployed-commit/aws` and `/salesforce`).
3. Once it is green, finish §2.4 step 3 for the Integration app: add
   `Device_Integration` to its policy.
4. If step 1 left the integration secrets empty, store them now (rerun
   `./scripts/setup-github-secrets.sh`, or `gh secret set` the three), then run
   Deploy again with part `aws`, so the functions sign in with the real values.
5. Switch pushes on:

   ```bash
   gh variable set AUTO_DEPLOY --body "Dev"
   ```

A green run means every secret in §5.3 is correct.

### 6.4 Then finish the bootstrap

If you set `ALARM_EMAIL`, AWS emailed that address after the first deploy:
click **Confirm subscription**, or no alarm reaches you.

The permission set license comes first: the Integration user license alone
doesn't allow `Device_Integration`'s object permissions, such as Create on
Assets.

```bash
sf org assign permsetlicense --name SalesforceAPIIntegrationPsl \
  --on-behalf-of integration@iot-dev.<yourdomain> --target-org iot-dev-admin
sf org assign permset --name Device_Integration \
  --on-behalf-of integration@iot-dev.<yourdomain> --target-org iot-dev-admin
```

Admins who should see the app's Home page, with this month's AWS spend and
the org's limits, need `Platform_Usage_Viewer`. Its AWS half also needs the
`AWS_IoT_Relay_Callers` permission set (README, Stage 2 part d):

```bash
sf org assign permset --name Platform_Usage_Viewer --target-org iot-dev-admin
```

Then the agent. The deploy created the **Patient Care Agent** and left it
inactive deliberately: an agent that can create clinical Cases should be
switched on by a person, not by a deploy.

1. Publish and activate it, as the admin. Publishing compiles the Agent
   Script into a new version; `--json` without `--version` activates the
   newest one (without either, the command stops to ask).

   ```bash
   sf agent publish authoring-bundle --api-name Patient_Care_Agent --target-org iot-dev-admin
   sf agent activate --api-name Patient_Care_Agent --target-org iot-dev-admin --json
   ```

   Or Setup → **Agentforce Agents** → **Patient Care Agent** → **Activate**.
2. Check that it took:

   ```bash
   sf data query --target-org iot-dev-admin \
     --query "SELECT VersionNumber, Status FROM BotVersion WHERE BotDefinition.DeveloperName = 'Patient_Care_Agent'"
   ```

   Expect the newest version with Status `Active`.
3. Assign the `Patient_Care_Agent` permission set to each care team member who
   will use the agent, yourself included. It opens the agent to them and gives
   its three actions what they read and create: the device's readings and
   connection fields, the ward procedures (whose callout also needs
   `AWS_IoT_Relay_Callers`, §8), and a Case for Care_Team_Queue. An employee agent runs
   as the person talking to it, so there is no agent user to set up.

   ```bash
   sf org assign permset --name Patient_Care_Agent --target-org iot-dev-admin
   sf org assign permset --name Patient_Care_Agent --target-org iot-dev-admin \
     --on-behalf-of <care team member's username>
   ```

That is the end of setup. Everything after this ships through GitHub.

### 6.5 Optional: the guardrails and the MCP server

Nothing to set up for either to work. Every deploy ships both stacks:
`cloud-agentic-iot-guardrails-<env>` and `cloud-agentic-iot-mcp-server-<env>`.
The guardrails then run inside device-command on every command, Salesforce's
included. Check them once after the first deploy:

```bash
aws lambda invoke --function-name cloud-agentic-iot-guardrails --cli-binary-format raw-in-base64-out \
  --payload '{"phase":"command","operation":"REBOOT"}' /dev/stdout
```

Expect `"allowed":false` with `unknown_operation`.

The MCP server answers only SigV4-signed requests. `scripts/deploy-aws.sh`
ends by printing its endpoint and the `McpClientRole` ARN. To use it from an
MCP client (Claude Code, Claude Desktop, any client that runs a local stdio
server), follow [GUARDRAILS-AND-MCP.md, Connect an MCP
client](GUARDRAILS-AND-MCP.md#connect-an-mcp-client). Salesforce needs nothing:
the Patient Care Agent keeps its Apex actions.

---

## 7. Data Cloud: room readings for the ward

Optional. Every room reading reaches Data Cloud from the S3 archive, and two
calculated insights say, per device, how long its room was at or above
30.0 C each day and whether it has gone quiet.
[DATA-CLOUD.md](DATA-CLOUD.md) explains the path and how to check each step;
this is the order to set it up. It needs Data Cloud (Data 360 in newer orgs)
provisioned in the org, and you signed in as an admin with the **Data Cloud
Architect** permission set or the System Administrator profile.

Two ways to let Data Cloud read the bucket; use the one your AWS side allows:

| Your AWS side | Data Cloud signs in with | Step 3 |
|---|---|---|
| An AWS project with a spend limit ([TRY-IT.md](TRY-IT.md)) | An access key of an IAM user you make | 3a |
| A regular account (the pipelines) | A role, through the org's own identity provider. No key | 3b |

A project cannot hold an IAM identity provider, so the role is not possible
there.

1. **Turn the CSV copy on.** `DataCloudExport` is `"true"` in
   `config/Dev.json` (and `"false"` in `config/Prod.json`), so the next AWS
   deploy turns it on:

   ```bash
   scripts/deploy-aws.sh Dev
   aws cloudformation describe-stacks --stack-name cloud-agentic-iot-patient-vitals-Dev \
     --query "Stacks[0].Outputs[?OutputKey=='ArchiveBucketName' || OutputKey=='DataCloudFolder'].[OutputKey,OutputValue]" \
     --output text
   ```

   The second command prints the bucket name for step 2, and
   `datacloud/room-readings/`. Within a minute of a board sending, CSV files
   appear there ([DATA-CLOUD.md, Check each step](DATA-CLOUD.md#check-each-step)).
   S3 has no folders: the prefix appears with the first CSV, which is written
   only when a board sends a reading. Right after the deploy, or while every
   board is off, `datacloud/room-readings/` does not exist yet; power a board
   on (one with a DHT11) and look again a minute later. The connection in
   step 2 can be made before that.
2. **Start the connection.** Data Cloud Setup → **Other Connectors** (some orgs
   list it under External Integrations, or as **More Connectors**) → **New** →
   **Amazon S3**. Name it `Room Readings S3`. **Bucket Name**: the bucket from
   step 1. **Parent Directory**: `datacloud/room-readings/`. Authentication:
   - In an AWS project: **Access Key/Secret Based**. Leave the page open for
     step 3a.
   - In a regular account: **Identity Provider (IdP) Based**. Copy the
     **External ID** it shows and leave the page open for step 3b.
3. **Give Data Cloud read access in AWS.** Everything it may do is in the
   template: list and read `datacloud/`, nothing else. What is left is the
   identity, which the deploy identities may not make.

   **3a. AWS project: the IAM user and its key.** In your own terminal,
   signed in as the project's profile (`aws login`, as in [TRY-IT.md](TRY-IT.md)),
   from the repository root. The user has no policy of its own; the bucket
   policy the deploy writes lets it read `datacloud/`. Make the user before
   the deploy names it: S3 refuses a bucket policy for a user that does not
   exist.

   ```bash
   READER=cloud-agentic-iot-data-cloud-reader
   aws iam get-user --user-name "$READER" > /dev/null 2>&1 || aws iam create-user --user-name "$READER" > /dev/null
   DATA_CLOUD_READER_USER="$READER" scripts/deploy-aws.sh Dev
   aws iam create-access-key --user-name "$READER"
   ```

   `create-access-key` prints the key once. Type its `AccessKeyId` and
   `SecretAccessKey` into the connection's **AWS Access Key** and **AWS
   Secret Key** fields from step 2, and nowhere else: not a file, not the
   repo, not a chat. Later deploys keep the user's grant without
   `DATA_CLOUD_READER_USER`. To rotate the key, make a second one, put it in
   the connection, then `aws iam delete-access-key` the first.

   **3b. Regular account: the identity provider and the role.** As an
   identity that may create IAM identity providers (root, or an admin; the
   `github-actions-deploy` role and `iot-operator` may not), with your My
   Domain from Setup → **My Domain** (for example
   `yourdomain.my.salesforce.com`, no `https://`) and the External ID from
   step 2:

   ```bash
   MY_DOMAIN=<your My Domain>
   aws iam create-open-id-connect-provider \
     --url "https://$MY_DOMAIN/services/connectors" --client-id-list "https://$MY_DOMAIN"
   PROVIDER_ARN="arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):oidc-provider/$MY_DOMAIN/services/connectors"
   gh variable set DATA_CLOUD_OIDC_PROVIDER_ARN --env Dev --body "$PROVIDER_ARN"
   gh variable set DATA_CLOUD_EXTERNAL_ID --env Dev --body '<External ID>'
   ```

   Then run Deploy with part `aws` (§6.3), or, as `iot-operator`,
   `DATA_CLOUD_OIDC_PROVIDER_ARN="$PROVIDER_ARN" DATA_CLOUD_EXTERNAL_ID='<External ID>' scripts/deploy-aws.sh Dev`.
   The stack creates `cloud-agentic-iot-data-cloud-reader`, which trusts only
   that connection. Its ARN is the stack's `DataCloudReaderRoleArn` output:
   paste it into the connection's **IAM Role Name**.
4. **Test and save the connection.** **Test Connection**, then **Save**. If
   the test fails, [DATA-CLOUD.md, If a step fails](DATA-CLOUD.md#if-a-step-fails)
   lists the usual causes.
5. **Create the data stream.** Data Streams → **New** → **Amazon S3** → the
   connection from step 2.
   - **File Type** CSV. **Import from Directory** empty, so it reads the
     connection's Parent Directory. **File Name** `room-readings-*.csv`.
     **Source** `AWS IoT`.
   - A new data lake object, **Room Readings** (`Room_Readings`). Give the
     fields the types in [`datacloud/room-readings.columns.json`](../datacloud/room-readings.columns.json):
     `reading_ts` and `received_ts` DateTime, `temperature_c` and
     `humidity_pct` Number, the rest Text.
   - Category **Engagement**, primary key `reading_id`, event time field
     `reading_ts`.
   - Data space: default. Refresh mode **Upsert**, so each run takes only new
     files and a reading seen twice stays one record. Schedule: the most
     frequent the org offers.
   - **Deploy**, then **Refresh Now** once to import what is already there.
6. **Map it to the data model.** On the stream, **Start** the data mapping →
   **New Custom Object**, `Room_Reading`, with every field of the stream under
   the same name and `reading_id` as its primary key. Data Cloud names them
   `reading_id__c` and so on, on `Room_Reading__dlm`; the insights in step 7
   read exactly those names. Save.
7. **Create the calculated insights.** Once step 6's object has rows
   ([DATA-CLOUD.md, Check each step](DATA-CLOUD.md#check-each-step), item 4),
   as the admin:

   ```bash
   SF_TARGET_ORG=<your admin alias> scripts/data-cloud-insights.sh --dry-run
   SF_TARGET_ORG=<your admin alias> scripts/data-cloud-insights.sh
   ```

   It creates `Room_Out_Of_Range_Daily__cio` and `Room_Device_Silence__cio`
   from the SQL in `datacloud/calculated-insights/`, and leaves one that
   exists already alone. If Data Cloud refuses one, paste its SQL into
   Calculated Insights → **New** → **Create with SQL**; **Check Syntax**
   names the problem. Then set each insight's schedule to the most frequent
   the org offers.
8. **Keep it as metadata, for the next org.** Data Cloud metadata is moved
   with a data kit built in an org that has it, not written by hand. Data
   Cloud Setup → **Data Kits** → **New**, type **DevOps**, add the data
   stream, its mapping and the two insights → **Download Manifest**, saved as
   `datacloud/kit/package.xml`. Then:

   ```bash
   sf project retrieve start --manifest datacloud/kit/package.xml \
     --output-dir datacloud/kit/source --target-org <your admin alias>
   find datacloud/kit/source -name 'KQ_*' -exec rm {} \;
   ```

   It sits outside `force-app/` on purpose: `scripts/deploy-salesforce.sh`
   deploys all of `force-app/` together, and a Data Cloud component another
   org refuses would fail that whole deploy. Deploying the kit to another org
   is `sf project deploy start --source-dir datacloud/kit/source --target-org
   <alias>`, after its connection exists there (steps 2 to 4): the
   connection's credential never travels with a kit. This repo does not ship
   a retrieved kit yet.

---

## 8. Ward procedures for the agent

The Patient Care Agent's **Find Procedure** action answers "what do I do?"
from the ward's sample SOPs in `knowledge/sops/`, and the agent cites the
SOP ID and version it used. [SOP-GROUNDING.md](SOP-GROUNDING.md) explains
the design, the cost (under a cent a month for a demo) and how to check
each step. Almost all of it is the deploy's job:

1. **Nothing to do in AWS.** `scripts/deploy-aws.sh Dev` deploys the
   `cloud-agentic-iot-knowledge-indexer-Dev` stack (the index bucket and two
   functions) and the device API's `POST /find-procedure` route, then runs
   `scripts/index-sops.sh Dev`, which embeds the SOPs with Titan Text
   Embeddings V2 in the account's Region. Expect its last step to print
   `indexed: 7 SOP(s), 24 passage(s)`. If it names Bedrock, check in the
   Bedrock console that the model is available in that Region
   ([SOP-GROUNDING.md, If a step fails](SOP-GROUNDING.md#if-a-step-fails)).
   A new account may not be authorized for Bedrock yet (`Operation not
   allowed`, `authorizationStatus` `NOT_AUTHORIZED`): that takes a free
   Support case under Account and billing, and no IAM change fixes it.
   Until then, `SKIP_SOP_INDEX=yes scripts/deploy-aws.sh Dev` deploys
   everything else; once the case is resolved, run
   `scripts/index-sops.sh Dev --force` once, as the skipped deploy built
   no index.
2. **Who may ask.** The action calls AWS as the person talking to the
   agent, through the `AWS_IoT_Relay` Named Credential, so each care team
   member needs `AWS_IoT_Relay_Callers` (README, Stage 2 part d) besides
   `Patient_Care_Agent` (§6.4), which opens the action's class:

   ```bash
   sf org assign permset --name AWS_IoT_Relay_Callers --target-org iot-dev-admin \
     --on-behalf-of <care team member's username>
   ```
3. **Reactivate the agent once.** The deploy changes the topic and adds an
   action to the agent, which an active agent may keep running as it was,
   and an org may refuse to change an active agent at all. Deactivate it
   before the Salesforce deploy that adds Find Procedure, and activate it
   after:

   ```bash
   sf agent deactivate --api-name Patient_Care_Agent --target-org iot-dev-admin
   scripts/deploy-salesforce.sh Dev
   sf agent activate --api-name Patient_Care_Agent --target-org iot-dev-admin --json
   ```
4. **Try it.** Ask the agent what to do about a room reading 31 C, and check
   the answer cites `SOP-WARD-001 v1.2`.

To change a procedure, edit its file in `knowledge/sops/`, raise its
`version`, commit, and deploy AWS again (or run `scripts/index-sops.sh Dev`
for an SOP-only change). Unchanged SOPs are not embedded again.

---

## Talk to the agent from Slack (optional)

The Smart Ward app in [TRY-IT](TRY-IT.md#ask-the-ward-from-slack) answers two
fixed commands. To ask the Patient Care Agent questions in Slack, use
Salesforce's own Agentforce in Slack: the same agent, topics and actions,
answering as the Salesforce user each Slack member is mapped to, so their
access in Salesforce still decides what they see. No code of ours is
involved.

What it needs, from [Slack's help](https://slack.com/help/articles/36218109305875-Set-up-and-manage-Agentforce-in-Slack):
any Slack plan, Free included (Free lacks only the canvas action); an
Agentforce licence in the org; and an **Employee** agent, which
Patient Care Agent is (`InternalCopilot`). Whether a Developer Edition can
connect to Slack is not stated outside Trailhead's Agentforce Developer
Edition; step 3 below is where that shows. If it cannot, the fallback is a
slash command that calls the agent through the Agent API from
`lambda/slack-integration`.

Salesforce side, as an admin:

1. The agent must be active, as the newest version:
   `sf agent activate --api-name Patient_Care_Agent --target-org "$SF_TARGET_ORG" --json`
2. The shipped Agent Script already ends with `connection slack:`, so a
   published version is a Slack agent. An agent made in the legacy builder
   offers no Slack under **Connections** (only Messaging and Agentforce
   Mobile) until it is upgraded to the new builder; do not add those two to
   an employee agent, as a connection cannot be removed.

Slack side, as the workspace owner:

3. **Tools & settings** → **Manage Salesforce Organizations** → **Connect
   Salesforce Org**: the org's My Domain URL, account mapping field
   **Email**, **Automatic account mapping** off, **Request Connection**.
   Approve it in Salesforce (**Setup** → Quick Find **Slack** → **Manage
   Slack Connection**), then back in **Manage Salesforce Organizations**
   open the pending connection and **Activate** it.
4. Only now does the org have a **Users** tab (same page → the org →
   **Users** → **Add Individually**): link each Slack member who may use the
   agent; Slack asks them to sign in to Salesforce. An unmapped member
   cannot use the agent. Each member's Slack email must belong to exactly
   one active Salesforce user; if the row says **Authentication failed**
   ("multiple users in Salesforce with the same email"), give the other
   users their own emails, or **Add Individually** by Salesforce username.
   Each member's Salesforce user also needs the **Sales Cloud for Slack**
   permission set (`SlackSalesCloud`, which grants Slack capabilities) as
   well as `Patient_Care_Agent`:
   `sf org assign permset --name SlackSalesCloud --on-behalf-of <username> --target-org "$SF_TARGET_ORG"`.
   Quit and reopen Slack after changing either.
5. **Admin** → **Manage Agentforce** → **Review agent** → **Install Agent**.
6. DM the agent, or mention it in a channel: "What is Test8 reading?"

## Doing it again for Prod

**The same sequence**, with these differences:

| Step | Change for Prod |
|---|---|
| Salesforce org | A second Developer org (or a real EE org). Same two service users, same two Connected Apps, fresh keypairs — never reuse Dev's keys. |
| AWS account | A second standalone account in `ca-central-1`. Same `iot-operator`; run `scripts/bootstrap-aws.sh Prod` from your laptop (the pipeline cannot create the role it signs in with), which makes a role that trusts `environment:Prod`. |
| GitHub | `./scripts/setup-github-secrets.sh`, choosing `Prod`: same secret names, different values, and you as the required reviewer. |
| Salesforce aliases | `iot-prod-admin`, `iot-prod-deploy`, `iot-prod-integration`. |
| AWS Organizations | Only after the free-credit phase — see `MIGRATION-RUNBOOK.md` phase 1. |
| Ward procedures (§8) | The same SOPs are indexed by the Prod deploy. Check Titan Text Embeddings V2 is available in `ca-central-1` before the first one: the index step fails, naming Bedrock, if it is not. |

Reusing a Dev certificate or role ARN in Prod silently collapses the two
environments into one and removes the entire point of having them.
