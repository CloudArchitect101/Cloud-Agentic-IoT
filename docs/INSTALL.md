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

1. Create an AWS **project** on the paid plan and set a monthly spend limit (the lowest is $20). Note its Region.
2. Sign up for a free **Developer Edition** org.
3. In the org, turn on **Person Accounts** and make Person Account the default Account record type ([SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin), step 5), then Setup → **Einstein Setup** → **Turn on Einstein**, then Setup → **Agentforce Agents** → turn on **Agentforce**.

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

Press Enter at each question of `seed-ssm.sh` on the first run; step 6 fills them in.

```bash
scripts/seed-ssm.sh Dev
scripts/check.sh && scripts/deploy-aws.sh Dev && scripts/deploy-salesforce.sh Dev
sf org assign permset --name Device_Platform_Admin
sf org assign permset --name Platform_Usage_Viewer
```

What each script does: [TRY-IT.md §3 and §4](TRY-IT.md#4-deploy-and-test).

## 5. Let Salesforce call AWS

One named credential, `AWS_IoT_Relay`, signs every call from Salesforce to AWS. Follow the [Install guide, Stage 2, step 1](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach):

1. **a.** Run the commands that create the caller IAM user and print its access key.
2. **b.** Setup → Named Credentials → External Credentials: AWS Signature Version 4, the key from a, `403` as a token-refresh status code, and the role ARN as the principal.
3. **c.** Named Credential `AWS_IoT_Relay`, URL = the `QueueDepthEndpoint` stack output.
4. **d.** Permission set `AWS_IoT_Relay_Callers` with access to that principal and Read on User External Credentials. Assign it to yourself, the integration user and the Automated Process user.

## 6. Let AWS call Salesforce

1. Create the integration user and its External App with a certificate: [SETUP.md §2.2](SETUP.md#22-create-the-two-service-users) and [§2.4](SETUP.md#24-two-external-apps-not-one).
2. Give it the **Salesforce API Integration** permission set license and the `Device_Integration` permission set.
3. Store its values and deploy AWS again:

```bash
scripts/seed-ssm.sh Dev
scripts/deploy-aws.sh Dev
```

Details: [TRY-IT.md §5](TRY-IT.md#5-connect-the-org-and-the-project).

## 7. Turn on the agent

```bash
scripts/publish-agent.sh Dev
sf org assign permset --name Patient_Care_Agent
```

Why it ships inactive: [Install guide, step 6](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach).

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
