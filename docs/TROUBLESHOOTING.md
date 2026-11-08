# Troubleshooting: what broke while building this, and why

Every real problem hit while wiring this project end to end: the exact
symptom, the root cause, the fix, and what stops it coming back. Most of
them are in no single vendor doc, because they sit where two platforms meet
(AWS and Salesforce, the board and AWS IoT, the agent and its permissions).

**Rule:** a new problem gets a row here in the same commit as its fix.

The step-by-step "if a step fails" tables stay next to their feature:
[SOP-GROUNDING.md](SOP-GROUNDING.md#if-a-step-fails) and
[DATA-CLOUD.md](DATA-CLOUD.md#if-a-step-fails).

## Salesforce to AWS: identity and permissions

| When | Symptom | Root cause | Fix | What prevents it now |
| --- | --- | --- | --- | --- |
| Nov 5 | Every callout from Salesforce to API Gateway returned `403 {"message":"Forbidden"}` after the first one succeeded | The `AWS_IoT_Relay` External Credential kept using an expired STS session; CloudTrail showed no new `AssumeRole`. API Gateway answers an expired session with `403`, and the credential refreshed only on `401` | Add `403` to the credential's Additional Status Codes for Token Refresh (`b49aded`, `0bdf346`) | SETUP.md checklist step 13 |
| Nov 5 | Provisioning failed: `not authorized to perform: iot:AttachThingPrincipal on resource …:cert/…` | The lifecycle role allowed the attach on `thing/*` only; the action is also authorized against the certificate | Allow it on `cert/*` too in the queue-relay template (`e9ba2fb`) | A test that checks the role's rights |
| Nov 5 | AWS provisioned the device, but its Asset stayed "Not Provisioned" | The pre-signed bundle link is longer than the 255 characters a `Url` field holds, and the `Database.update(allOrNone=false)` error was only logged | A Long Text field, and a failed save now marks the record (`7b5b885`) | Save failures are visible on the record |
| Nov 7 | Room-rule doses failed: `We couldn't access the credential(s)` | The integration user that AWS writes readings as lacked `AWS_IoT_Relay_Callers` | The Salesforce deploy assigns it (`3bac33b`) | `deploy-salesforce.sh` |
| Nov 7 | Then: `You don't have read permissions on the User External Credential object`; manual commands worked, automatic ones did not | A Named Credential callout needs principal access *and* Read on `UserExternalCredential`. The admin had both | `Device_Integration` grants that Read (`21e2670`) | Permission set metadata |

## Salesforce metadata and Apex

| When | Symptom | Root cause | Fix | What prevents it now |
| --- | --- | --- | --- | --- |
| Nov 7 | Validate rejected two permission sets | A permission set description may be at most 255 characters | Shorter descriptions (`a276c67`) | A test checks every permission set's description |
| Nov 7 | Validate rejected the BotVersion | `staticPromptsEnabled` is not valid at API 64.0 | Removed | A metadata test |
| Nov 7 | 8 Apex tests failed with `Invalid id: 00101026` | An Apex ternary takes the type of its first branch, so a Case number was cast to an Id. Every real agent escalation would have crashed | `String.valueOf` on both branches (`fd94dd5`) | The agent action's tests |
| Nov 7 | A usage-card test failed in Developer Edition | Standard User has View Setup in Developer Edition | Query a profile that lacks it (`8139ba5`) | The test no longer assumes a profile |
| Nov 7 | 7 components failed: `Ambiguous method signature: newUser(NULL, Boolean)` | Overloads on `String` and `Id`; `null` matches both | Renamed the Id version (`eb35915`) | |
| Nov 7 | The deploy went on to AWS after a failed Salesforce validate | The script didn't stop on the validate's failure | It stops now | |
| Nov 8 | Validate failed on three permission sets: `Permission Read Account depends on permission(s): Read Contact` | Person Accounts were turned on in the org (Nov 7 19:47 UTC). Salesforce then added Read Contact to every permission set with Read Account, and the repo's copies without it tried to take it away | Read-only Contact in `Device_Integration`, `Device_Platform_Admin` and `Patient_Care_Agent` | The metadata now matches an org with or without Person Accounts. Also: a failed deploy between `sf agent deactivate` and `activate` leaves the agent off, so reactivate it |
| Nov 8 | Asked "Test8 reads 31 C, what do I do?", the agent asked what Test8 was instead of calling an action | Nothing in its instructions said that users name a device by its serial number, so a bare "Test8" looked ambiguous; it also tied the procedure search to a known device | The topic now says a device name the user gives is its serial number, to pass as written, and that Find Procedure needs no device | The topic instructions and the action description |
| Nov 8 | Then, with the procedure index unavailable, the same question got only "I cannot access the procedure details right now… consult the charge nurse", and Test8 was never read | The instruction put Find Procedure first and made the readings an add-on, so when the search failed the agent stopped there | The topic now says to always get a named device's readings and report them whatever Find Procedure returns, to say when procedures are unavailable, and to offer escalation | A metadata test on the instruction |
| Nov 8 | The validate stopped with `Error (MetadataTransferError): Metadata API request failed: fetch failed`, the progress showing `Failed: ✘` at 204/240 tests, and the deploy never ran | The laptop lost its connection while the CLI waited on an 11-minute test run. The validate itself went on in the org and passed every test; only the CLI's wait failed | `sf project deploy report --job-id <id>` shows the real result; run the deploy again | Check the report before reading a `fetch failed` as a test failure |
| Nov 7 | Room-rule Cases were owned by the AWS integration user | The org had no `Care_Team_Queue`, so the code fell back to the running user | The queue ships as metadata (`3bac33b`) | |
| Nov 7 | A Case undelete test expected a motor command that never came | After an undelete the queue may no longer own the Case | The test checks the owner (`829ca86`) | |
| Nov 8 | No board turned for Cases in Care_Team_Queue, whichever device they were on; only the Case's own device swept (its case alert) | `Device_Queue_Binding.Care_Team_Queue` named `ESP32-Patient-Monitor-01`, a Thing no board is. AWS IoT accepts a publish to a topic nobody listens on, so nothing failed anywhere | Boards with the Internal Device record type follow the queue; the binding names no board | `salesforce-metadata-limits.test.js` checks the shipped binding; `DeviceRolesTest` |
| Nov 8 | Found while building the ward board: an event for a queue with no bound board would have been refused | `Queue_Depth_Change__e.Device_Id__c` was required, from when each queue drove exactly one named board | Not required; the relay works out the boards | `DeviceRolesTest` publishes one |
| Nov 8 | Found in review: the indicator's count could be lower than the queue's | `CaseQueueMonitorService` ran with sharing, so it counted only the open Cases the user who saved one could see | Without sharing, as `CaseAlertService` already was: every open Case of the queue counts | |

## The board and the serial scripts

| When | Symptom | Root cause | Fix | What prevents it now |
| --- | --- | --- | --- | --- |
| Nov 6 | `provision-device.sh` printed nothing and stopped | Under `set -o pipefail`, `ls` with an unmatched glob exits 1 | A glob loop instead of `ls` | Shell tests and shellcheck |
| Nov 6 | The bundle was lost and the board came back in PROVISIONING MODE | Opening the serial port toggles DTR, which resets the ESP32, and the script wrote before the board had booted | Wait for the board's prompt, then send in paced pieces (`8eaca7f`) | A simulated-board test that loses a one-burst bundle |
| Nov 6 | `[Errno 16] Resource busy` while flashing or provisioning | An `arduino-cli monitor` still held the port | Close the monitor first | Documented in the board steps |
| Nov 6 | Every OTA try waited 15 minutes | The Thing Group held Things with no board behind them | Remove those Things from the group | |
| Nov 7 | The one-burst bundle test was flaky on macOS | Pseudo-terminal chunking differs between Linux and macOS | Made deterministic | |
| Nov 8 | A board without a DHT11 (a nurse-station board) would print `DHT read failed` every reading interval, forever | The sketch reported every failed read | From 2.4.0 it says so three times, then once that there is no sensor, then nothing (`SensorPresence.h`) | `servo_demand_test.cpp` |
| Nov 7 | The room rule didn't fire again after cooling | A new episode needs a reading *below* 29.0 °C, and the sensor bottomed at exactly 29.0. While hot, AWS re-reports every 15 minutes | By design; demo steps document it | Documented with the rule |

## AWS accounts

| When | Symptom | Root cause | Fix | What prevents it now |
| --- | --- | --- | --- | --- |
| Nov 4 | GitHub OIDC couldn't be set up in the spend-limited AWS project | AWS projects block IAM identity providers, and advanced features remove the spend limit for good | Laptop deploys for the project; pipelines use regular accounts | SETUP.md, TRY-IT.md |
| Nov 7 | Data Cloud's keyless S3 sign-in couldn't be used in that project | Same cause: it needs an IAM identity provider | A read-only IAM user, its key typed into Data Cloud only | DATA-CLOUD.md |
| Nov 7 | Bedrock: `ValidationException: Operation not allowed` for every model, with every IAM right in place | An account-level hold on new accounts: `get-foundation-model-availability` shows `authorizationStatus` `NOT_AUTHORIZED` while Region, entitlement and agreement are `AVAILABLE`. No IAM change lifts it, and no console page does either: the old Model access page is retired, and Bedrock AgentCore's Create Harness page hosts agents, it does not enable models | A free Support case under Account and billing (open). `SKIP_SOP_INDEX=yes` deploys everything else meanwhile | `index-sops.sh` names the hold when it hits it |
| Nov 5–7 | `aws` commands failed to sign in partway through work | The `aws login` session expired | `aws login --profile <profile>` | |

## Readings and Data Cloud

| When | Symptom | Root cause | Fix | What prevents it now |
| --- | --- | --- | --- | --- |
| Nov 8 | No `datacloud/room-readings/` folder in the archive bucket after the deploy | S3 has no folders: the prefix appears with the first CSV, which patient-vitals writes only when a board sends a reading. The boards had been offline since Nov 7 08:05 UTC | Power a board on; the prefix appears within a minute of its first reading | SETUP.md §7 step 1 says so |

## Limits found while designing

| When | Finding | What it changed |
| --- | --- | --- |
| Nov 8 | Salesforce wants an Account or a Contact on every Asset, and Person Accounts are off in this Developer Edition org | An Internal Device (a ward board) sits on the ward's own Account; its record type, not the Account, makes it internal |
| Nov 8 | A board refuses an OTA build named for another device type, and every board in the field runs `patient-monitor` | The one build for every board keeps that name; a new name would need a USB flash of every board |
| Nov 8 | AWS IoT allows a thing in only one group per hierarchy, and a job aimed at a group reaches its child groups | `internal-devices` sits inside `fleet-patient-monitor`, so fleet releases reach the ward boards; `ota.sh join ... internal` moves a board out of fleet and canary first |
| Nov 7 | Data Cloud's S3 connector reads only CSV or Parquet, and ignores subfolders | patient-vitals also writes a flat CSV copy beside the NDJSON archive |
| Nov 7 | Data Cloud metadata types are in the CLI registry, but Salesforce documents moving them only as a data kit retrieved from an org | The connection, stream and mapping are setup steps; the insights' SQL is code |
| Nov 7 | Agentforce's MCP client supports no auth or OAuth 2.0 client credentials, not AWS SigV4 | The IAM-authenticated MCP server serves SigV4 clients; Agentforce would need an OAuth front |
| Nov 7 | Salesforce callouts time out after 25 seconds | Guardrails run inside device-command as a shared module, not as an extra Lambda hop |

## Working on the Mac

| Symptom | Cause | Fix |
| --- | --- | --- |
| A pasted multi-line command kept running after one line failed | zsh runs every pasted line | Give commands as one `&&` chain |
| A trailing `#` comment broke a pasted command | Interactive comments are off in zsh by default | No trailing comments in commands |
