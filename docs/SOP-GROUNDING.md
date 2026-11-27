# Ward procedures: grounding the agent in SOPs

The Smart Ward use case: the care team asks the **Patient Care Agent** what a
room's monitor reports, and then the next question is always *"so what do I
do?"* This page covers how the agent answers that one from the ward's
standard operating procedures (SOPs), and cites them by ID, instead of from
whatever the model remembers.

> The SOPs in `knowledge/sops/` are **samples for the demo**: fictional, not
> clinical advice, and not any real organisation's policy. Each one says so.

## What the agent gets

A third action, **Find Procedure** (`genAiFunctions/Find_Procedure`, Apex
`ProcedureSearchAgentAction`). Given a question in the user's words, it
returns the best passages from the SOPs, best first, each headed by what to
cite:

```
[SOP-WARD-001 v2.0, High temperature alert, section "Steps"]
1. Take the Case from Care_Team_Queue so the team can see someone has it.
2. Go to what the device monitors within 10 minutes: the person wearing the
   sensor, the fridge, or the room. ...
```

plus `Citations` (`SOP-WARD-001 v2.0`), the top SOP's ID and title, and the
sample notice. The topic's new instruction, **Cite the ward procedure**,
tells the agent to call Find Procedure whenever the user asks what to do,
to give steps only from the passages it returns, to cite each by SOP ID and
version ("per SOP-WARD-001 v2.0"), and to say that no ward procedure covers
it when no passage comes back. The planner, the bot's role and its welcome
message say the same.

A conversation then goes:

> **Nurse:** PM-0042 is reading 31 degrees, what do I do?
> **Agent:** *(Get Latest Device Readings, then Find Procedure)* PM-0042's
> latest reading is 31.2 C at 14:05 UTC, at or above the 30.0 C threshold.
> Per SOP-WARD-001 v2.0: take the Case from Care_Team_Queue, go to what the
> device monitors within 10 minutes and recheck the temperature with a
> suitable instrument, ... If the recheck confirms it, tell the person in
> charge (SOP-WARD-006 v1.3 for escalation).
>
> **Nurse:** Is that new, or has it been running hot all week?
> **Agent:** *(Get Device History)* From Data Cloud: PM-0042 read at or
> above 30.0 C on 2 of the last 7 days, about 45 minutes in all, highest
> 33.0 C; in the last 24 hours, about 10 minutes. The newest hour or two may
> not be in Data Cloud yet.

