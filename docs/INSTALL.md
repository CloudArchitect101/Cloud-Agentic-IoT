# Quick install

Every feature, from a fresh clone to a working system: your own AWS project with a spend limit and a free Salesforce Developer Edition org, deployed from your laptop. Execution steps only, in order. Every Setup click that has to happen before the deploy is gathered in steps 3 and 5, so **step 6 deploys everything in one run**. The [Install guide](INSTALL-GUIDE.md) explains why each step is done that way and what to check when one fails.

> [!NOTE]
> About two hours for everything, plus about 20 minutes for each board. Do step 2 first, on day one: if Bedrock needs a Support case, it can take up to 72 hours. Steps 1 to 7 and 13 make the core system. Steps 8 to 12 and 14 each add one feature, and you can skip any of them.

> [!IMPORTANT]
> **Fill in first.** A command that needs your own values has a **Fill in first** list right above it. Replace each one before you run the command, including any `<` `>` around it. For example, `EMAIL='<your email>'` becomes `EMAIL='you@example.com'`. Anything not on the list runs as it is.

> [!WARNING]
> Keys, passwords and tokens are typed only into your own terminal or into Salesforce Setup. Never paste them into a file in the repo, a chat or an issue.

## 1. Install the tools

| Tool | Version | Install (macOS) | For |
|---|---|---|---|
| Node.js | 22+ | `brew install node` | everything |
| Salesforce CLI `sf` | 2.136+ | `npm install --global @salesforce/cli` | everything |
| AWS CLI | 2.32.0+ | `brew install awscli` | everything |
| jq | any | `brew install jq` | everything |
| arduino-cli | latest | `brew install arduino-cli` | boards (step 12) |
| uv | latest | `brew install uv` | MCP server (step 11) |
| GitHub CLI `gh` | latest | `brew install gh` | pipelines (step 14) |

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install "PubSubClient" "ArduinoJson" "DHT sensor library" "ESP32Servo"
```

Linux and Windows: [SETUP.md §0](SETUP.md#0-prerequisites--install-the-tooling).

## 2. Create the AWS project and the Salesforce org

1. Create an AWS **project** in [AWS Settings](https://settings.aws.com) on the paid plan, and set a monthly spend limit (the lowest is $20). Note its Region.
2. **Check that Bedrock works in the project, right away.** The agent's Find Procedure answers from an SOP index that Amazon Bedrock builds (Titan Text Embeddings V2), and a new account is often held from Bedrock until AWS lifts it. Signed in to the project, in its Region: open the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/) → **Playgrounds** → **Chat / Text**, pick any model, and send "hello".
   - **It answers:** Bedrock works. Carry on.
   - **It says `Operation not allowed`, or that the account isn't authorized:** open a free case now in the [Support Center](https://support.console.aws.amazon.com/support/home#/case/create) → **Account and billing** → **Account** (not Technical). Ask AWS to enable Amazon Bedrock for Titan Text Embeddings V2 in your Region, and say it's for a new account. Finish any account verification or payment-method notice in Billing first. It can take **up to 72 hours**. Carry on with the install meanwhile, and run step 6 with `SKIP_SOP_INDEX=yes` until the case is resolved.
3. Sign up for a free **Developer Edition** org at [developer.salesforce.com/signup](https://developer.salesforce.com/signup).

> [!WARNING]
> Use a plain AWS project and **do not activate its advanced features**. Activating them removes the spend limit for good and can't be undone. You don't need them here: they only matter for GitHub OIDC, which the pipelines (step 14) use with regular AWS accounts instead.

Why a project, and what it costs: [TRY-IT.md](TRY-IT.md#why-a-project-and-what-it-costs-you).

After step 4, the same Bedrock check from the terminal. `AUTHORIZED` means it works:

```bash
aws bedrock get-foundation-model-availability --model-id amazon.titan-embed-text-v2:0 \
  --query authorizationStatus --output text
