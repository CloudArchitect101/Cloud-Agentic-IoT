# Setup: Accounts, Identities, and Credentials

A comprehensive, step-by-step guide to building a secure, automated development environment from absolute scratch. 

## 🛠️ 1. Prerequisites & Tooling Installation

Install the required command-line utilities. The versions listed below represent verified baselines; any newer stable release is safe to use.

### Salesforce CLI (`sf`) — v2.136+
The modern `sf` utility is a Node.js-based application runner. Do not use the legacy, deprecated `sfdx` binary.
```bash
# Install Node.js runtime (v18+ required, v26 recommended)
brew install node                          

# Install the modern unified Salesforce CLI globally
npm install --global @salesforce/cli

# Verify successful installation
sf --version                               # Expected output: @salesforce/cli/2.x.x
```
*Tip: Run `sf update` regularly to keep your CLI framework current.*

### AWS CLI — v2
```bash
brew install awscli
aws --version                              # Expected output: aws-cli/2.x.x
```
*Important: If your terminal returns `aws-cli/1.x`, immediately run a full package uninstallation first. Having both versions installed simultaneously causes broken routing paths.*

### GitHub CLI (`gh`)
Enables direct management of repository infrastructure and securely injects environments secrets directly via the command line.
```bash
brew install gh
gh --version                               # Expected output: gh version 2.x.x
```

### Arduino CLI (`arduino-cli`) — Firmware Compilations Only
*Skip this section if you are not flashing physical edge devices.*
```bash
brew install arduino-cli
arduino-cli version                        # Expected output: 1.5.1 or newer

# Initialize structural configurations
arduino-cli config init
arduino-cli config set board_manager.additional_urls \
  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json

# Download framework indices and device cores
arduino-cli core update-index
arduino-cli core install esp32:esp32

# Install dependencies identical to your automated pipeline environment
arduino-cli lib install "PubSubClient" "ArduinoJson" "DHT sensor library" "ESP32Servo"
```

### Direct Tooling Verification
Verify your machine's entire system paths configuration array simultaneously before moving forward:
```bash
sf --version && aws --version && gh --version && arduino-cli version
```

---

## 🔑 2. Architectural Paradigm: The Five Core Identities

**Deployment actions and active system runtime require distinct separation.** A security credential assigned to deploy apex code or modify configuration files must never handle data transactions or process edge telemetry logs, and vice versa.

| # | Target Identity | Native Engine | Core Operational Scope | Security Boundaries |
|---|---|---|---|---|
| **1** | **Signup Administrator** | Salesforce | Configuration changes, license auditing, break-glass access only. | Requires MFA; should not be used for daily developer terminal access. |
| **2** | **`deploy@...`** | Salesforce | CI/CD automation only: deploys metadata configurations and runs unit tests. | **No data object permissions.** Cannot read database records. |
| **3** | **`integration@...`** | Salesforce | Active application runtime: orchestrates two-way AWS ↔ Salesforce data traffic. | **No structural metadata permissions.** Cannot modify code. |
| **4** | **`iot-operator`** | AWS | Dedicated developer identity for administrative console and local CLI actions. | Limited least-privilege role; cannot touch billing systems or identity creation. |
| **5** | **`github-actions-deploy`** | AWS | CI/CD infrastructure processing via OIDC federation. | **No permanent access keys exist.** Strictly bound to a single repository branch. |

---

## ☁️ 3. Salesforce Environment Provisioning