The second answer comes from the device's history
([DATA-CLOUD.md, How the agent reads it](DATA-CLOUD.md#how-the-agent-reads-it)),
and an escalation carries that summary in its reason.

## The procedures

| ID | Title | Owner role |
|---|---|---|
| SOP-WARD-001 | High temperature alert (the 30.0 C rule, wherever the sensor sits: a Case at 30.0 C or higher, the episode ends below 29.0 C, re-reported at most every 15 minutes) | Ward charge nurse |
| SOP-WARD-002 | Medication storage humidity out of range (30 to 60 %; the system records humidity but opens no Case for it) | Pharmacy lead |
| SOP-WARD-003 | Room monitor offline | Clinical engineering |
| SOP-WARD-004 | Alert motor not turning or not stopping (replaced the dispenser procedure on Nov 10) | Clinical engineering |
| SOP-WARD-005 | Case alert motor acknowledgement | Ward charge nurse |
| SOP-WARD-006 | Escalation and shift handover | Nurse unit manager |
| SOP-WARD-007 | Using the Patient Care Agent | Nurse unit manager |

Each file is markdown with front matter, then `## ` sections:

```markdown
---
id: SOP-WARD-001
title: High temperature alert
version: 2.0
owner: Ward charge nurse
reviewed: 2026-11-10
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice, ...

## When this applies
...
## Steps
1. ...
```

Each `## ` section is one passage the agent may quote. The notice before the
first heading is not a passage: it is the same in every SOP, so it would
match every question. `test/lambda/sop-index.test.js` checks every SOP: it
reads, its ID is its own and starts its file name, it carries the notice,
nothing in it looks like personal data, every SOP it refers to exists, and
SOP-WARD-001's 30.0, 29.0 and 15 are the numbers `config/Dev.json` and the
patient-vitals function run the rule with. Change the rule and that test
fails until the SOP says the same.

**To change one:** edit the file, raise its `version`, commit, and run
`scripts/deploy-aws.sh Dev` (or `scripts/index-sops.sh Dev` for an SOP-only
change). **To add one:** a new file, `SOP-<AREA>-<nnn>-<words>.md`, with
the five front-matter fields. **To remove one:** delete the file; the next
index no longer has it.

## The path

```
knowledge/sops/*.md ── scripts/index-sops.sh (run by deploy-aws.sh) ──> knowledge-indexer
                                                                          │  Titan Text Embeddings V2, per section
                                                                          v
                                                             S3  sops/index.json  (one object)
                                                                          ^
Patient Care Agent ─ Find Procedure ─> ProcedureSearchAgentAction         │ GetObject, kept 5 min
          │                              │ Named Credential AWS_IoT_Relay (SigV4)
          │                              v                                │
          │                API Gateway  POST /find-procedure  ──> procedure-search
          │                                                         mask the question, embed it,
          │                                                         cosine over every passage,
          │                                                         mask the passages
          v
   "Per SOP-WARD-001 v2.0: ..."
```

- **Indexing is a deploy step.** `scripts/deploy-aws.sh` ends by running
  `scripts/index-sops.sh`, which reads every SOP with the same rules the
  indexer uses (a bad file fails before any AWS call), waits for the
  indexer's new code to be live, and sends all of `knowledge/sops` in one
  invoke. The indexer hashes the files, the model and the size; when that
  matches the index in S3 it embeds nothing and writes nothing, so a deploy
  that changed no SOP costs one S3 read. Otherwise it embeds every section
  and replaces the index whole, so a removed SOP leaves the index, and a
  reader never sees half of a new one. `--force` rebuilds it anyway.
- **Retrieval is one Bedrock call.** procedure-search reads the index once
  and keeps it for `IndexCacheSeconds` (300), embeds the question with the
  model and size the index records, and ranks every passage by cosine
  similarity. A question that names an SOP ID (`what does SOP-WARD-003
  say`) gets that SOP's passages first. A passage below `MinScore` (0.25)
  is left out, so a question no SOP covers gets no passage instead of the
  least bad one, and the agent says so.
- **The section is the chunk.** SOP sections are short (the longest is
  under 1,000 characters), so each is one passage, embedded as `ID title`,
  the section heading and its text: "go to the room within 10 minutes"
  means nothing without the procedure it belongs to. A section over 1,200
  characters goes through chapter 08's sentence-aware chunker and keeps its
  heading on every piece.

## Guardrails on the way

Reusing `lambda/shared/guardrails.js`, the same module the MCP server and
device-command use ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md)):

| Where | What |
|---|---|
| The question | `maskPii` before it is embedded, so a name, email or number typed into it never reaches the model. `checkInput` as a tripwire: a hit is logged with its signal and the answer says `inputFlagged`; the question is still answered. The question is never logged. |
| Each passage | `maskPii` on its way out, then `checkOutput`: a passage that still carries what an answer must never carry (a private key, an access key) is dropped and counted as `blocked`. |
| In Salesforce | `PiiMaskingService.mask` on every passage again, so nothing depends on one side alone. The action reads no record and writes none. |
| Who may ask | The route is `AWS_IAM`, signed by the `AWS_IoT_Relay` Named Credential, as the person talking to the agent: they need `Patient_Care_Agent` (which opens the class) and `AWS_IoT_Relay_Callers` (which lets their callout sign). |

The SOPs themselves should hold no personal data, and a test fails if one
does, so masking a passage is a second line, not the first.

## Why this design

