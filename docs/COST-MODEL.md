# Cost Model: One-Time, Per Device, Per Internal User, Per Customer

All prices are **2026 public list prices**, no negotiated discounts. Salesforce/AWS list in USD; CAD conversions use ≈1.37 and are estimates — Salesforce's official CAD price sheet differs slightly. Assumption set for the recurring numbers: telemetry every 30 s (2,880 msgs/day), one device per patient, B2C on **Person Accounts** (a free Enterprise-Edition feature — customers never need licenses; only internal users do).

## 1. One-time hardware (CAD, retail single units)

| Item | Patient monitor | Queue indicator |
|---|---|---|
| ESP32 DevKit V1 | $12 | $12 |
| DHT11 sensor | $5 | — |
| SG90 servo (FS90R continuous: +$4) | $5 | $5 |
| Breadboard + jumpers + USB | $15 | shared |
| **Total per device** | **≈ $37** | **≈ $17** |

Bulk (AliExpress, 100+): roughly half. Dev/demo software cost is $0 — Developer Edition orgs and the AWS free tier cover the entire build phase.

## 2. AWS — per device per month (USD, us-east-1/west-2)

86,400 readings a month per device. Boards send them through IoT Basic Ingest, and the pipeline handles them in batches of 1,000 (Prod settings), so most lines are now per batch rather than per reading. [SCALING.md](SCALING.md) has the same model for a million devices, with a simulation behind it.

| Line | Math | $/mo |
|---|---|---|
| IoT Core messages | Basic Ingest: not billed as messaging (2.0.x firmware: 86,400 × $1.00/M = 0.086) | 0.000 |
| IoT connectivity | 43,200 min × $0.08/M | 0.003 |
| Rules engine (rule + action) | 172,800 × $0.15/M | 0.026 |
| SQS telemetry queue (send, receive, delete) | ~103,700 requests × $0.40/M | 0.041 |
| DynamoDB on-demand: one STATE read per reading | 43,200 read units × $0.125/M; writes only on a change | 0.005 |
| Lambda (86 batch invocations × ~300 ms × 1 GB) | compute + requests | 0.0004 |
| S3 archive (its share of 86 objects; ~4 MB a month gzipped) | requests + storage | 0.0005 |
| **Per patient device** | | **≈ $0.077 (≈ $0.11 CAD)** |

Watching a board live adds to this only while its card is open: a reading every 2 s from the board and one delivery per open card, about $0.0036 an hour for one card, so about 3 cents for a working day. Its connection status costs well under a cent a month. [LIVE-STATUS.md](LIVE-STATUS.md) has the breakdown.

The app's Home page reads this month's AWS spend each time it loads: one API Gateway request and one Lambda run, under a cent a month per account at 100 loads a day. The figures come from an AWS budget, which AWS lists no charge for reading. An account with no budget shows none, unless SpendCostExplorer is turned on: Cost Explorer at $0.01 a read, kept for a day, about $0.31 to $0.40 a month. [SPEND-AND-LIMITS.md](SPEND-AND-LIMITS.md).

EventBridge is no longer on the per-reading path, and Prod keeps readings in S3 rather than writing each one to DynamoDB, which together were $0.19 of the old $0.35.

Queue-indicator device (commands only): < $0.01/mo. **Per AWS account**: the account and Organizations are free; the only fixed baseline is CloudWatch logs/alarms, ~$1–5/account/mo at this scale. Bedrock Titan v2 embeddings are noise: 1,000 patients × ~500-token daily summary ≈ 15M tokens/mo ≈ **$0.30 total**.

## 3. Salesforce — per internal user per month

| Item | USD list | ≈ CAD |
|---|---|---|
| Enterprise Edition | $175/user/mo | ~$240 |
| Agentforce employee access (optional) | +$5/user/mo (draws Flex Credits) or $125 flat unmetered | ~$7 / ~$171 |
| **Included free (Foundations, EE+)** | 200k Flex Credits + 250k Data Cloud credits/yr | $0 |

## 4. Per customer (Person Account) per month

| Line | Basis | $/customer/mo (USD) |
|---|---|---|
| License | Person Accounts are free on EE+ | 0 |
| Data Cloud, credit model | Salesforce-data ingestion now free; identity resolution 100k credits/M rows → 0.1 credit ≈ $0.0005/run; queries/segments | ~0.01–0.05 |
| Data Cloud, profile SKU (alternative) | $240–420 per 1,000 profiles | 0.24–0.42 |
| Agentforce | $2/conversation flat, or $0.10/action (assume 1 conv or ~5 actions) | 0.50–2.00 |
| AWS (from §2) | device telemetry pipeline | 0.08 |
| **Total per B2C customer + device** | | **≈ $0.60–2.50 (≈ $0.82–3.43 CAD)** |

**The driver is Agentforce usage, not data or infrastructure** — hardware amortized over 24 mo adds ~$0.06/mo; AWS is about $0.08; everything else is cents. Design effort should go into how often agents fire, not into shaving Lambda costs.

## 5. Worked examples (monthly, CAD ≈)