### 3.1 Provisioning the Org
1. Sign up for a free, permanent developer workspace environment at: [developer.salesforce.com/signup](https://developer.salesforce.com/signup).
2. Use a distinct email address routing alias that you fully control (e.g., `yourname+iot-dev@yourcompany.com`).
3. Navigate to **Setup** ➡️ **Company Information** to evaluate your baseline license allocations. Ensure you see 2 Salesforce licenses and 1 Integration license.

### 3.2 Secure Local Workspace Authentication
For local development, use an interactive web session authentication routine. This registers an explicitly named workspace moniker inside your VS Code interface.
```bash
sf org login web --set-default --alias iot-dev
```
*Result: Your terminal automatically bridges a secure login window via your browser. Once completed, your VS Code environment status bar will track paths directly to `iot-dev`.*

### 3.3 Provisioning Service Accounts
Navigate to **Setup** ➡️ **Users** ➡️ **Users** ➡️ **New User**. You must build two distinct structural identities.

#### Identity A: The Automation Engine (`deploy@...`)
* **User License:** `Salesforce`
* **Profile:** `Minimum Access – Salesforce`
* **Username:** `deploy@iot-dev.<yourdomain.com>`
* **Email:** Use your primary email account address.

#### Identity B: The Live Runtime Engine (`integration@...`)
* **User License:** `Integration`
* **Profile:** `Salesforce API Only System Integrations`
* **Username:** `integration@iot-dev.<yourdomain.com>`
* **Email:** Use your primary email account address.

---

## 🚀 4. Automated Architecture Bootstrap Order

Our entire repository deployment model is executed via remote continuous integration. This creates a bootstrap paradox: the functional permission sets that govern our operational runtime user data layer (`Device_Integration`) live directly inside our project source code repository. They cannot exist in Salesforce until GitHub deploys them.

To break this loop, we execute a brief manual bootstrap phase exactly once:

Use code with caution.[Phase 1: Bootstrap] ➡️ Manually give 'deploy@...' rights to touch structural code.⬇️[Phase 2: First Deploy] ➡️ GitHub processes everything, creating objects and runtime profiles.⬇️[Phase 3: Activation] ➡️ Securely attach the fresh runtime profile to 'integration@...'.
### Phase 1: Manual Deployment Authorization
1. Navigate to **Setup** ➡️ **Permission Sets** ➡️ **New**.
2. Label the set `Metadata_Deploy`.
3. Select **System Permissions** ➡️ **Edit**. Check exactly these two flags:
   * **API Enabled**: Required to initialize programmatic JWT token operations.
   * **Modify Metadata Through Metadata API Functions**: Grants code deployment power without offering any underlying object record data visibilities.
4. Click **Save**, then select **Manage Assignments** to assign this set directly to your `deploy@...` identity.

---

## 🔒 5. Modern Salesforce Inbound Auth: External Client Apps (ECA)

*Note: As of Spring '26, legacy Connected Apps are disabled by default for fresh setups. We utilize the next-generation External Client Apps framework.*

```
+--------------------+                                +-----------------------+
|   GitHub Actions   | --(JWT signed with PrivKey)--> | External Client App   |
| (Secret: Username) |                                | (Matches PubCert)     |
+--------------------+                                +-----------------------+
                                                                 |
                                                    (Assumes User Context)
                                                                 v
                                                      +-----------------------+
                                                      |    deploy@... User    |
                                                      +-----------------------+
```

### Step 1: Isolate Cryptographic Certificate Keypairs
Run the following local openssl utility calls to establish completely separate cryptographic identities for both your deployment processing and live data operations.
```bash
# Generate Keypair Array for CI/CD Pipelines
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server-deploy.key -out server-deploy.crt \
  -subj "/CN=CloudAgenticIoT-Deploy/O=Personal/C=CA"

# Generate Keypair Array for AWS Data Sync Processing
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server-integration.key -out server-integration.crt \
  -subj "/CN=CloudAgenticIoT-Integration/O=Personal/C=CA"
```

### Step 2: Establish the Pipeline Identity Gate
1. Navigate to **Setup** ➡️ **External Client Apps** ➡️ **External Client App Manager**.
2. Select **New External Client App**.
3. Set the application name to `Cloud Agentic IoT Deploy` and configure its Distribution State explicitly to **Local**.
4. Scroll to **API (Enable OAuth Settings)**, activate **Enable OAuth**, and fill out the fields:
   * **Callback URL**: Enter `http://localhost:1717/OauthRedirect` (Required structure).
   * **OAuth Scopes**: Choose and add:
     * `Manage user data via APIs (api)`
     * `Perform requests at any time (refresh_token, offline_access)`
   * **Flow Enablement**: Select **Enable JWT Bearer Flow**.
   * **Upload Files**: Choose and upload your local `server-deploy.crt` file.
5. Save the configuration and copy the resulting **Consumer Key** string.

### Step 3: Enforce Access Policies
1. Back inside the External Client App Manager listing, select the dropdown indicator next to your newly created application and click **Manage Policies**.
2. Modify **Permitted Users** from its default layout to: **Admin approved users are pre-authorized**.
3. Scroll down directly to the **Permission Sets** reference sections at the bottom of the page.
4. Attach the `Metadata_Deploy` permission set created before.

*Your automation identity layer is now linked. Repeat these exact parameters for your second AWS inbound application configuration (`Cloud Agentic IoT — Integration`) using your separate `server-integration.crt` credential.*

---

## 🔒 6. AWS Passwordless Inbound Auth: IAM OIDC Federation

We eliminate the use of permanent, long-lived AWS IAM Access Keys inside GitHub. Instead, we register GitHub as a federated identity provider via OpenID Connect (OIDC) to safely hand out short-lived, 1-hour session credentials.

### Step 0: Provision the Developer Identity (AWS Console UI)
Before setting up passwordless pipelines, you must create a standard programmatic identity for your local terminal and VS Code work. 

Navigate to the **AWS Console** ➡️ **IAM** ➡️ **Users** ➡️ **Create User**:

* **Console Access**: Enable
* **Attached Policies**: 
  * `AdministratorAccess`
* **Username**: `iot-operator`

#### Step 1: Generate Access Keys
1. Click on the newly created `iot-operator` user profile link.
2. Select the **Security credentials** tab ➡️ **Create access key**.
3. Choose **Command Line Interface (CLI)**, accept the terms, and click **Next**.
4. Save the **Access key ID** and **Secret access key** safely.

#### Step 2: Authorize in VS Code
Open your VS Code terminal and register these credentials under a dedicated development profile:
```bash
aws configure --profile iot-dev
```
*Provide your Access Key, Secret Key, default region (e.g., `us-east-1`), and `json` output format when prompted.*


### Step 1: Register GitHub with AWS IAM
1.  Navigate to the **AWS Console** ➡️ **IAM** ➡️ **Identity providers**.
2.  Click **Add provider**.
3.  Select the **OpenID Connect** provider type.
4.  For **Provider URL**, enter `https://token.actions.githubusercontent.com`.
5.  For **Audience**, enter `sts.amazonaws.com`.
6.  Click **Add provider**.

### Step 2: Formulate the Trust Rule Matrix
Create a local configuration mapping document named `trust-policy.json` to act as your platform security bouncer.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::YOUR_AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:YOUR_GH_USERNAME/Cloud-Agentic-IoT:ref:refs/heads/Dev" }
    }
  }]
}
```
*Note: Make sure to replace `YOUR_AWS_ACCOUNT_ID` with your actual 12-digit AWS account number, and update `YOUR_GH_USERNAME` to match your exact GitHub handle configuration.*

### Step 3: Materialize the Dedicated IAM Workspace Role
Bind your tracking file criteria directly into a new active execution role workspace, then anchor full system engineering rights to it:
```bash
# Instantiate the structural identity role
aws iam create-role --role-name github-actions-deploy \
  --assume-role-policy-document trust-policy.json \
  --profile iot-dev