The org is a Developer Edition with Data Cloud and Agentforce on; the AWS
side is a spend-limited project in us-east-2, where Bedrock offers Titan
Text Embeddings V2. The options:

| Option | Code or clicks | Running cost | Why not, or not yet |
|---|---|---|---|
| **a. This: Bedrock embeddings, one S3 object, cosine in the Lambda, an Apex action through `AWS_IoT_Relay`** | All code: two functions, one stack, one script, one Apex class, deployed by the existing scripts | Under a cent a month for a demo ward | The chosen one. For seven SOPs and 24 passages, one GetObject and 24 dot products are faster than a call to any vector store, and nothing runs while nobody asks. The deploy and project policies already allow every service it uses. |
| b. Agentforce Data Library (Data Cloud vector search index and retriever) | Mostly clicks: upload files or point at Knowledge, Setup builds the data stream, search index and retriever. The library is not yet something this repo can deploy as metadata | Data Cloud credits for unstructured ingestion and vector search, from the org's allowance | Not reproducible from the repo, and the index, chunking and retriever are not code anyone can review or test. Worth it for an org with hundreds of documents and Data Cloud credits to spend. |
| c. Salesforce Knowledge articles | Clicks to turn Knowledge on and set up article types; articles are data, not metadata | Knowledge user licences in a real org | The agent's built-in knowledge answers go through the Data Library (b) anyway, so this adds article management on top of b. The right home for SOPs once a ward edits them in Salesforce rather than in git. |
| d. Amazon Bedrock Knowledge Bases | Code (CloudFormation) | The knowledge base is free, but it needs a vector store: OpenSearch Serverless bills its minimum capacity around the clock; S3 Vectors does not | More moving parts for the same result at this size, and its vector store needs rights (`aoss:*`, `s3vectors:*`) neither deploy policy grants. |
| e. S3 Vectors, or DynamoDB with in-Lambda cosine | Code | Pennies | S3 Vectors is the upgrade path when the corpus grows past a few thousand passages (its CloudFormation types exist in us-east-2 and ca-central-1), at the cost of a new SDK client and `s3vectors:*` in both deploy policies. DynamoDB would only spread one small object over many items. |

Moving to S3 Vectors later changes procedure-search's `loadIndex` and
`rank` and the indexer's write; the Apex action, the route, the SOP files
and the script stay as they are.

## What it costs

At on-demand list prices for us-east-2 at the time of writing (confirm on
the Bedrock, Lambda, API Gateway and S3 pricing pages before relying on them):

| Part | Price | A demo month (a few hundred questions, ten deploys) | 10,000 questions |
|---|---|---|---|
| Titan Text Embeddings V2 | $0.00002 per 1,000 input tokens | Indexing about 4,000 tokens per changed deploy, questions about 30 tokens each: under $0.001 | about $0.007 |
| Lambda (256 MB, about 0.3 s a question) | $0.0000167 per GB-second, $0.20 per million requests | well inside the free tier | about $0.015 |
| API Gateway HTTP API | $1.00 per million requests | under $0.001 | $0.01 |
| S3 (one object of about 200 KB, 30 days of old versions) | $0.023 per GB-month, $0.0004 per 1,000 GETs | under $0.001 | under $0.002 |
| CloudWatch Logs | $0.50 per GB ingested, kept `lambdaLogRetentionDays` | a few KB | under $0.01 |

So **under one cent a month** for the demo, and about **four cents at
10,000 questions**. Nothing is provisioned: no cluster, no index service,
no schedule. A month nobody asks costs the S3 storage, a fraction of a
cent. In Salesforce, each question is one callout of the org's allowance
and no Data Cloud credits.

## Check each step

1. **The index is there.** After a deploy, `deploy-aws.sh` prints
   `indexed: 7 SOP(s), 24 passage(s)` (or `unchanged:`). On its own:

   ```bash
   scripts/index-sops.sh Dev
   ```
