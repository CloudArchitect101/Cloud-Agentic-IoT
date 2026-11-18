# Quick install

The shortest path from a fresh clone to a working system: your own AWS project with a spend limit and a free Salesforce Developer Edition org, deployed from your laptop. Commands only, in order. Every step links to the [Install guide](INSTALL-GUIDE.md), which explains why it is done that way and what to check when it fails.

> [!NOTE]
> About an hour for the cloud side, plus about 20 minutes for each board. The board is optional: everything except the motor runs without one. Running Dev and Prod accounts through GitHub Actions instead? Use [SETUP.md](SETUP.md) and the [Install guide](INSTALL-GUIDE.md).

> [!WARNING]
> Keys, passwords and tokens are typed only into your own terminal or into Salesforce Setup. Never paste them into a file in the repo, a chat or an issue.

## 1. Install the tools

| Tool | Version | Install (macOS) |
|---|---|---|
| Node.js | 22+ | `brew install node` |
| Salesforce CLI `sf` | 2.136+ | `npm install --global @salesforce/cli` |
| AWS CLI | 2.32.0+ | `brew install awscli` |
| arduino-cli (boards only) | latest | `brew install arduino-cli` |

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install "PubSubClient" "ArduinoJson" "DHT sensor library" "ESP32Servo"
```

Linux and Windows: [SETUP.md §0](SETUP.md#0-prerequisites--install-the-tooling).

## 2. Create the AWS project and the Salesforce org

1. Create an AWS **project** in [AWS Settings](https://settings.aws.com) on the paid plan, and set a monthly spend limit (the lowest is $20). Note its Region.
2. Sign up for a free **Developer Edition** org at [developer.salesforce.com/signup](https://developer.salesforce.com/signup).
3. In the org, turn on **Person Accounts** and make Person Account the default Account record type ([SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin), step 5), then Setup → **Einstein Setup** → **Turn on Einstein**, then Setup → **Agentforce Agents** → turn on **Agentforce**.

> [!WARNING]
> Use a plain AWS project and **do not activate its advanced features**. Activating them removes the spend limit for good and can't be undone. You don't need them here: they only matter for GitHub OIDC, which the pipelines path uses with regular AWS accounts instead.

Why a project, and what it costs: [TRY-IT.md §1](TRY-IT.md#1-create-the-project-and-the-org).

## 3. Clone and sign in

Use one name for both CLIs, for example `test-<your GitHub name>`.

```bash
git clone https://github.com/CloudArchitect101/Cloud-Agentic-IoT.git
cd Cloud-Agentic-IoT
NAME=test-yourname
aws login --profile "$NAME"
sf org login web --alias "$NAME"
export AWS_PROFILE="$NAME" SF_TARGET_ORG="$NAME"
```

## 4. Seed settings and deploy everything

Press Enter at each question of `seed-ssm.sh` on the first run; step 5 fills them in.

```bash
scripts/seed-ssm.sh Dev
scripts/check.sh && scripts/deploy-aws.sh Dev && scripts/deploy-salesforce.sh Dev
sf org assign permset --name Device_Platform_Admin
sf org assign permset --name Platform_Usage_Viewer
```

What each script does: [TRY-IT.md §3 and §4](TRY-IT.md#4-deploy-and-test).

## 5. Let AWS call Salesforce

AWS writes readings, alerts and board answers into Salesforce as a dedicated integration user. It signs in with a certificate (JWT), never a password.

**a. Create the certificate** in your own terminal, inside the repo (`.gitignore` keeps `*.key` and `*.crt` out of Git):

```bash
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout scripts/server-integration.key -out scripts/server-integration.crt \
  -subj "/CN=CloudAgenticIoT-Integration/O=Personal/C=CA"
```

**b. Create the user.** Setup → **Users** → **New User**:

| Field | Value |
|---|---|
| Last name | `Integration` |
| Email | Your own plus address, for example `you+integration@…` (never the admin's address) |
| Username | `integration@iot-dev.<yourdomain>` |
| User License | **Salesforce Integration** |
| Profile | **Salesforce API Only System Integrations** |

Then, on the user's page: **Permission Set License Assignments** → Edit Assignments → **Salesforce API Integration**, and **Permission Set Assignments** → `Device_Integration` (step 4 deployed it).

**c. Create the External Client App.** Setup → **External Client App Manager** → **New External Client App**:

| Setting | Value |
|---|---|
| Name | `Cloud Agentic IoT Integration` |
| OAuth | **Enable OAuth**, scopes `api` and `refresh_token, offline_access` |
| JWT | **Enable JWT Bearer Flow**, upload `scripts/server-integration.crt` |
| Policies (after saving) | **Admin approved users are pre-authorized**, permission set `Device_Integration` |

Copy the app's **Consumer Key** for the next command.

**d. Store the values and deploy AWS again.** `seed-ssm.sh` asks for the username and the consumer key, and offers `scripts/server-integration.key`. Type the values in your terminal, never in a file or a chat:

```bash
scripts/seed-ssm.sh Dev
scripts/deploy-aws.sh Dev
aws lambda get-function-configuration --function-name cloud-agentic-iot-salesforce-sync \
  --query Environment.Variables.SALESFORCE_USERNAME --output text   # prints the integration username