```

## 3. Turn on the org's features

One pass through Setup, all before the deploy. Each switch accepts terms or can't be turned off, so a deploy can't make it for you, and without it the deploy fails.

| Setup page | Do |
|---|---|
| **Einstein Setup** | **Turn on Einstein** |
| **Agentforce Agents** | Turn on **Agentforce** (if it's missing, wait a few minutes and reload) |
| **Account Settings** | **Enable Person Accounts**. Then Profiles → your profile → Object Settings → Accounts → Record Types: make **Person Account** the default, keep Business available |
| **Digital Experiences** → **Settings** | **Enable Digital Experiences**, pick a domain, then turn on **Allow using standard external profiles for self-registration, user creation, and login** |
| **Omni-Channel Settings** | **Enable Omni-Channel** |
| **Messaging Settings** | Turn on **Messaging** |

The patient portal needs one Customer Community licence per test patient. Check that the org has them:

```bash
sf data query --target-org "$NAME" \
  --query "SELECT Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Name LIKE '%Community%'"
```

(Run it after step 4, when `NAME` is set.)

## 4. Clone and sign in

Use one name for both CLIs, for example `test-<your GitHub name>`.

**Fill in first:**
- `NAME=test-yourname`: your own short name, used for both the AWS profile and the org alias. Example: `NAME=test-jsmith`.

```bash
git clone https://github.com/CloudArchitect101/Cloud-Agentic-IoT.git
cd Cloud-Agentic-IoT
NAME=test-yourname
aws login --profile "$NAME"
sf org login web --alias "$NAME"
export AWS_PROFILE="$NAME" SF_TARGET_ORG="$NAME"
```

## 5. Make what the deploy reads

Everything the deploy asks for, made first, so step 6 needs no second run.

**a. The integration certificate.** AWS signs in to Salesforce with it (JWT), never with a password. `.gitignore` keeps `*.key` and `*.crt` out of Git:

```bash
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout scripts/server-integration.key -out scripts/server-integration.crt \
  -subj "/CN=CloudAgenticIoT-Integration/O=Personal/C=CA"
```

**b. The integration user.** Setup → **Users** → **New User**:

| Field | Value |
|---|---|
| Last name | `Integration` |
| Email | Your own plus address, for example `you+integration@…` (never the admin's address) |
| Username | `integration@iot-dev.<yourdomain>` |
| User License | **Salesforce Integration** |
| Profile | **Salesforce API Only System Integrations** |

Then on the user's page: **Permission Set License Assignments** → Edit Assignments → **Salesforce API Integration**. Step 6 gives it the `Device_Integration` permission set.

**c. The External Client App.** Setup → **External Client App Manager** → **New External Client App**:

| Setting | Value |
|---|---|
| Name | `Cloud Agentic IoT Integration` |
| OAuth | **Enable OAuth**, scopes `api` and `refresh_token, offline_access` |
| JWT | **Enable JWT Bearer Flow**, upload `scripts/server-integration.crt` |

Save, and copy its **Consumer Key** for step 6. The key exists as soon as the app is saved; its policy gets the permission set after the deploy.

**d. The Slack app** (skip without Slack).

No Slack workspace yet? Make a free one first (slash commands and Agentforce in Slack both work on the free plan):

1. Go to [slack.com/get-started#/createnew](https://slack.com/get-started#/createnew), enter your email, and type the code Slack emails you.
2. **Create a workspace**: name it, for example `Smart Ward Demo`, and enter your name.
3. Skip inviting people (**Skip this step**) and skip the paid trial. Slack opens the workspace.

You're its **owner**, which steps 8a and 8b need: owners may install apps and connect a Salesforce org. In a company workspace you'd need an admin to do those parts, so a workspace of your own keeps the demo separate.

Then the app: at [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**, name `Ward Bot`, pick your workspace → **Create App**. Then **Basic Information** → **App Credentials** → **Signing Secret** → **Show**. Step 6 asks for it.

**e. The portal's chat certificate** (skip without the portal). Setup → **Certificate and Key Management** → **Create Self-Signed Certificate**: Label and Unique Name `Patient_Portal_Chat`, key size 2048, **Exportable Private Key off**. Download the `.crt`, then:

**Fill in first:**
- `~/Downloads/Patient_Portal_Chat.crt`: where your browser saved the certificate, if not `~/Downloads`. Leave `patient-portal-chat-1` as it is.

```bash
node scripts/portal-chat-jwk.mjs ~/Downloads/Patient_Portal_Chat.crt patient-portal-chat-1 \
  > ~/Downloads/patient-portal-chat-key.json   # public; it goes into Setup in step 10, not the repo