# Inject infrastructure management entitlements
aws iam attach-role-policy --role-name github-actions-deploy \
  --policy-arn arn:aws:iam::aws:policy/AWSCloudFormationFullAccess \
  --profile iot-dev
```

---

## 🔒 7. Hydrating GitHub Actions Pipeline Context

Your GitHub Actions workflows need secrets (like API keys) and variables (like an AWS region) to run. Storing these securely in GitHub is critical.

While you can add these manually in the GitHub UI (**Settings** ➡️ **Secrets and variables** ➡️ **Actions**), this involves copy-pasting sensitive credentials. A better way is to use the GitHub CLI, which is more secure and less error-prone.

### Using the Interactive Setup Script

This repository includes a script to guide you through setting up all required secrets and variables for an environment. It will prompt you for each value and set them securely using the GitHub CLI.

Before running, make sure you have the required values handy:
- Your Salesforce **Deploy** External Client App's Consumer Key.
- The username for your Salesforce deploy user (e.g., `deploy@iot-dev.example.com`).
- The file path to your `server-deploy.key` private key.
- The ARN for your `github-actions-deploy` AWS IAM role.

To run the script for your `Dev` environment:
```bash
./scripts/setup-github-secrets.sh
```
The script will ask for the environment and then prompt for each value. For secrets, your typing will be hidden.

### Required Secrets and Variables

The script will set up the following. Note that secrets are encrypted and can't be read after being set, while variables are stored in plain text.

| Name | Type | Description |
|---|---|---|
| `SF_CONSUMER_KEY` | Secret | The Consumer Key from your **Deploy** Salesforce External Client App. |
| `SF_USERNAME` | Secret | The username of the Salesforce user for deployments (e.g., `deploy@iot-dev...`). |
| `SF_JWT_KEY` | Secret | The **base64-encoded** private key (`server-deploy.key`) for JWT authentication. |
| `AWS_ROLE_ARN` | Secret | The ARN of the IAM role that GitHub Actions assumes to deploy to AWS. |
| `AWS_REGION` | Variable | The AWS region for all deployments (e.g., `us-east-1`). |
| `SF_LOGIN_URL` | Variable | `https://login.salesforce.com` for a Developer Edition or production org, `https://test.salesforce.com` for a sandbox. |