| Scenario | Internal users | Customers+devices | Salesforce | Agentforce | Data Cloud | AWS | **Total/mo** |
|---|---|---|---|---|---|---|---|
| Pilot | 2 × EE | 100 | $480 | ~$0 (Foundations credits cover it) | ~$0 (free tier) | ~$5 | **≈ $485** |
| Production | 10 × EE | 10,000 | $2,400 | ~$6,850 (1 conv/customer) | ~$700 (credit model) | ~$1,100 + $10 base | **≈ $11,060** |

Pilot note: 100 customers × 1 conversation ≈ 2,000 flex credits-equivalent — the free Foundations allocation absorbs the entire pilot year. That is a deliberate Salesforce on-ramp and worth saying out loud in content.

## 6. Can the whole build run free? (Nearly — with four traps)

**Salesforce:** Developer Edition is free forever and since 2025 ships with Agentforce + Data Cloud (limited credits) and free hosted MCP servers. Person Accounts can be enabled in a dev org. Two dev orgs = free "Dev" and "Prod". Watch the small limits: **~5 MB data storage** and 15k API calls/day — so do NOT write every 30-second reading to `Patient_Vitals__c` in a dev org (that is < 1 day of storage). Keep raw telemetry in DynamoDB (the architecture already does) and send Salesforce only alerts + daily summaries.

**AWS:** the 2025+ free plan gives $100 on sign-up, up to $200 with activity credits. Our whole pipeline costs < $1/mo, so credits are ample. The traps:
1. **The free plan is for new AWS customers only.** Anyone who has, or ever had, an AWS account is ineligible, so only your first account gets it. Run `iot-dev` on the free plan and `iot-prod` as a standalone paid account with an AWS Budget alert. At under $1 a month, Prod costs next to nothing.
2. **Joining an AWS Organization upgrades a free-plan account to paid** and stops it earning activity credits. So keep both accounts standalone during the build and form the Organization later, as a paid step — which is exactly the capstone migration story (chapter 12), now with a real billing reason to exist.
3. **Free-plan accounts auto-close at 6 months** (or when credits run out), with a 90-day recovery window. The sprint calendar finishes well inside that.
4. Some services are excluded from the free plan; everything this repo uses (IoT Core, Lambda, DynamoDB, EventBridge, SQS, API Gateway, CloudWatch, Bedrock invocation) is available.

**Want a hard cap while you learn?** A budget alert only tells you; it stops nothing. An AWS project on the paid plan takes a monthly spend limit from $20, and at the limit AWS pauses the project instead of billing more. Mirror it in a budget named cloud-agentic-iot-monthly and the app's Home page shows the month's spend against it. Projects can't use GitHub OIDC, so deploy to one from your laptop and move to regular accounts when you want the pipelines: [TRY-IT.md](TRY-IT.md).

**MuleSoft (chapter 07):** the one thing with no free tier — Anypoint is a **30-day trial**. Build, record, and publish that chapter inside one window.

**Slack (chapter 04):** a free workspace supports slash commands. Free. Each `/patient-status` costs two Lambda runs and one DynamoDB query on AWS (well under a thousandth of a cent) and one Salesforce API call for the last saved event; the live reading never touches Salesforce's daily API limit.

## 7. Patient portal: React site, Enhanced Chat and Agentforce Voice

The patient portal ([PATIENT-PORTAL.md](PATIENT-PORTAL.md)) changes §4 in one
way: each patient who signs in needs an Experience Cloud user licence. The
Person Account itself is still free. The React site, the Experience Cloud site
and the Messaging channel add no fixed fee. Each chat costs agent actions,
and each spoken minute costs voice minutes.

| Line | Basis (USD list) | $/patient/mo |
| --- | --- | --- |
| Portal licence, by member | Salesforce's self-service price page lists a portal member at **$10 per member per month**, with unlimited sessions | 10.00 |
| Portal licence, by login (alternative) | **$4 per login**, a 24-hour session: cheaper below 2.5 logins a month | 4.00 per login |
| Agent actions | 20 Flex Credits per action (Flex Credits Rate Card, Apr 21 2026) ≈ $0.10. Assume 3 chats × 3 actions (Get My Devices, sometimes Request a Nurse) | 0.90 |
| Agentforce Voice | 60 Flex Credits per minute (Voice Minutes rate card, Feb 3 2026) ≈ $0.30. Assume 2 spoken minutes. Where voice minutes apply, they replace the per-voice-action rate (30 credits) | 0.60 |
| Enhanced Chat (Messaging for In-App and Web) | Counted in the agent's usage here. No separate per-message line on the rate cards read | 0 |
| **Per signed-in patient** | member licence + typical use | **≈ $11.50 (≈ $15.75 CAD)** |

The Flex Credit price is the one §3 and §4 already use: $0.10 per 20-credit
action, which is $0.005 a credit. The rate cards give credits, not dollars.

**The licence dominates.** For a patient who signs in once or twice a month,
choose login-based licences ($4 to $8). For a patient on the ward who checks
daily, choose member licences ($10). The agent is about $1.50 a patient
whichever licence you choose, and only voice-heavy use changes that: 10 spoken
minutes add $3.