```

## 6. Deploy everything in one run

```bash
DATA_CLOUD_READER_USER=cloud-agentic-iot-data-cloud-reader scripts/install.sh Dev
```

[`scripts/install.sh`](../scripts/install.sh) runs, in order:

1. Creates Data Cloud's IAM reader user, if you named it (leave `DATA_CLOUD_READER_USER=` out without Data Cloud).
2. `seed-ssm.sh`. It asks for the integration **username** (5b), the **consumer key** (5c), offers `scripts/server-integration.key` (5a), and asks for the **Slack signing secret** (5d). Type the values; nothing is shown. Press Enter to skip one.
3. `check.sh`, the local tests.
4. `deploy-aws.sh`: every stack, the guardrails, the MCP server, the Slack stack once its secret is in, and the SOP index for the agent.
5. `deploy-salesforce.sh`: the app, the React portal, the agents' actions, the permission sets.
6. Gives you `Device_Platform_Admin`, `Platform_Usage_Viewer` and `Patient_Care_Agent`, and gives the integration user `Device_Integration`.
7. `publish-agent.sh`: publishes and activates the Patient Care Agent.
8. Prints every value the next steps ask for: the role ARN and URL for step 7, the Slack Request URL, the Data Cloud bucket and the MCP endpoint.

Run it again whenever you like: each part is safe to repeat. `SKIP_CHECK=yes` skips the tests, `SKIP_AGENT=yes` skips the agent publish. If Bedrock is still held (step 2), run `SKIP_SOP_INDEX=yes scripts/install.sh Dev`. Everything else deploys and works. Once the case is resolved, build the index once with `scripts/index-sops.sh Dev --force`.

Then three clicks and one command:

1. **The app's policy.** External Client App Manager → `Cloud Agentic IoT Integration` → **Manage Policies**: **Admin approved users are pre-authorized**, permission set `Device_Integration`.
2. **The queue.** Setup → **Queues** → `Care_Team_Queue` → add the members who should get the temperature alert Cases.
3. **The spend card's budget.** The Home page shows this month's AWS spend against a budget equal to the spend limit:

**Fill in first:**
- `LIMIT=20`: your project's monthly spend limit in US dollars, the same number you set in step 2. Example: `LIMIT=50`. Keep `20` if you chose the lowest.
- `EMAIL='<your email>'`: the address AWS sends the budget alerts to. Example: `EMAIL='you@example.com'`.
- `ACCOUNT` fills itself in. Run the whole block as it is otherwise.

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
LIMIT=20                    # your project's spend limit
EMAIL='<your email>'
aws budgets create-budget --region us-east-1 --account-id "$ACCOUNT" \
  --budget "{\"BudgetName\":\"cloud-agentic-iot-monthly\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"$LIMIT\",\"Unit\":\"USD\"},\"Metrics\":[\"UnblendedCost\"],\"FilterExpression\":{\"Not\":{\"Dimensions\":{\"Key\":\"RECORD_TYPE\",\"Values\":[\"Credit\",\"Refund\",\"Tax\"]}}}}" \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}]"
aws lambda get-function-configuration --function-name cloud-agentic-iot-salesforce-sync \
  --query Environment.Variables.SALESFORCE_USERNAME --output text   # prints the integration username
```

## 7. Let Salesforce call AWS

One named credential, `AWS_IoT_Relay`, signs every call from Salesforce to AWS (provisioning, commands, the live card, the Home page's spend, the agent's Find Procedure) with AWS Signature Version 4.

**a. The caller IAM user and its key:**

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
| Principal → IAM Role ARN | The role ARN that step 6 printed (it has `:role/`, not `:user/`) |