---

## 🔄 Production Environment Adjustments

When constructing your mirroring production staging pipelines later, repeat the exact sequencing tracks detailed across this guide with the following explicit updates:
* **Branch Pinnings**: Modify your AWS `trust-policy.json` structural matching parameter logic to target branch configurations reading `:ref:refs/heads/Prod` instead of `Dev`.
* **Licensing Optimization**: In real production Salesforce workspaces, apply real **Integration User Licenses** for both your deployment identity profiles and live running operational nodes.
* **Target Routing Paths**: Swap the internal Salesforce metadata command structures within your automated continuous deployment configuration actions file from using `https://login.salesforce.com` paths directly over to sandbox targeting environments via `https://test.salesforce.com` where necessary.
EOF


















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
| Profile | Salesforce API Only System Integrations | Minimum Access – Salesforce |
| Username | `integration@iot-dev.<yourdomain>` | `deploy@iot-dev.<yourdomain>` |
| Gets permissions from | `Device_Integration` permission set (from the repo) | `Metadata_Deploy` permission set (created by hand — see §2.3) |

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
| **3. Activation** | You, once | Assign `Device_Integration` to `integration@…`; activate the agent |

Phases 1 and 3 are one-time. From then on, every change ships through GitHub.

**Phase 1 — grant `deploy@…` exactly two permissions.** 
Setup → Permission Setsm→ New (call it `Metadata_Deploy`), then System Permissions:

| Permission | Why |
|---|---|
| **API Enabled** | JWT login and the Metadata API both require it |
| **Modify Metadata Through Metadata API Functions** | Deploy metadata *without* granting data access — this is the least-privilege option, and the reason the deploy user cannot read a single patient record |

Assign it to `deploy@…` user.

> **If a deploy later fails with an insufficient-privileges error**, the cause
> is almost always that a specific metadata type still demands **Modify All
> Data**, which `Modify Metadata` deliberately does not cover. Salesforce's own
> documentation lists the exceptions and they shift between releases. Prefer
> adding `Modify All Data` only if you hit that wall — it is far broader, and
> starting narrow means you find out precisely what the pipeline needs.




### 2.4 Two External Apps, not one

Step 1: Generate your certificates
Run your OpenSSL commands exactly as planned to generate your separate keys and certificates.

For Deploy user:
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server-deploy.key -out server-deploy.crt \
  -subj "/CN=CloudAgenticIoT-Deploy/O=Personal/C=CA"

