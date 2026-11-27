# Guardrails and the MCP server

The Smart Ward use case: monitored devices report temperature and humidity
from wherever their sensor sits (against a patient, in a medication fridge,
in a room), each with an alert motor that turns while its sensor reads high,
and the care team works from Salesforce, where the **Patient Care Agent** reads
a device's readings and opens Cases. This page covers the two pieces that let
an agent *act* on a device without being trusted to:

- **Guardrails** — rules outside the model that every command to a board
  passes, whoever sends it.
- **The MCP server** — the ward's devices as [Model Context
  Protocol](https://modelcontextprotocol.io) tools, for agents outside
  Salesforce: device status, the devices out of range, and one command to one
  device. The tool names still say "room" (`get_room_status`,
  `list_rooms_out_of_range`); they are renamed later.

Both deploy with `scripts/deploy-aws.sh`, like every other stack. Nothing in
Salesforce changes, and the Patient Care Agent keeps using its Apex actions.

## Where the agent's actions reach AWS

Nothing the agent does calls AWS directly. Its actions are Apex
(`PatientCareAgentActions.escalate` creates a Case; `DeviceReadingsAgentAction`
reads stored readings; `ProcedureSearchAgentAction` asks `POST /find-procedure`
for ward SOP passages, which reads only the SOP index and masks what it returns
with this page's `maskPii`, [SOP-GROUNDING.md](SOP-GROUNDING.md)). What reaches
a board goes through one door:

```
Send Command on an Asset, a person, a Flow ───────────────┐
                                                           ├─> Device_Command__c (Pending)
                                                           │      └─> DeviceCommandSendJob
Wi-Fi Network record ─> WiFiCredentialPushJob ─────────────┘             │
                                                                         │  Named Credential AWS_IoT_Relay (SigV4)
                                                                         v
                                        API Gateway  POST /device-command  (AWS_IAM)
                                                                         │
MCP client ─SigV4─> function URL ─> mcp-server ─ lambda:InvokeFunction ──┤
                                                                         v
                                        device-command ── checkCommand (lambda/shared/guardrails.js)
                                                                         │ allowed
                                                                         v
                                        AWS IoT  device/<thing>/command ─> the board
```

## Guardrails: where they run, and why there

**The choice: a shared module inside device-command, not a hop in front of
it.** `lambda/shared/guardrails.js` holds the rules, and
`lambda/device-command/index.js` runs `checkCommand` on every request, after its
own checks (Thing names, the `commandId`, `CASE_ALERT`'s `active`) and before
anything is published. The other options were weighed:

| Option | Why not |
|---|---|
| Route `POST /device-command` through the guardrails function first | A second Lambda on the path: more latency inside Salesforce's 25-second callout, one more thing to fail, and a guardrails outage stops every command. And device-command could still be invoked around it. |
| Call the guardrails function from Apex before each callout | Each caller has to remember; `WiFiCredentialPushJob` and any future job would be one forgotten call away from no guardrails. |
| Guardrails in the agent's prompt | A prompt is a request, not a control. |

In the function that publishes, the check cannot be skipped by any caller:
Salesforce through API Gateway and the MCP server by invoking the function
both pass it. It is plain code with no AWS calls, so
`test/lambda/guardrails.test.js` tests every rule directly and
`test/lambda/device-command.test.js` tests that device-command enforces them.

**What `checkCommand` enforces** (fails closed: what it does not know, it refuses):

| Rule | Detail |
|---|---|
| Allowed commands | `RESTART`, `CASE_ALERT`, `WIFI_UPDATE`, `SET_TELEMETRY_INTERVAL`, `LIVE`: what a board takes. Anything else (`REBOOT`, a misspelling, `DISPENSE_MEDICATION`, retired Nov 10) is a 400 before it reaches the board. |
| Only that command's settings | An extra field is refused. The board reads `command` as the operation when `operation` is missing, so extra fields are not harmless. |
| Ranges the boards accept | `SET_TELEMETRY_INTERVAL` seconds 5–86400; `LIVE` seconds 1–60, minutes 0–30 (`DeviceTiming.h`); `CASE_ALERT` active true or false; `WIFI_UPDATE` SSID 1–32 bytes and a passphrase empty or 8–64. A test compares these with the firmware. |
| How many devices | At most 200 per request (`Commands_Per_Callout__c`; a test fails if Salesforce is set to send more). |

A refusal answers 400 with `failures` (codes such as `out_of_range:seconds`)
and a message. Neither ever repeats a value, so a too-short Wi-Fi passphrase
cannot show up in a log line or a Salesforce `Status_Detail__c`.

**The agent profile.** An agent outside Salesforce gets a narrower set:
`RESTART`, `CASE_ALERT` and `SET_TELEMETRY_INTERVAL`, one device at a time.
`WIFI_UPDATE` carries credentials, so it is refused.

**Business rules.** `checkBusinessRules` holds what a model cannot waive. Its
example: closing a high temperature alert (`CLOSE_TEMPERATURE_ALERT`) needs a
recheck recorded by a person and a newest reading below the re-arm level
(29 C, SOP-WARD-001); with either number missing it fails closed. Nothing on
the device path calls it yet; the guardrails function answers it with
`phase: "action"`.

**PII masking and output checks.** `maskPii` uses the same four patterns,
labels and order as `PiiMaskingService.cls` (a test fails if they drift):
emails, phone numbers, SSNs and health card numbers become `[EMAIL_1]` and so
on. `checkOutput` blocks an answer that still carries an SSN, a private key or
an AWS access key ID. The MCP server runs both on every tool answer. Input
screening (`checkInput`) is a tripwire, not a wall: injection phrasing is
logged for review, and the rules decide.

**The guardrails function.** `lambda/guardrails` deploys the same rules as a
function with a logs-only role and no trigger or URL. Identities in the
account with `lambda:InvokeFunction` on it can ask it what the rules would say,
with a `phase` of `command`, `input`, `output`, `mask` or `action`.
Enforcement does not depend on it: that is the module in device-command.

```bash
aws lambda invoke --function-name cloud-agentic-iot-guardrails --cli-binary-format raw-in-base64-out \
  --payload '{"phase":"command","operation":"SET_TELEMETRY_INTERVAL","fields":{"seconds":3},"profile":"agent"}' \
  /dev/stdout
```

**What it does not do yet.** The Patient Care Agent's prompts are still not PII-masked
(`PiiMaskingService` is not called from the agent).

## The MCP server

`lambda/mcp-server` is an MCP server over Streamable HTTP, answered as plain
JSON with no event stream and no session, so each POST stands alone and a
Lambda can answer it. Protocol revisions 2025-06-18, 2025-03-26 and
2024-11-05.

| Tool | What it does | Reads / calls |
|---|---|---|
| `get_room_status` | One monitored device: newest reading and when, `online` / `stale` / `unknown`, its state and risk score, whether the reading is at or above the temperature alert level, and whether a high temperature alert is open | patient-vitals table: newest `VITAL#` item and the `STATE` item |
| `list_rooms_out_of_range` | Every device whose newest reading is at or above the threshold (30 °C, inclusive, the same `RoomTempAlertCelsius` patient-vitals uses), whose alert is open, or whose monitor has gone quiet (`OfflineAfterMinutes`, 5), with the reasons | the same table, scanned for `STATE` items |
| `send_device_command` | One of `RESTART`, `CASE_ALERT` (with `active`), `SET_TELEMETRY_INTERVAL` (with `seconds`) to one device | the guardrails' agent profile, then **invokes device-command**, which runs the device API's rules again and publishes |

The earlier name `get_device_telemetry` still answers, as `get_room_status`.
`get_queue_depth` only ever returned a placeholder, and now says so: the
queue's Cases live in Salesforce, which this server does not read.

What the tools can and cannot tell:

- **"Alert open"** is the `RoomTempHot` flag patient-vitals keeps: on from the
  first reading at or above the threshold until one drops a degree below it.
  That episode is what makes Salesforce open one care team Case
  (`RoomTemperatureCaseService`). The Case itself, and whether someone has
  closed it, is in Salesforce. In an environment with `RoomTempAlert` off
  (Prod's config) it is never set.
- **"Stale"** means no stored reading for `OfflineAfterMinutes`. It is the
  stored readings' view, not AWS IoT's connection state, which only the Asset
  in Salesforce shows (device-presence writes it there). Where readings are
  not kept in DynamoDB (`KeepReadingsInDynamoDB` false, as in Prod) a device's
  connectivity is `unknown`, and the answer counts those devices separately.
- **`send_device_command`** answers whether AWS IoT took the command, not
  whether the board carried it out. It records no `Device_Command__c` in
  Salesforce and sends no `commandId`, so the board does not answer it.
  Use a Device Command in Salesforce when the record and the board's answer
  matter.
- **`list_rooms_out_of_range` scans the table.** A Scan reads, and is billed
  for, every item, including stored readings, and filters afterwards.
  `MaxRoomsScanned` (500 in Dev, 2,000 in Prod) caps one call. For a
  fleet of thousands, add a sparse index on the `STATE` items, or have
  patient-vitals keep a short list of devices out of range.

### Authentication

The function URL's auth type is **`AWS_IAM`**: Lambda checks each request's
SigV4 signature before the code runs, and the signer needs
`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the function. The
template adds no resource-based policy, so no other account, and nothing
unsigned, can call it. This was the simplest secure choice: no API Gateway, no
user pool and no secret to rotate, and it fits the account's existing
identities. The stack also creates **`McpClientRole`**, which may call this URL
and nothing else, for a client that should hold no other rights.

The server's own role may read the patient-vitals table and invoke
`cloud-agentic-iot-device-command`. It has no `iot:Publish`, so it cannot
reach a board around the guardrails. `test/lambda/mcp-server.test.js` pins
both roles and the URL's auth type.

### Connect an MCP client

MCP clients do not sign SigV4 requests themselves. AWS's open-source
[MCP Proxy for AWS](https://github.com/aws/mcp-proxy-for-aws) runs locally as
a stdio MCP server, signs each request with your AWS credentials and forwards
it. It needs [`uv`](https://docs.astral.sh/uv/) (`brew install uv`).

1. **The endpoint and the role**, after `scripts/deploy-aws.sh` (it also prints both):

   ```bash
   aws cloudformation describe-stacks --stack-name cloud-agentic-iot-mcp-server-Dev \
     --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output text
   ```

2. **Credentials.** The profile you deploy with can usually call the URL
   already: `iot-operator` holds `lambda:*` (`scripts/aws-project-policy.json`),
   and so does an AWS project's own `aws login` profile in
   the [Quick Install Guide](INSTALL.md#step-4). For a client that should hold nothing else, add a
   profile that assumes `McpClientRole` to `~/.aws/config`. This has not been
   tried with an `aws login` profile as the `source_profile`. If the proxy
   cannot get credentials that way, pass the `aws login` profile directly:

   ```ini
   [profile smart-ward-mcp]
   source_profile = iot-dev
   role_arn = <McpClientRoleArn>
   region = <your region>
   ```

3. **The client.** For Claude Code:

   ```bash
   claude mcp add smart-ward -- uvx mcp-proxy-for-aws-cli@latest <McpServerEndpoint> \
     --service lambda --region <your region> --profile smart-ward-mcp
   ```

   For a client configured in JSON (Claude Desktop and others):

   ```json
   {
     "mcpServers": {
       "smart-ward": {
         "command": "uvx",
         "args": ["mcp-proxy-for-aws-cli@latest", "<McpServerEndpoint>",
                  "--service", "lambda", "--region", "<your region>", "--profile", "smart-ward-mcp"]
       }
     }
   }
   ```

   `--service lambda` matters: a function URL is signed for the `lambda`
   service, and the proxy's own examples sign for Bedrock AgentCore.
   `--read-only` hides `send_device_command`, which is the only tool not marked
   `readOnlyHint`.

4. **Ask it** "which devices are out of range?" or "what is the status of
   ESP32-Patient-Monitor-01?".

To check the server without any client, invoke the function directly. This
needs `lambda:InvokeFunction` on it, which the operator has; it skips the URL,
not IAM:

```bash
aws lambda invoke --function-name cloud-agentic-iot-mcp-server --cli-binary-format raw-in-base64-out \
  --payload '{"body":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"}' /dev/stdout
```

A 403 from the URL means the request was unsigned, signed for the wrong
service or Region, or signed by an identity without the two actions.

## Optional: Agentforce as an MCP client of this server

The in-org **Patient Care Agent keeps using its Apex actions**
(`PatientCareAgentActions`, `DeviceReadingsAgentAction`), and nothing here
changes it. Those run inside Salesforce with sharing, as the person talking to
the agent, and their commands go through `Device_Command__c`, with its record,
the board's answer and the Salesforce-side checks. Pointing the in-org agent at
this server would trade all of that for a second path to the same devices.

Should an Agentforce agent ever call this server, here is where Salesforce
support stood when this was written (November 2026; check the linked pages,
because it moves every release):

- **Status.** Salesforce describes the MCP client built into Agentforce as
  generally available ([Summer '26 architect
  highlights](https://www.salesforce.com/blog/summer-26-release-architect-highlights/)).
  A third-party server is registered in **Agentforce Registry** in Setup, and
  its allowlisted tools become agent actions ([Register a Third-Party MCP
  Server](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_connect_register.htm&language=en_US&type=5)).
- **Transport.** Streamable HTTP only, which this server speaks. The client
  times out at 60 seconds ([Considerations for MCP for
  Agentforce](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_considerations.htm&language=en_US&type=5)).
- **Authentication.** The considerations page lists **no authentication and
  OAuth 2.0 client credentials only**. The registration page also offers an
  external credential with per-user authentication for Employee agents; the
  two pages disagree. **AWS SigV4 is not offered**, so Agentforce cannot call
  this server's `AWS_IAM` function URL as it stands.
- **What it would take.** A second, OAuth-protected way in: an API Gateway
  HTTP API with a JWT authorizer, backed by an Amazon Cognito user pool app
  client using the client-credentials grant and a custom scope, routing
  `POST /mcp` to the same function. Registered in Agentforce Registry as
  OAuth 2.0, with the Cognito token URL, client ID, secret and scope. This is
  not built here, and it must never be "no authentication".
- **Tool names.** The considerations page lists the characters allowed in a
  tool name, and as rendered the list does not clearly include `_`. Check
  this before registering. If underscores are refused, add hyphenated aliases.

That is a different direction from **Salesforce's own hosted MCP servers**,
which let agents outside Salesforce read and act on Salesforce data. This
server goes the other way: an agent reaching the ward's devices in AWS. Nothing
here uses or builds the hosted servers.

## Espressif MCP servers for the agents

The other direction again, and the first outside MCP servers our agents call:
anyone asks a generic ESP32 question, such as "What is the spec of the
ESP32-S3-DevKitC-1?", in the agent panel, in Slack or in the patient portal,
and the agent answers from Espressif's own catalogs. **Nobody signs in.**
Setup clicks: [INSTALL.md step 11b](INSTALL.md#espressif-mcp). The record of
what each org registers: [`config/mcp-servers.json`](../config/mcp-servers.json).

```
staff in Lightning or Slack ─> Patient Care Agent  ─ router ─> ESP32_Hardware ─┐
patient in the portal chat  ─> Patient Portal Agent ─ router ─> esp32_hardware ─┤ only chip, board or
                                                                                │ component names
            Agentforce MCP client (No Authentication) <─────────────────────────┘
              ├─> ESP Pilot               https://mcp.esp-pilot.espressif.com/mcp
              └─> ESP Component Registry  https://components.espressif.com/mcp
```

**The servers** (each tested with MCP `initialize`, `tools/list` and a tool
call on Nov 19, 2026; all Streamable HTTP, no auth, no published rate limit):

| Server | Allowlisted tools (all read-only) | Answers | Doesn't answer |
|---|---|---|---|
| ESP Pilot | `catalog_list_socs`, `catalog_list_bmgr_boards`, `catalog_list_bmgr_peripherals` | Which chips ESP-IDF supports (ESP32, C2, C3, C5, C6, C61, H2, H21, H4, P4, S2, S3, S31), Espressif's board catalog (ESP Board Manager) with each board's chip, devices and peripherals, a chip's peripherals | Datasheet figures; the catalog is mostly audio and display boards, so a plain DevKitC may be missing |
| ESP Component Registry | `search_components`, `fetch_component_detailed_information` | ESP-IDF drivers and components, such as a DHT11 or servo driver | Hardware specs |

**What we chose not to use.** Espressif's documentation server
(`https://mcp.espressif.com/docs`, tool `search_espressif_sources`) is the one
that searches datasheets and reference manuals, and would answer a full spec.
It needs each user to sign in with GitHub or WeChat (it answers `401
invalid_token` without), and allows each user 40 searches an hour and 200 a
day. Agentforce could reach it only through a per-user External Credential,
for employee agents only, so not the portal. Vitaly chose no sign-in in every
agent instead, so the agents give what the open catalogs hold and link
https://docs.espressif.com and Espressif's technical documents page for the
rest. Espressif Engineering and RainMaker also need a sign-in and answer other
things (troubleshooting guides, your RainMaker devices).

**Guardrails.**
- **Read-only.** Only the five tools above are allowlisted, and the ESP32
  subagents have no device, procedure, escalation or nurse action.
- **No org data leaves.** The subagents send Espressif only generic Espressif
  terms (a chip, board or component name), never a patient, a serial number,
  a reading, a Case number or anything else from the org or the chat. Asked a
  mixed question, the staff agent searches the generic part and says it left
  the rest out. Each router sends questions about a monitored device, or the
  patient's own sensor, to the device subagent first. Because no one signs
  in, Espressif sees only Salesforce's servers, not who asked.
- **Grounded.** The subagents call the actions every turn (a board name
  becomes a chip id, ESP32-S3-DevKitC-1 → `esp32s3`, whose peripherals ESP
  Pilot lists), and add only facts from a short reference card copied from
  Espressif's product pages (ESP32-S3 and the DevKitC-1, checked Nov 19,
  2026). Anything else points to https://docs.espressif.com; never from
  memory. Agentforce turns any link whose host is not in the org's Trusted
  URLs into `URL_Redacted`, so the repo ships Espressif's two hosts as Trusted
  URLs and the subagents link only those.
  A new board's facts go into that card from its Espressif page.
- **Results are data.** Instructions inside returned text are ignored.
  Salesforce also warns about hidden Unicode in tool descriptions at allowlist
  time; read each one before ticking it.
- **Patient chats.** In the portal it is a side answer in plain words, after
  which the agent goes back to the patient's sensor or a nurse.
- **Fails visibly.** A server down: the agent says so and links
  docs.espressif.com.

**Tests.** `test/config/esp32-mcp.test.js` checks that no server needs a
sign-in, both routers and subagents, that the subagents hold no org action and
carry the no-org-data rule, the docs, and the probe against fake servers. The
Testing Center specs route "What is the spec of the ESP32-S3-DevKitC-1?" to
`ESP32_Hardware` and `esp32_hardware`, and check a question with a patient's
name in it doesn't echo the name ([AGENT-EVALS.md](AGENT-EVALS.md)).
`node scripts/lib/mcp-probe.js` checks, for free, that each server still
answers and still offers every allowlisted tool.

**KPIs.**

| KPI | Target | Where it comes from |
|---|---|---|
| Routing accuracy for ESP32 questions | 100% of the eval cases | `scripts/eval-agents.sh Dev agents` |
| Answers that name their catalog, or link docs.espressif.com when the catalog lacks it | ≥ 95% | Testing Center judged outcome |
| Org data in an outbound action input | 0 | The eval case with a patient's name in it, plus a monthly look at the actions' inputs in the agents' event logs |
| Tool latency | p95 < 10 s (Agentforce gives up at 60 s, 120 s for the whole turn) | The probe's latency, the agents' event logs |
| Probe passing | Every run | `node scripts/lib/mcp-probe.js` before a demo |
| Questions sent to docs.espressif.com because no catalog had it | Watched, not targeted | Judged outcomes; a high share is the case for adding the sign-in docs server for staff later |

**Cost.** Espressif charges nothing. Each MCP tool action is billed like any
other agent action: 20 Flex Credits, about **$0.10**; a question takes one or
two ([COST-MODEL.md](COST-MODEL.md#8-espressif-mcp-servers-for-the-agents)).
A Developer Edition org uses its included credits. No AWS cost: Salesforce
calls Espressif directly.

**Scaling.** No sign-in and no per-user state, so it serves any number of
staff and patients; the published limits are none, so watch the probe and the
failure rate as use grows. Another server is one entry in
`config/mcp-servers.json` plus a registration and its actions; the tests hold
it to the same rules (read-only, https, Streamable HTTP, no sign-in, named
agents).

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