**c. Named credential.** **Named Credentials** → **New**: Name `AWS_IoT_Relay`, URL = the named credential URL that step 6 printed, the external credential from b, and **Enabled for Callouts** and **Generate Authorization Header** both on.

**d. Who may use it.** Create a permission set `AWS_IoT_Relay_Callers` with **External Credential Principal Access** to the principal from b, and **Read** on **User External Credentials** (Object Settings). Then assign it to you, the integration user and the hidden Automated Process user:

**Fill in first:**
- `integration@iot-dev.<yourdomain>`: the integration user's username from 5b. Example: `integration@iot-dev.jsmith.com`.

```bash
sf org assign permset --name AWS_IoT_Relay_Callers
sf org assign permset --name AWS_IoT_Relay_Callers --on-behalf-of integration@iot-dev.<yourdomain>
echo "insert new PermissionSetAssignment(
    AssigneeId = [SELECT Id FROM User WHERE UserType = 'AutomatedProcess' AND Username LIKE 'autoproc@%' LIMIT 1].Id,
    PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'].Id);" | sf apex run
```

Every care team member who uses the agent also needs it: `sf org assign permset --name AWS_IoT_Relay_Callers --on-behalf-of <username>`.

If a callout fails with `HTTP 0` or `403`, the [Install guide, Stage 2](INSTALL-GUIDE.md#stage-2--connect-the-seams-ci-cannot-reach) lists each cause and its fix under "If a callout fails".

## 8. Slack

**a. The `/patient-status` command** (the Ward Bot app from 5d):

1. In the app: **Slash Commands** → **Create New Command**: Command `/patient-status`, Request URL = the Slack Request URL step 6 printed, usage hint `Test8`.
2. **Install App** → **Install to Workspace** → **Allow**.
3. In any channel: `/patient-status Test8`.

**b. The Patient Care Agent in Slack** (Agentforce in Slack, no code of ours):

1. In Slack, as the workspace owner: **Tools & settings** → **Manage Salesforce Organizations** → **Connect Salesforce Org**: your My Domain URL, account mapping field **Email**, **Automatic account mapping** off → **Request Connection**.
2. In Salesforce: Setup → Quick Find **Slack** → **Manage Slack Connection** → approve. Back in Slack's **Manage Salesforce Organizations**, open the pending connection → **Activate**.
3. Same page → the org → **Users** → **Add Individually**: each Slack member who may use the agent. Each needs one Salesforce user with the same email, and two permission sets:

**Fill in first** (run the pair once per Slack member):
- `<username>`: that member's Salesforce username. Example: `nurse.lee@iot-dev.jsmith.com`.

```bash
sf org assign permset --name SlackSalesCloud --on-behalf-of <username>
sf org assign permset --name Patient_Care_Agent --on-behalf-of <username>
```

4. Slack **Admin** → **Manage Agentforce** → **Review agent** → **Install Agent**. Quit and reopen Slack.
5. DM the agent: "What is Test8 reading?"

## 9. Data Cloud

Needs Data Cloud (Data 360) in the org, and you as an admin with **Data Cloud Architect** or System Administrator. Step 6 already turned the CSV copy on and created the reader user.

1. **Its key**, typed into the connection in step 2 and nowhere else:

```bash
aws iam create-access-key --user-name cloud-agentic-iot-data-cloud-reader
```

2. **Connection.** Data Cloud Setup → **Other Connectors** → **New** → **Amazon S3**: Name `Room Readings S3`, **Bucket Name** = the Data Cloud bucket step 6 printed, **Parent Directory** `datacloud/room-readings/`, **Access Key/Secret Based** with the key from 1. **Test Connection** → **Save**.
3. **Data stream.** Data Streams → **New** → **Amazon S3** → `Room Readings S3`:

| Setting | Value |
|---|---|
| File Type / File Name | CSV, `room-readings-*.csv` (Import from Directory empty) |
| Source | `AWS IoT` |
| Data lake object | New, `Room_Readings`. `reading_ts` and `received_ts` DateTime, `temperature_c` and `humidity_pct` Number, the rest Text |
| Category / primary key / event time | Engagement, `reading_id`, `reading_ts` |
| Refresh | **Upsert**, the most frequent schedule |

**Deploy**, then **Refresh Now**.

4. **Mapping.** On the stream, **Start** the mapping → **New Custom Object** `Room_Reading`, every field under the same name, `reading_id` as primary key → Save.
5. **Calculated insights**, once `Room_Reading__dlm` has rows (a board must have sent readings):

```bash
scripts/data-cloud-insights.sh --dry-run
scripts/data-cloud-insights.sh
```

Then set each insight's schedule to the most frequent one.

## 10. Patient portal with Enhanced Chat

The deploy brought the site, the React app, the Apex, the agent's actions and the permission sets. Then:

1. **Chat deployment.** Setup → **Embedded Service Deployments** → **New Deployment** → **Enhanced Chat** → Web. Name `Patient_Portal_Chat`, domain = the site's `*.my.site.com` domain, let it create the Messaging channel. Open it → **Switch to V2** → **Publish**.
2. **User verification.** Setup → **Enhanced Chat User Verification** → **JSON Web Keys** → **New Key**: upload `patient-portal-chat-key.json` (5e). Then **JSON Web Keysets** → **New Keyset**: name `Patient_Portal_Keyset`, issuer `cloud-agentic-iot-patient-portal`, add the key. In **Messaging Settings**, open the channel: tick **Add User Verification**, save, then **User Verification Configuration** → **New** → `Patient_Portal_Keyset`.
3. **The agent user.** Setup → **Users** → **New User**: licence **Einstein Agent**, profile **Einstein Agent User**. Then:

**Fill in first:**
- `AGENT_USER=<the agent user's username>`: the username of the Einstein Agent user you just made. Example: `AGENT_USER=portal-agent@iot-dev.jsmith.com`. `$NAME` is already set from step 4.

```bash
AGENT_USER=<the agent user's username>
for set in AgentforceServiceAgentBase AgentforceServiceAgentUser EinsteinGPTPromptTemplateUser Patient_Portal_Agent; do
  sf org assign permset --name "$set" --on-behalf-of "$AGENT_USER"
done
PORTAL_AGENT_USER="$AGENT_USER" scripts/publish-portal-agent.sh "$NAME"
sf agent activate --api-name Patient_Portal_Agent --target-org "$NAME"
scripts/deploy-portal-routing.sh "$NAME"
```

4. **Routing.** **Messaging Settings** → the channel → Routing Type **Omni-Flow**, Flow `Route_Patient_Portal_Chat`, Fallback Queue **Care Team Queue**.
5. **The site's chat link.** From the deployment's code snippet, copy the site URL (it holds `ESW`). Put it in `Chat_Site_Url__c` in [`force-app/main/default/customMetadata/Patient_Portal_Setting.Default.md-meta.xml`](../force-app/main/default/customMetadata/Patient_Portal_Setting.Default.md-meta.xml), then:

```bash
git commit -am "Portal chat URL for my org"   # in your clone only; the deploy refuses uncommitted changes
scripts/deploy-salesforce.sh Dev
```

6. **CORS.** Setup → **CORS** → **New**: `https://<your My Domain>.my.site.com`. Publish the Embedded Service deployment again.
7. **Guest user.** The site → **Administration** → **Pages** → **Public Access**: assign `Patient_Portal_Guest_Api`.
8. **Patients.** Setup → **Users** → your user → **Edit** → Role **Care Team Administrator**. Then for each patient's Person Account: **Enable Customer User** (profile Customer Community User, its own plus-address email), and:

**Fill in first** (once per patient):
- `<patient's username>`: the username Salesforce gave the patient's Customer Community user. Example: `you+patient-a@example.com`.

```bash
sf org assign permset --name Patient_Portal_User --on-behalf-of <patient's username>
```

Put the patient's device on that account: its Asset's Account = the Person Account, record type **Patient Device**.

9. **Try it.** Sign in as the patient, ask the assistant "what is my temperature?", then "I need a nurse": a Case appears on Care_Team_Queue.

Voice: turn on **Allow Agentforce Voice calls in Enhanced Chat** in Messaging Settings only in an org licensed for Agentforce Voice. A Developer Edition refuses it, and the agent then takes no chats.

## 11. MCP server for outside agents

The deploy shipped it; it answers only SigV4-signed requests. To use it from Claude Code, with the MCP endpoint step 6 printed and your Region:

**Fill in first:**
- `<MCP endpoint>`: the "Step 11, MCP endpoint" URL that step 6 printed. Example: `https://abc123.lambda-url.us-east-2.on.aws/`.
- `<your region>`: your project's Region. Example: `us-east-2`.

```bash
claude mcp add smart-ward -- uvx mcp-proxy-for-aws-cli@latest <MCP endpoint> \
  --service lambda --region <your region> --profile "$NAME"
```

Then ask it "which devices are out of range?". Another client, or a profile that holds only the MCP role: [GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#connect-an-mcp-client).

## 12. Add a board

1. Get the parts (ESP32, DHT11, SG90 servo, a data USB cable): [Install guide, Stage 3](INSTALL-GUIDE.md#what-you-need). Wiring: [firmware/README.md](../firmware/README.md#build-and-flash).
2. In the Cloud Agentic IoT app, create a **Wi-Fi Network**, then an **Asset** with Serial Number = the board's name. It turns **Provisioned** with a bundle link.
3. Download the bundle, plug the board in by USB, and run:

**Fill in first:**
- `bundle.json`: the path of the bundle you downloaded, if it isn't in the current folder. Example: `~/Downloads/bundle.json` (then `rm ~/Downloads/bundle.json`).
- `<hotspot-SSID>`: the name of a second Wi-Fi network, such as your phone's hotspot. Example: `"My iPhone"`. The script asks for its password, hidden. Skip this line if you have only one network.

```bash
./scripts/provision-device.sh bundle.json
./scripts/update-wifi.sh "<hotspot-SSID>"   # a second network, asks for the passphrase
rm bundle.json                              # it holds the board's private key
```

Every later firmware update goes over the air: `scripts/ota.sh try Dev patient-monitor`.

## 13. Check that it works

| Check | Expect |
|---|---|
| The board's Asset | Connection `Online`, a reading every 2 s on the Live Status card |
| **Send Command** → `RESTART` on the Asset | The Device Command goes `Sent`, then `Acked` |
| Warm the sensor to 30 C (under an arm) | The board's motor sweeps, and a Case opens in Care_Team_Queue |
| Ask the agent "what is Test8 reporting?" | The latest readings, and an SOP citation when you ask what to do |
| The app's Home tab | This month's AWS spend against the limit, and the org's limits |
| `/patient-status Test8` in Slack | The live reading |
| The portal, as a patient | The patient's own device, and the assistant answering |

The full checklist: [Install guide, Stage 4](INSTALL-GUIDE.md#stage-4--verify-end-to-end). Something failed? [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 14. Dev and Prod pipelines (optional)

> [!NOTE]
> **Optional.** Steps 1 to 13 already give you a complete, working system, deployed from your laptop. Do this step only when you want GitHub Actions to deploy for you, with a separate Prod.

**What it gives you.** Two environments, each with its own branch, GitHub Environment, AWS account and Salesforce org. The names are case-sensitive and must match exactly:

| | Dev | Prod |
|---|---|---|
| Branch | `Dev`, the default branch (already exists) | `Prod`, created from `Dev` in 6 below, changed only by pull requests from `Dev` |
| GitHub Environment | `Dev` | `Prod`, with you as the required reviewer |
| AWS account | A regular account (not a project), `ca-central-1` | A second regular account |
| Salesforce org | A Developer Edition org, or your step 2 org | A separate org |
| A push deploys when | `AUTO_DEPLOY` contains `Dev` | `AUTO_DEPLOY` contains `Prod`, and you approve the run |

Why regular accounts: a project can't hold GitHub's OIDC provider, which the pipeline signs in to AWS with. Stacks don't move between accounts, so each board is provisioned again against the new one.

Do 1 to 5 for `Dev`, then again for `Prod` with the Prod account and org (replace `dev` with `prod` in the names).

1. **The AWS account, as root.** Create a regular AWS account and turn on MFA for root. IAM → **Policies** → **Create policy** → JSON: paste [`scripts/aws-project-policy.json`](../scripts/aws-project-policy.json), name `cloud-agentic-iot-operator`. IAM → **Users** → **Create user** `iot-operator`, attach that policy, MFA on, then **Security credentials** → **Create access key** (CLI). Then do the Bedrock check from step 2 in this account too, and open its Support case at once if it is held.
2. **The deploy role and the budget.** `bootstrap-aws.sh` creates the OIDC provider, the `github-actions-deploy` role and the `cloud-agentic-iot-monthly` budget, and offers to store the role's ARN as `AWS_ROLE_ARN`:

**Fill in first:**
- `aws configure` asks for `iot-operator`'s access key ID and secret (from 1). Type them at its prompts, Region `ca-central-1`, output `json`.
- `BUDGET_USD=20`: the monthly amount to watch, in US dollars. Example: `BUDGET_USD=50`.
- `BUDGET_EMAIL='<your email>'`: where the budget alerts go. Example: `BUDGET_EMAIL='you@example.com'`.
- For Prod, use `iot-prod` instead of `iot-dev` and `Prod` instead of `Dev`.

```bash
aws configure --profile iot-dev     # iot-operator's access key, Region ca-central-1
export AWS_PROFILE=iot-dev
gh auth login
BUDGET_USD=20 BUDGET_EMAIL='<your email>' scripts/bootstrap-aws.sh Dev
```

3. **The org's two service users and apps.** In the environment's org, do steps 3 and 5a to 5c as before (the integration user and app). Then add the deploy user the pipeline signs in as:

```bash
sf org login web --alias iot-dev-admin
export SF_TARGET_ORG=iot-dev-admin
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout scripts/server-deploy.key -out scripts/server-deploy.crt \
  -subj "/CN=CloudAgenticIoT-Deploy/O=Personal/C=CA"
sf project deploy start --source-dir scripts/Metadata_Deploy.permissionset-meta.xml
```

   Setup → **Users** → **New User**: Last name `Deploy`, its own plus-address email, Username `deploy@iot-dev.<yourdomain>`, licence **Salesforce**, profile **System Administrator**. Then `sf org assign permset --name Metadata_Deploy --on-behalf-of deploy@iot-dev.<yourdomain>`. Create a second External Client App, `Cloud Agentic IoT Deploy`, as in 5c with `scripts/server-deploy.crt`, and set its policy: **Admin approved users are pre-authorized**, permission set `Metadata_Deploy`. Copy its **Consumer Key**.

4. **GitHub secrets and variables.** The script creates the environment, limits it to its branch, makes you Prod's reviewer, and asks for each value below, hiding secrets and base64-encoding the key files itself:

```bash
./scripts/setup-github-secrets.sh   # choose Dev; answer n to AUTO_DEPLOY for now
```

   Every value, per environment (Settings → **Environments** → `Dev` or `Prod`):

| Name | Kind | Value, and where it comes from | Set by the script? |
|---|---|---|---|
| `AWS_ROLE_ARN` | Secret | `DeployRoleArn` of the bootstrap stack (2) | Yes, read from the stack |
| `AWS_REGION` | Variable | `ca-central-1` | Yes |
| `ALARM_EMAIL` | Variable | Optional: who the CloudWatch alarms email | Yes, Enter skips |
| `SF_CONSUMER_KEY` | Secret | Consumer key of `Cloud Agentic IoT Deploy` (3) | Yes |
| `SF_USERNAME` | Secret | `deploy@iot-dev.<yourdomain>` (3) | Yes |
| `SF_JWT_KEY` | Secret | `scripts/server-deploy.key`, base64-encoded (3) | Yes, from the file |
| `SF_LOGIN_URL` | Variable | `https://login.salesforce.com` | Yes |
| `SF_INTEGRATION_CONSUMER_KEY` | Secret | Consumer key of `Cloud Agentic IoT Integration` (5c) | Yes |
| `SF_INTEGRATION_USERNAME` | Secret | `integration@iot-dev.<yourdomain>` (5b) | Yes |
| `SF_INTEGRATION_JWT_KEY` | Secret | `scripts/server-integration.key`, base64-encoded (5a) | Yes, from the file |
| `SLACK_SIGNING_SECRET` | Secret | Optional: the Slack app's signing secret (5d). Without it the Slack stack is skipped | Yes, Enter skips |
| `DATA_CLOUD_OIDC_PROVIDER_ARN` | Variable | Optional, for Data Cloud: the provider ARN from the commands below | **No, by hand** |
| `DATA_CLOUD_EXTERNAL_ID` | Variable | Optional, for Data Cloud: the connection's External ID (9, step 2, with **Identity Provider (IdP) Based**) | **No, by hand** |

   And on the repository (Settings → **Secrets and variables** → **Actions** → **Variables**):

| Name | Kind | Value | Set by the script? |
|---|---|---|---|
| `AUTO_DEPLOY` | Variable | `Dev`, later `Dev Prod`: which branches deploy on a push | Yes, when you answer `y` |
| `EVAL_DEVICE`, `EVAL_OTHER_DEVICE`, `EVAL_PATIENT_USERNAME` | Variable | Optional, for the **Agent evals** workflow: a test patient's board (`Test8`), another board (`Test7`), the test patient's username | **No, by hand** |

   To set or change any one value by hand, type it at the prompt, never on the command line:

```bash
gh secret set SF_CONSUMER_KEY --env Dev                               # asks for the value, hidden
base64 < scripts/server-deploy.key | gh secret set SF_JWT_KEY --env Dev
gh variable set AWS_REGION --env Dev --body ca-central-1
gh variable set EVAL_DEVICE --body Test8                              # a repository variable: no --env
```

   Data Cloud in a regular account reads the bucket through the org's identity provider, with no key. As an AWS admin, with your My Domain (no `https://`) and the External ID:

**Fill in first:**
- `MY_DOMAIN=<your My Domain>`: from Setup → **My Domain**, without `https://`. Example: `MY_DOMAIN=jsmith-dev-ed.develop.my.salesforce.com`.
- `<External ID>`: the External ID the Data Cloud connection showed (9, step 2). Paste it between the quotes.
- For Prod, use `--env Prod`.

```bash
MY_DOMAIN=<your My Domain>
aws iam create-open-id-connect-provider \
  --url "https://$MY_DOMAIN/services/connectors" --client-id-list "https://$MY_DOMAIN"
gh variable set DATA_CLOUD_OIDC_PROVIDER_ARN --env Dev \
  --body "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):oidc-provider/$MY_DOMAIN/services/connectors"
gh variable set DATA_CLOUD_EXTERNAL_ID --env Dev --body '<External ID>'
```

   After the next deploy, paste the patient-vitals stack's `DataCloudReaderRoleArn` output into the connection's **IAM Role Name**.

5. **First run.** Actions → **Deploy** → **Run workflow** → branch `Dev` → part `everything`. When it's green: set the integration app's policy (step 6), then steps 7 to 13 against this org and account. Then switch pushes on:

```bash
gh variable set AUTO_DEPLOY --body "Dev"
```

6. **Prod.** Once Dev's first deploy is green, create the branch and repeat 1 to 5 with `Prod`, the Prod account (`iot-prod`) and the Prod org (`iot-prod-admin`, `deploy@iot-prod.<yourdomain>`):

```bash
git switch Dev && git pull && git switch -c Prod && git push -u origin Prod
./scripts/setup-github-secrets.sh   # choose Prod
gh variable set AUTO_DEPLOY --body "Dev Prod"
```

   From then on, a pull request from `Dev` into `Prod` deploys Prod after you approve the run in the Actions tab.

7. **Branch rules.** Settings → **Branches** → add a rule for `Dev` and one for `Prod`: require a pull request, and require the checks to pass (Lambda tests, CloudFormation templates, Shell scripts, Salesforce metadata, Firmware, Patient portal (React)).

Why each piece stays manual: [DEVELOPMENT.md](DEVELOPMENT.md#what-stays-manual-and-why).