2. **The search answers.** Invoke the function as API Gateway would:

   ```bash
   aws lambda invoke --function-name cloud-agentic-iot-procedure-search --cli-binary-format raw-in-base64-out \
     --payload '{"body":"{\"query\":\"the sensor reads 31 degrees\",\"maxResults\":2}"}' /dev/stdout
   ```

   Expect `statusCode` 200 and `SOP-WARD-001` first.
3. **Salesforce reaches it.** As a user with `Patient_Care_Agent` and
   `AWS_IoT_Relay_Callers`, Developer Console → Execute Anonymous:

   ```apex
   ProcedureSearchAgentAction.ProcedureRequest r = new ProcedureSearchAgentAction.ProcedureRequest();
   r.question = 'the sensor reads 31 degrees';
   System.debug(ProcedureSearchAgentAction.findProcedure(new List<ProcedureSearchAgentAction.ProcedureRequest>{ r })[0]);
   ```
4. **The agent cites it.** Ask the agent what to do about a sensor at 31 C,
   and check the answer names `SOP-WARD-001 v2.0`. Ask about something no
   SOP covers ("the lift is broken") and check it says no ward procedure
   covers it.

## If a step fails

| What you see | Usually | Do |
|---|---|---|
| `index-sops.sh`: *An SOP in knowledge/sops is not ready to index* | A missing front-matter field, a bad ID or version, two files with one ID | Fix the file it names |
| `index-sops.sh`: *... is not in this account* | The knowledge-indexer stack is not deployed yet | `scripts/deploy-aws.sh Dev` |
| `index-sops.sh`: *AWS has not authorized this account for Amazon Bedrock*, or Bedrock answers `ValidationException: Operation not allowed` | An account-level hold, common on new accounts: `aws bedrock get-foundation-model-availability --model-id amazon.titan-embed-text-v2:0` shows `authorizationStatus` `NOT_AUTHORIZED` while Region, entitlement and agreement are `AVAILABLE`. No IAM change lifts it | Finish any account verification or payment-method notice in Billing, then open a free Support case under **Account and billing → Account** (not Technical) asking AWS to enable Bedrock for Titan Text Embeddings V2 in that Region. Meanwhile `SKIP_SOP_INDEX=yes scripts/deploy-aws.sh <Env>` deploys everything but the index. Once it is lifted, run `scripts/index-sops.sh <Env>`. Everything else deploys and works meanwhile; Find Procedure has no index until then |
| `index-sops.sh`: *failed (above)* naming Bedrock or `AccessDeniedException` | Titan Text Embeddings V2 not available to the account in its Region | Check the model in the Bedrock console for that Region; the role allows only `amazon.titan-embed-text-v2:0` there |
| Find Procedure: *No ward procedures are indexed yet* | `no-index`: the indexer has not run in this account | `scripts/index-sops.sh Dev` |
| Find Procedure: *could not reach the procedure search ... AWS_IoT_Relay_Callers* | The user cannot use the external credential | Assign them `AWS_IoT_Relay_Callers` (INSTALL-GUIDE.md, Stage 2 part d) |
| Find Procedure: *no find-procedure route yet* | The queue-relay stack predates this change | `scripts/deploy-aws.sh Dev` |
| The agent answers steps without a citation | The deployed topic predates the instruction, or the agent was not reactivated | Deploy Salesforce, then deactivate and activate the agent ([SETUP.md §8](SETUP.md#8-ward-procedures-for-the-agent)) |

**Key files:** `knowledge/sops/`, `lambda/shared/sop-index.js`,
`lambda/knowledge-indexer/` (index.js, cloudformation.yaml),
`lambda/procedure-search/index.js`, `scripts/index-sops.sh`,
`classes/ProcedureSearchAgentAction.cls`,
`genAiFunctions/Find_Procedure/`, and the tests
`test/lambda/sop-index.test.js`, `test/lambda/knowledge-indexer.test.js`,
`test/lambda/procedure-search.test.js`,
`classes/ProcedureSearchAgentActionTest.cls`.

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
