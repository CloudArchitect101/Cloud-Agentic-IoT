# Data Model: Standard-First Rationale

Rule applied: **reuse the platform until there is a written reason not to.** Every object below states which side of that line it falls on and why. This is the document to open when an reviewer asks "why didn't you just use X?"

## Objects

| Object | Standard or custom | Why |
|---|---|---|
| **Person Account** | Standard | B2C patients. Free on EE+; customers never consume licenses. |
| **Asset** | Standard | The device registry. SerialNumber = IoT Thing name, Account = the patient, Status/InstallDate out of the box. Two record types say what a board is for ([below](#device-roles)): `Patient_Device` and `Internal_Device`. The added fields hold what AWS knows about the board: its Thing ARN, certificate, Thing Group and provisioning status, and, from AWS IoT's own connect and disconnect events, `Connection_Status__c`, `Connection_Since__c` and `Last_Disconnect_Reason__c` ([LIVE-STATUS.md](LIVE-STATUS.md)). Readings are never stored on it. Replaced an earlier custom `Patient_Device__c` that re-implemented all of this. |
| **Case** | Standard | All human-actionable work: queue depth (chapter 03), agent escalations (chapter 05, stamped `Origin=Agentforce`), and the temperature alert demo rule (chapter 03, `Origin=Room Temperature Rule`, labelled Temperature Alert Rule, at most one open per device's Asset). Standard queues, assignment, reports come free. |
| **Group (Queue)** | Standard | Drives the physical indicator. No custom "work bucket". |
| `Patient_Vitals__c` (label Device Reading) | Custom — deliberate | Alert-worthy readings only (state transitions, non-STABLE), plus high temperature reports AWS flagged with `Room_Temperature_Alert__c` (on crossing 30 C, then at most once per re-alert interval). Health Cloud's `CareObservation` is the standard answer but Health Cloud is a paid SKU outside the free-tier build; raw telemetry belongs in DynamoDB + Data Cloud ingestion, not CRM rows. Documented tradeoff, not an oversight. |
| `Patient_Daily_Summary__c` | Custom — deliberate | The aggregation unit that gets embedded for RAG. No standard equivalent. |
| `Room_Readings` (Data Cloud) | Custom data model object — deliberate | Every room reading, from the S3 archive's CSV copy, for the calculated insights ([DATA-CLOUD.md](DATA-CLOUD.md)). It lives in Data Cloud, not in CRM storage, which is what lets every reading be kept where `Patient_Vitals__c` keeps only the ones someone acts on. Custom, so its fields are named as the CSV names them and the insights SQL can rely on them. |
| `Device_Command__c` | Custom — deliberate | Auditable command lifecycle (Pending→Sent→Acked/Failed) for physical devices, with the board's own answer: [below](#device-command-lifecycle). No standard object models this. |
| `Device_Queue_Binding__mdt` | Custom Metadata | Configuration, not data: how fast a queue's boards turn, and one more board that follows it if wanted. Every Internal Device follows the Internal Device Queue without one. Admin-editable, deployable, no storage cost. |
| `Aws_Spend_Snapshot__c` | Custom setting (hierarchy) | The last AWS spend the Home page's usage card read, for when AWS does not answer. One org-default row; Platform Cache would need storage Developer Edition does not have. |
| `Queue_Depth_Change__e`, `Patient_Vital_Alert__e` | Platform Events | The platform's native pub/sub. One publisher, any number of subscribers (servo, LWC, agent) that cannot drift apart. |

## Code

| Layer | Choice | Why |
|---|---|---|
| Triggers/Apex | Only where Flow can't: bulk aggregate recount, callouts with SigV4/JWT, saga logic, bulk dedupe | Sending a Device Command is Apex for that reason: a SigV4 callout from a Queueable, safe for a bulk insert. The room-temperature rule's `PatientVitalsTrigger` is Apex because Flow cannot dedupe a 200-row batch against open Cases while holding a lock on the Assets. Everything else is Flow territory and documented as such. |
| Agent Actions | `@InvocableMethod` | Platform-native tool surface for Agentforce — no custom dispatch layer. |
| LWC | Four components: `queueDepthIndicator` (chapter 03), `reprovisionDevice` (the Re-provision action), `deviceLiveCard` (live status) and `platformUsageCard` (the app's Home page: AWS spend and Salesforce limits) | The queue indicator subscribes via `empApi` to the same event the servo consumes. The live card takes readings from AWS IoT over MQTT, never through Salesforce. The usage card reads AWS spend through the device API, once per page load. UI elsewhere is standard reports/dashboards/record pages. |
| Auth | Named Credentials / JWT Bearer everywhere | No passwords, no keys in code, anywhere. |

## Device roles

Every board runs the same firmware (patient-monitor); its Asset's record type decides what Salesforce tells it. `DeviceRoles` reads it.

| Record type | Who it is for | Account | Its servo turns while | Temperature alert Case | Thing Group when provisioned with none named |
|---|---|---|---|---|---|
| `Patient_Device` (label Monitoring Device; the default), or none | Whatever its sensor monitors: a patient, a fridge, a room | The patient's, or the ward's | Its own DHT11 reads 30 C or more, decided on the board | Yes | `Default_Thing_Group__c`, `fleet-patient-monitor` |
| `Internal_Device` | The ward: a nurse-station indicator | The ward's own Account (Salesforce wants an Account or a Contact on every Asset; Person Accounts are off in this org) | Any open Case is owned by `Internal_Device_Queue__c` (Care_Team_Queue), on any device or none (`QUEUE_DEPTH`) | No | `Internal_Thing_Group__c`, `internal-devices` (inside `fleet-patient-monitor`, so every release reaches it) |

Changing an Asset's record type tells its board at once: one that becomes internal gets the queue's depth; one that becomes a monitoring device gets a queue stop. Both record types are visible in `Device_Platform_Admin` and `Device_Integration`. The AWS Thing Group is set when the device is provisioned; to move a board that is already provisioned, `scripts/ota.sh join <env> <thing> patient-monitor internal`.

## Device Command lifecycle

A Device Command is one instruction to one board, kept as a record so there is an audit trail of who asked for what and what the board said. It is created from the device's Asset (**Send Command**) or through the API. (Until Nov 10 Slack's `/dispense-medication` and the temperature rule also created `DISPENSE_MEDICATION` commands; that command is retired and its value inactive.)

**No case alert.** A monitored board's servo follows its own sensor's temperature, never a Case. `CASE_ALERT` is an inactive Command value that nothing sends; a board answers it as done and ignores it.

| Status | Set by | Means |
|---|---|---|
| `Pending` | The record's creation | Waiting to be sent. An Apex job sends it seconds later, as the user who created it. |
| `Sent` | The send job, with `Sent_At__c` | AWS accepted the command for the board's topic. It stays here while the board is offline. |
| `Acked` | The board's answer, with `Answered_At__c` | The board carried it out. |
| `Failed` | The send job, or the board's answer | Not sent (the device is not provisioned, its board is offline, AWS refused, or Salesforce would not start another job to send it), or the board could not carry it out or does not know the command. `Status_Detail__c` says which, in the board's own words where it gave some. A board's answer still applies to a command Salesforce marked Failed itself, since a send that timed out may have reached the board. |

The board's answer travels back through AWS IoT (`device/<thing>/ack`), a queue and a Lambda into one Salesforce call per batch of up to 10 answers; it is accepted only from the board the command was for. A command reaches the board at most once: the send job never sends a record twice, and a board that receives one `commandId` twice carries it out once. The guardrails in device-command check every command on this path (a known command, its own settings, the ranges the board accepts; [GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md)). [firmware/README.md](../firmware/README.md#commands-what-a-board-takes-and-how-it-answers) lists the commands a board takes and its answers.

## The one-line answers

- *"Why not Health Cloud?"* — right model, paid SKU; the free build stays core-platform and says so.
- *"Why is any vitals data in CRM at all?"* — only events a human or agent acts on; the time series lives in DynamoDB, the analytical copy in Data Cloud.
- *"Why custom metadata instead of custom settings?"* — deployable through the pipeline, versioned in git.

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
