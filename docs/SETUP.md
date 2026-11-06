# Setup: Accounts, Identities, Credentials

Everything needed to go from nothing to a working Dev environment, in order.
Run it once for **Dev**. **Prod is the identical sequence** against a second
Salesforce org and a second AWS account — the only differences are called out
in [Doing it again for Prod](#doing-it-again-for-prod) at the end.

Nothing here can be scripted safely: it involves billing identity, license
allocation, and credentials that must never pass through an automated agent.
About 90 minutes for the first run.

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
| 5 | `github-actions-deploy` | AWS | CI/CD only, assumed via OIDC — **no access keys exist** | Scoped to this repo + branch |

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

Note: For additional security, activate MFA, for sandbox/prod environmenta this is must.

### 2.2 Create the two service users

Setup → **Users** → New User, twice:

| Field | `integration@…` (runtime) | `deploy@…` (CI/CD) |
|---|---|---|
| User License | **Integration** | **Salesforce** |
| Profile | Salesforce API Only System Integrations | System Administrator (why: §2.3) |
| Username | `integration@iot-dev.<yourdomain>` | `deploy@iot-dev.<yourdomain>` |
| Gets permissions from | The `Salesforce API Integration` permission set license, then the `Device_Integration` permission set (from the repo) | Its profile, plus the `Metadata_Deploy` permission set from `scripts/` (§2.3) |

Note: For the last name, you can use "Integration" / "Deploy" and reuse your original email address for that ORG.

Both profiles are minimal on purpose: **all** capability arrives via permission
sets. That is what makes "what can this user actually do?" answerable by
reading two permission sets rather than auditing a profile.

Note: You can skipp ### 2.3 - 2.4 and authorize user in you VS CODE:
sf org login web --set-default --alias iot-dev 


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
| **1. Bootstrap** | You, in Setup UI | Grant `deploy@…` the two permissions below. Nothing else. |
| **2. First deploy** | GitHub Actions | Deploys the entire repo — objects, Apex, LWC, the agent, and the `Device_Integration` permission set |
| **3. Activation** | You, once | Give `integration@…` the Salesforce API Integration permission set license, then `Device_Integration`; activate the agent |

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
  --target-org iot-dev

sf org assign permset --name Metadata_Deploy \
  --target-org iot-dev --on-behalf-of deploy@iot-dev.<yourdomain>
```

Which system permissions it needs is decided by what the package contains.
`Modify Metadata Through Metadata API Functions` only opens the door; each
metadata type still demands its own permission behind it:

| Metadata type in this repo | System permission required |
|---|---|
| any | **API Enabled** (JWT login) and **Modify Metadata Through Metadata API Functions** |
| `ApexClass`, `ApexTrigger` | **Author Apex** |
| `LightningComponentBundle` | **Author Apex** *and* **Customize Application**. Author Apex alone fails with `insufficient access rights on entity: LightningComponentResource` |
| `CustomObject`, `CustomField`, `CustomMetadata`, `CustomApplication`, `CustomTab`, `FlexiPage`, `Layout`, `CompactLayout`, `QuickAction` | **Customize Application** |
| `PermissionSet`, `CustomPermission` | **Manage Profiles and Permission Sets**, **Manage Custom Permissions** |
| `GenAiFunction`, `GenAiPlannerBundle`, `GenAiPlugin` | An Agentforce permission set, not a checkbox: `CopilotSalesforceAdmin` ("Agentforce Default Admin"). `AgentPlatformBuilder` is narrower but not every org has it |

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

### 3.1 Root: three actions, then never again

Sign in as root, then:
IAM → Users → Create `iot-operator`, console access on, MFA on.
Create and assign policy from `scripts/aws-project-policy.json`

One more root step comes later: the IAM user Salesforce signs its calls with, in the README's Stage 2, step 1. `iot-operator` can't make it, because that policy denies creating users and access keys.

Note: the AWS Free plan is only for new AWS customers. If you have, or ever had, an AWS account, this one starts on the paid plan, so create an AWS Budget with an email alert (Billing and Cost Management → Budgets) before you deploy anything.

### 3.2 GitHub Actions deploy role — OIDC, no keys

Run as `iot-operator`, once per account:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

# Fill in scripts/trust-policy.json: your account ID, GitHub owner, and the
# two numeric IDs printed by:
gh api repos/YOUR_GH_USERNAME/Cloud-Agentic-IoT --jq '"owner: \(.owner.id)  repo: \(.id)"'

aws iam create-role --role-name github-actions-deploy \
  --assume-role-policy-document file://scripts/trust-policy.json
aws iam attach-role-policy --role-name github-actions-deploy \
  --policy-arn arn:aws:iam::aws:policy/AWSCloudFormationFullAccess
```

> **`environment:Dev`, not `ref:refs/heads/Dev`.** Every AWS workflow here declares
> `environment: ${{ github.ref_name }}` so that Prod can carry a required-reviewer
> rule. Once a job references an environment, GitHub puts the environment in the
> OIDC subject claim instead of the branch, so a trust policy written against
> `ref:refs/heads/Dev` matches nothing and every run fails with `Not authorized to
> perform sts:AssumeRoleWithWebIdentity`. For Prod, create the same role in the
> Prod account with `environment:Prod`.

`scripts/trust-policy.json` lists two `sub` patterns because GitHub is moving to
**immutable subject claims**, which add numeric owner and repository IDs that
survive a rename (`repo:owner@98764954/repo@1317761754:environment:Dev`). Listing
both works either way.

Because the environment replaced the branch in the claim, pin the branch on the
GitHub side: **Settings → Environments → Dev → Deployment branches**, limited to
`Dev`. Without it, any branch that can reach the `Dev` environment can assume the
role.

If a run still fails, read the claim AWS actually received:

```bash
aws cloudtrail lookup-events --region <your region> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 3 --query 'Events[].CloudTrailEvent' --output text \
  | python3 -c "import sys,json;[print(json.loads(c)['userIdentity'].get('principalId')) for c in sys.stdin.read().split(chr(9)) if c.strip()]"
```

That prints the exact `sub` string; the trust policy has to match it.

Save the role ARN — it becomes the `AWS_ROLE_ARN` secret.

---

## 4. Authorizing your local machine (VS Code / terminal)

### Salesforce

```bash
sf org login web --alias iot-dev
sf config set target-org iot-dev        # admin: Setup work
```

Once the Connected App exists, add the least-privilege identity and make it
the default for day-to-day work:

```bash
sf org login jwt --client-id <INTEGRATION_CONSUMER_KEY> \
  --jwt-key-file server-integration.key \
  --username integration@iot-dev.<yourdomain> \
  --instance-url https://login.salesforce.com --alias iot-dev
sf config set target-org iot-dev
sf org display --target-org iot-dev           # confirm: integration@, not admin
```

The `salesforce-dx` MCP server follows the default org, so this also makes
tooling operate least-privilege.

### AWS

```bash
aws configure --profile iot-dev     # iot-operator access key, region us-east-1
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

Settings → **Environments** → create `Dev` and `Prod`. On **Prod**, add a
**required reviewer** (yourself) — that click is the only thing between a merge
and a production deployment.

### 5.3 Secrets and variables, per environment

Secrets are write-only once saved. Variables are plain text — never put a
credential in one.

| Name | Type | Value | Used by |
|---|---|---|---|
| `AWS_ROLE_ARN` | Secret | Role ARN from §3.2 | AWS deploys, OTA |
| `AWS_REGION` | Variable | `us-east-1` | all AWS jobs |
| `SF_CONSUMER_KEY` | Secret | **Deploy** Connected App consumer key | Salesforce deploy |
| `SF_JWT_KEY` | Secret | `base64 -i server-deploy.key` | Salesforce deploy |
| `SF_USERNAME` | Secret | `deploy@iot-dev.<yourdomain>` | Salesforce deploy |
| `SF_LOGIN_URL` | Variable | `https://login.salesforce.com` | Salesforce deploy, and the Lambdas |
| `SF_INTEGRATION_CONSUMER_KEY` | Secret | **Integration** app consumer key | copied to SSM for the Lambdas |
| `SF_INTEGRATION_JWT_KEY` | Secret | `base64 -i server-integration.key` | copied to SSM for the Lambdas |
| `SF_INTEGRATION_USERNAME` | Secret | `integration@iot-dev.<yourdomain>` | copied to SSM for the Lambdas |
| `SLACK_SIGNING_SECRET` | Secret | Optional, from the Slack app | the Slack stack, skipped without it |

The pipeline deploys as the **deploy** app and user. The integration values are
only copied into SSM, where the Lambdas read them at runtime; the patient-vitals
and streaming stacks will not deploy until they are there. OTA needs nothing:
the firmware bucket and the role AWS IoT signs download links with come from
the `ota` stack.

One more value is a **repository** variable rather than an environment one,
because it decides whether a push deploys at all: `AUTO_DEPLOY`, set to `Dev`
and later `Dev Prod`.

Enter values yourself — via the GitHub UI, from your own terminal so they
never appear in any transcript, or with `./scripts/setup-github-secrets.sh`,
which asks for each value and hides what you type:

```bash
gh secret set AWS_ROLE_ARN --env Dev
base64 -i server-deploy.key | gh secret set SF_JWT_KEY --env Dev
```

---

## 6. Verify, in order

### 6.1 Local identities resolve

```bash
aws sts get-caller-identity --profile iot-dev   # expect user/iot-operator, never root
sf org display --target-org iot-dev             # expect integration@..., never the admin
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

### 6.3 The real first deployment, via GitHub

Actions tab → **Deploy** → *Run workflow* → branch `Dev`. Or switch pushes on
and push:

```bash
gh variable set AUTO_DEPLOY --body "Dev"
git push origin Dev
```

Watch the run. A green run means every secret in §5.3 is correct, and it is
what creates the `Device_Integration` permission set in the org.

### 6.4 Then finish the bootstrap

The permission set license comes first: the Integration user license alone
doesn't allow `Device_Integration`'s object permissions, such as Create on
Assets.

```bash
sf org assign permsetlicense --name SalesforceAPIIntegrationPsl \
  --on-behalf-of integration@iot-dev.<yourdomain> --target-org iot-dev-admin
sf org assign permset --name Device_Integration \
  --on-behalf-of integration@iot-dev.<yourdomain> --target-org iot-dev-admin
```

Also activate the Agentforce agent (Setup → Agentforce Agents → **Patient Care
Agent** → activate). It ships inactive deliberately: an agent that can create
clinical Cases should be switched on by a person, not by a deploy.

That is the end of setup. Everything after this ships through GitHub.

---

## Doing it again for Prod

**The same sequence**, with these differences:

| Step | Change for Prod |
|---|---|
| Salesforce org | A second Developer org (or a real EE org). Same two service users, same two Connected Apps, fresh keypairs — never reuse Dev's keys. |
| AWS account | A second standalone account. Same `iot-operator` and OIDC role, but the trust policy `sub` ends `environment:Prod`: the deploy job declares `environment:`, so that is the claim GitHub sends. |
| GitHub | Same secret names in the **Prod** environment, different values. Add the required reviewer. |
| AWS Organizations | Only after the free-credit phase — see `MIGRATION-RUNBOOK.md` phase 1. |

Reusing a Dev certificate or role ARN in Prod silently collapses the two
environments into one and removes the entire point of having them.