```

More detail: [TRY-IT.md §5](TRY-IT.md#5-connect-the-org-and-the-project), [SETUP.md §2.2](SETUP.md#22-create-the-two-service-users) and [§2.4](SETUP.md#24-two-external-apps-not-one).

## 6. Let Salesforce call AWS

One named credential, `AWS_IoT_Relay`, signs every call from Salesforce to AWS (provisioning, commands, the live card, the Home page's spend) with AWS Signature Version 4.

**a. Create the caller IAM user and its key** in your own terminal, signed in as `$NAME`:

```bash
STACK=cloud-agentic-iot-queue-relay-Dev
CALLER=cloud-agentic-iot-salesforce-caller
ROLE_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='SalesforceCallerRoleArn'].OutputValue" --output text)
echo "$ROLE_ARN"   # must print an ARN; an empty line means a wrong stack name or Region
aws iam create-user --user-name "$CALLER" > /dev/null
aws iam put-user-policy --user-name "$CALLER" --policy-name assume-salesforce-caller-role \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Resource\":\"$ROLE_ARN\"}]}"
aws iam create-access-key --user-name "$CALLER"
aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='QueueDepthEndpoint'].OutputValue" --output text   # the URL for c
echo "IAM Role ARN for b: $ROLE_ARN"
```

`create-access-key` prints the key once. Type it into Salesforce in b and nowhere else.

**b. External credential.** Setup → **Named Credentials** → **External Credentials** → **New**:

| Setting | Value |
|---|---|
| Authentication Protocol | **AWS Signature Version 4** |
| Service | `execute-api` |
| Region | Your project's Region |
| Obtain Temporary IAM Credentials via STS | On, **IAM User Identified by Access Key** |
| STS Access Key / STS Access Secret | The key from a |
| STS Duration | Empty, or 3600 or less |
| Additional Status Codes for Token Refresh | `403` |
| Principal → IAM Role ARN | The role ARN that a printed last (it has `:role/`, not `:user/`) |

**c. Named credential.** **Named Credentials** → **New**: Name `AWS_IoT_Relay`, URL = the `QueueDepthEndpoint` that a printed, the external credential from b, and **Enabled for Callouts** and **Generate Authorization Header** both on.

**d. Who may use it.** Create a permission set `AWS_IoT_Relay_Callers` with **External Credential Principal Access** to the principal from b, and **Read** on **User External Credentials** (Object Settings). Assign it to yourself, to the integration user from step 5, and to the hidden Automated Process user:

```bash
sf org assign permset --name AWS_IoT_Relay_Callers
sf org assign permset --name AWS_IoT_Relay_Callers --on-behalf-of integration@iot-dev.<yourdomain>
echo "insert new PermissionSetAssignment(
    AssigneeId = [SELECT Id FROM User WHERE UserType = 'AutomatedProcess' AND Username LIKE 'autoproc@%' LIMIT 1].Id,
    PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'].Id);" | sf apex run
```

If a callout fails with `HTTP 0` or `403`, the [Install guide, Stage 2](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach) lists each cause and its fix under "If a callout fails".

## 7. Turn on the agent

```bash
scripts/publish-agent.sh Dev
sf org assign permset --name Patient_Care_Agent
```

Why it ships inactive: [Install guide, Stage 2 step 6](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach).

## 8. Add a board (optional)

1. Get the parts (ESP32, DHT11, SG90 servo, a data USB cable): [Install guide, Stage 3](INSTALL-GUIDE.md#what-you-need). Flashing: [firmware/README.md](../firmware/README.md#build-and-flash).
2. In the Cloud Agentic IoT app, create a **Wi-Fi Network**, then an **Asset** with Serial Number = the board's name. It turns **Provisioned** with a bundle link.
3. Download the bundle, plug the board in by USB, and run:

```bash
./scripts/provision-device.sh bundle.json
./scripts/update-wifi.sh "<hotspot-SSID>"   # a second network, asks for the passphrase
```

4. Delete the bundle: it holds the board's private key.

Every later firmware update goes over the air: `scripts/ota.sh try Dev patient-monitor`. The manual path, without Salesforce: [Install guide, Stage 3](INSTALL-GUIDE.md#stage-3--hardware).

## 9. Check that it works

| Check | Expect |
|---|---|
| The board's Asset | Connection `Online`, a reading every 2 s on the Live Status card |
| **Send Command** → `RESTART` on the Asset | The Device Command goes `Sent`, then `Acked` |
| Warm the sensor to 30 C (under an arm) | The board's motor sweeps, and a Case opens in Care_Team_Queue |
| Ask the agent "what is Test8 reporting?" | The latest readings, and an SOP citation when you ask what to do |
| The app's Home tab | This month's AWS spend against the limit, and the org's limits |

The full checklist: [Install guide, Stage 4](INSTALL-GUIDE.md#stage-4--verify-end-to-end). Something failed? [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Optional pieces

| Piece | Guide |
|---|---|
| Slack `/patient-status` and the agent in Slack | [Install guide, Stage 2 steps 2 and 3](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach), [SETUP.md](SETUP.md#talk-to-the-agent-from-slack-optional) |
| Data Cloud room readings | [SETUP.md §7](SETUP.md#7-data-cloud-room-readings-for-the-ward) |
| Patient portal with Enhanced Chat | [SETUP.md §9](SETUP.md#9-patient-portal) |
| MCP server for outside agents | [GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#connect-an-mcp-client) |
| Dev and Prod pipelines | [DEVELOPMENT.md](DEVELOPMENT.md), [TRY-IT.md](TRY-IT.md#moving-to-the-pipelines) |