For Integration user:
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout server-integration.key -out server-integration.crt \
  -subj "/CN=CloudAgenticIoT-Integration/O=Personal/C=CA"

Step 2: Configure the External Client Apps
Go to Setup in Salesforce.
In the Quick Find box, type External Client Apps.
Click External Client App Manager (or click New External Client App if available in your view).
Fill out the basic details for Cloud Agentic IoT Deploy
Under the OAuth Settings, check the box to Enable OAuth.
Select scopes: 
- Manage User data via APIs (api) 
- Perfrom requests at any time (refresh_token, offline_access)
Enable Enable JWT Bearer Flow and upload server-integration.crt
Save the app.

Repeat for the Integration user.

Step 3: Authorize via Policies
In the External Client App Manager list, locate your newly created app.
Click the dropdown arrow next to it and select Manage Policies (or edit OAuth policies).
Set "Admin approved users are pre-authorized"
Associate your dedicated Salesforce Integration User via the designated Permission Set [Meatadate_Deploy]

Repeat for the Integration user.

Note: The app defines what mechanisms are technically open, but a user identity dictates who owns the data and which records they have the permission to modify.


---

## 3. AWS Dev account

### 3.1 Root: three actions, then never again

Sign in as root, then:
IAM → Users → Create `iot-operator`, console access on, MFA on.
Create and assign policy from `scripts/aws-project-policy.json`

Note: you might be not qualify for the FREE AWS Account.

### 3.2 GitHub Actions deploy role — OIDC, no keys

Run as `iot-operator`, once per account:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

cat > trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:YOUR_GH_USERNAME/Cloud-Agentic-IoT:ref:refs/heads/Dev" }
    }
  }]
}
EOF

aws iam create-role --role-name github-actions-deploy \
  --assume-role-policy-document file://trust-policy.json
aws iam attach-role-policy --role-name github-actions-deploy \
  --policy-arn arn:aws:iam::aws:policy/AWSCloudFormationFullAccess
```

The `sub` condition pins the role to **this repo on this branch**. For Prod,
create the same role in the Prod account with `refs/heads/Prod`.

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

Confirm the toolchain still builds before you rely on it:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 \
  --libraries firmware/libraries firmware/patient-monitor
```

## 5. GitHub

### 5.1 Repository

```bash
gh auth login
gh repo create Cloud-Agentic-IoT --public --source=. --remote=origin
git push -u origin Dev
```

Then create `Prod` from `Dev` in the GitHub UI when you are ready to promote.

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
| `FIRMWARE_BUCKET` | Variable | S3 bucket for firmware binaries | OTA release |
| `OTA_PRESIGN_ROLE_ARN` | Secret | Role AWS IoT assumes to sign firmware URLs | OTA release |
| `SF_CONSUMER_KEY` | Secret | **Deploy** Connected App consumer key | Salesforce deploy |
| `SF_JWT_KEY` | Secret | `base64 -i server-deploy.key` | Salesforce deploy |
| `SF_USERNAME` | Secret | `deploy@iot-dev.<yourdomain>` | Salesforce deploy |
| `SF_LOGIN_URL` | Variable | `https://login.salesforce.com` | Salesforce deploy |

Note the pipeline uses the **deploy** app and user, never the integration one.

Enter values yourself — via the GitHub UI, or from your own terminal so they
never appear in any transcript:

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

```bash
git push origin Dev
```

Watch the Actions run. A green run means every secret in §5.3 is correct, and
it is what creates the `Device_Integration` permission set in the org.

### 6.4 Then finish the bootstrap

```bash
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
| AWS account | A second standalone account. Same `iot-operator` and OIDC role, but the trust policy `sub` ends `refs/heads/Prod`. |
| GitHub | Same secret names in the **Prod** environment, different values. Add the required reviewer. |
| AWS Organizations | Only after the free-credit phase — see `MIGRATION-RUNBOOK.md` phase 1. |

Reusing a Dev certificate or role ARN in Prod silently collapses the two
environments into one and removes the entire point of having them.
