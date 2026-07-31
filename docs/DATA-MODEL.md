# Data Model: Standard-First Rationale

Rule applied: **reuse the platform until there is a written reason not to.** Every object below states which side of that line it falls on and why. This is the document to open when an reviewer asks "why didn't you just use X?"

## Objects

| Object | Standard or custom | Why |
|---|---|---|
| **Person Account** | Standard | B2C patients. Free on EE+; customers never consume licenses. |
| **Asset** (+2 fields) | Standard | The device registry. SerialNumber = IoT Thing name, Account = the patient, Status/InstallDate out of the box. Only `Firmware_Version__c` and `Last_Telemetry_At__c` added. Replaced an earlier custom `Patient_Device__c` that re-implemented all of this. |
| **Case** | Standard | All human-actionable work: queue depth (chapter 03), agent escalations (chapter 05, stamped `Origin=Agentforce`). Standard queues, assignment, reports come free. |
| **Group (Queue)** | Standard | Drives the physical indicator. No custom "work bucket". |
| `Patient_Vitals__c` | Custom — deliberate | Alert-worthy readings only (state transitions, non-STABLE). Health Cloud's `CareObservation` is the standard answer but Health Cloud is a paid SKU outside the free-tier build; raw telemetry belongs in DynamoDB + Data Cloud ingestion, not CRM rows. Documented tradeoff, not an oversight. |
| `Patient_Daily_Summary__c` | Custom — deliberate | The aggregation unit that gets embedded for RAG. No standard equivalent. |
| `Device_Command__c` | Custom — deliberate | Auditable command lifecycle (Pending→Sent→Acked/Failed) for physical devices. No standard object models this. |
| `Device_Queue_Binding__mdt` | Custom Metadata | Configuration, not data: which queue drives which device. Admin-editable, deployable, no storage cost. |
| `Queue_Depth_Change__e`, `Patient_Vital_Alert__e` | Platform Events | The platform's native pub/sub. One publisher, any number of subscribers (servo, LWC, agent) that cannot drift apart. |

## Code

| Layer | Choice | Why |
|---|---|---|
| Triggers/Apex | Only where Flow can't: bulk aggregate recount, callouts with SigV4/JWT, saga logic | Everything else (command→event publication) is Flow territory and documented as such. |
| Agent Actions | `@InvocableMethod` | Platform-native tool surface for Agentforce — no custom dispatch layer. |
| LWC | One component: `queueDepthIndicator` (chapter 03) | Subscribes via `empApi` to the same event the servo consumes. UI elsewhere is standard reports/dashboards/record pages. |
| Auth | Named Credentials / JWT Bearer everywhere | No passwords, no keys in code, anywhere. |

## The one-line answers

- *"Why not Health Cloud?"* — right model, paid SKU; the free build stays core-platform and says so.
- *"Why is any vitals data in CRM at all?"* — only events a human or agent acts on; the time series lives in DynamoDB, the analytical copy in Data Cloud.
- *"Why custom metadata instead of custom settings?"* — deployable through the pipeline, versioned in git.