**Customer Community vs Customer Community Plus.** A patient sees only their
own account, so the portal needs no roles or sharing rules, and Customer
Community is enough. Customer Community Plus costs more and adds nothing the
portal uses. Check current Customer Community prices with your account
executive: the public page now lists the portal tiers under new names.

**Worked example (monthly):** 1,000 patients on member licences, each with
3 chats and 2 voice minutes: $10,000 in licences + $900 in actions + $600 in
voice ≈ **$11,500 (≈ $15,750 CAD)**. On login licences at 2 logins each:
$8,000 + $1,500 ≈ $9,500.

**In test-cloudarchitect101 it costs nothing:** a Developer Edition comes with
a few Experience Cloud licences and an Agentforce allowance. Watch the
allowance. **Voice does not work there:** on Nov 10 the org answered "Voice
modality cannot be used. Organization does not have access to Voice
features." Agentforce Voice needs a paid org with the Agentforce Voice
entitlement, so a Developer Edition demo is text chat only.

## 8. Espressif MCP servers for the agents

Anyone asks an agent a generic ESP32 question, answered through Espressif's
open MCP servers ([GUARDRAILS-AND-MCP.md](GUARDRAILS-AND-MCP.md#espressif-mcp-servers-for-the-agents)).

| Item | Rate | Per question (USD) |
|---|---|---|
| ESP Pilot, ESP Component Registry | Free, no sign-in, no published limit | 0 |
| MCP tool actions | 20 Flex Credits each, like any agent action (Flex Credits Rate Card, Apr 21 2026); usually one a question, two when a component needs its details | 0.10 to 0.20 |
| AWS | None: Salesforce calls Espressif directly | 0 |

About **$0.15 a question**. 10 staff asking 5 hardware questions a working
day plus 200 patient questions a month is about 3,500 questions a year, or
**≈ $525 a year** of Flex Credits, inside the 200k credits (≈ 10,000 actions)
Foundations includes. In test-cloudarchitect101 it uses the Developer
Edition's allowance.

## 9. Device history for the staff agent (Get Device History)

The Patient Care Agent's history action ([DATA-CLOUD.md, How the agent reads it](DATA-CLOUD.md#how-the-agent-reads-it))
adds no AWS cost and no fixed fee. Each answer is one agent action, 20 Flex
Credits (about $0.10), plus Data Cloud query credits for at most about 2,900
raw rows and 30 daily rows; read the real figure off the org's consumption
page after the first week.

| Scenario | History questions a month | Flex Credits | About (USD) |
| --- | --- | --- | --- |
| Test org or pilot: 2 nurses, 5 a day, 22 days | 220 | 4,400 | $22, inside the 200k Foundations credits a year |
| Production: 10 nurses, 10 a day, 22 days | 2,200 | 44,000 | $220 |

The cost follows questions asked, not devices or readings. Embedding every
reading for a search index instead would grow with the fleet: 2,880 rows a
device a day, about 8.6 million a month for 100 devices.

## Sources (checked 2026-07; §7 on 2026-11-09, §8 on 2026-11-19, §9 on 2026-11-27)

- [Agentforce flexible pricing (Salesforce)](https://www.salesforce.com/news/press-releases/2025/05/15/agentforce-flexible-pricing-news/), [Flex credits guide](https://www.jitendrazaa.com/blog/salesforce/salesforce-agentforce-credits-cost-model-complete-guide-2026/), [2026 tiers](https://ekfrazo.com/resources/blogs/salesforce-agentforce-pricing-2026/)
- [Data Cloud pricing changes (Salesforce Ben)](https://www.salesforceben.com/new-pricing-for-salesforce-data-cloud-is-here-what-you-need-to-know/), [credit consumption](https://davidpalencia.com/salesforce-data-cloud-pricing-credit-consumption/)
- [AWS IoT Core pricing](https://aws.amazon.com/iot-core/pricing/)
- [Salesforce editions 2026](https://tech.co/crm-software/salesforce-pricing-how-much-does-salesforce-cost)
- [AWS Free Tier $200/6-month plan](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/), [Free Tier FAQs (new customers only)](https://aws.amazon.com/free/free-tier-faqs/), [Free account plan (joining an Organization upgrades to paid)](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [Project spend limits (AWS News Blog)](https://aws.amazon.com/blogs/aws/aws-reimagines-the-getting-started-experience/)
- §7: [Flex Credits Rate Card, Apr 21 2026](https://www.salesforce.com/en-us/wp-content/uploads/sites/4/assets/pdf/agentforce/Flex-Credits-Rate-Card-04.21.2026.pdf), [Agentforce Voice Minutes rate card, Feb 3 2026](https://www.salesforce.com/en-us/wp-content/uploads/sites/4/assets/pdf/agentforce/Agentforce-Voice-Minutes-Supplemental-Rate-Card-02.03.2026.pdf), [self-service portal pricing](https://www.salesforce.com/in/service/customer-self-service/pricing/), [Enhanced Chat v2](https://help.salesforce.com/s/articleView?id=service.enhanced_chat_v2_intro.htm&language=en_US&type=5)

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
