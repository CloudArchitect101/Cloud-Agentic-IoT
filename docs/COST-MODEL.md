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

| Line | Math | $/mo |
|---|---|---|
| IoT Core messages | 86,400 × $1.00/M | 0.086 |
| IoT connectivity | $0.042/device/**year** | 0.004 |
| Rules engine (rule + action) | 172,800 × $0.15/M | 0.026 |
| Lambda (86k invokes ×100 ms ×128 MB) | compute + requests | 0.035 |
| DynamoDB on-demand writes | 86,400 × $1.25/M | 0.108 |
| EventBridge custom events | 86,400 × $1.00/M | 0.086 |
| **Per patient device** | | **≈ $0.35 (≈ $0.48 CAD)** |

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
| AWS (from §2) | device telemetry pipeline | 0.35 |
| **Total per B2C customer + device** | | **≈ $0.90–2.80 (≈ $1.25–3.85 CAD)** |

**The driver is Agentforce usage, not data or infrastructure** — hardware amortized over 24 mo adds ~$0.06/mo; AWS is $0.35; everything else is cents. Design effort should go into how often agents fire, not into shaving Lambda costs.

## 5. Worked examples (monthly, CAD ≈)

| Scenario | Internal users | Customers+devices | Salesforce | Agentforce | Data Cloud | AWS | **Total/mo** |
|---|---|---|---|---|---|---|---|
| Pilot | 2 × EE | 100 | $480 | ~$0 (Foundations credits cover it) | ~$0 (free tier) | ~$5 | **≈ $485** |
| Production | 10 × EE | 10,000 | $2,400 | ~$6,850 (1 conv/customer) | ~$700 (credit model) | ~$4,800 + $10 base | **≈ $14,760** |

Pilot note: 100 customers × 1 conversation ≈ 2,000 flex credits-equivalent — the free Foundations allocation absorbs the entire pilot year. That is a deliberate Salesforce on-ramp and worth saying out loud in content.

## 6. Can the whole build run free? (Yes — with three traps)

**Salesforce:** Developer Edition is free forever and since 2025 ships with Agentforce + Data Cloud (limited credits) and free hosted MCP servers. Person Accounts can be enabled in a dev org. Two dev orgs = free "Dev" and "Prod". Watch the small limits: **~5 MB data storage** and 15k API calls/day — so do NOT write every 30-second reading to `Patient_Vitals__c` in a dev org (that is < 1 day of storage). Keep raw telemetry in DynamoDB (the architecture already does) and send Salesforce only alerts + daily summaries.

**AWS:** the 2025+ free plan gives $100 on sign-up, up to $200 with activity credits. Our whole pipeline costs < $1/mo, so credits are ample. The traps:
1. **Joining an AWS Organization voids the credits instantly** and force-upgrades the account to paid. So during the free phase, run `iot-dev` and `iot-prod` as two *standalone* free-plan accounts. Form the Organization later, as a paid step — which is exactly the capstone migration story (chapter 12), now with a real billing reason to exist.
2. **Free-plan accounts auto-close at 6 months** (or when credits run out), with a 90-day recovery window. The sprint calendar finishes well inside that.
3. Some services are excluded from the free plan; everything this repo uses (IoT Core, Lambda, DynamoDB, EventBridge, SQS, API Gateway, CloudWatch, Bedrock invocation) is available.

**MuleSoft (chapter 07):** the one thing with no free tier — Anypoint is a **30-day trial**. Build, record, and publish that chapter inside one window.

**Slack (chapter 04):** a free workspace supports slash commands. Free.

## Sources (checked 2026-07)

- [Agentforce flexible pricing (Salesforce)](https://www.salesforce.com/news/press-releases/2025/05/15/agentforce-flexible-pricing-news/), [Flex credits guide](https://www.jitendrazaa.com/blog/salesforce/salesforce-agentforce-credits-cost-model-complete-guide-2026/), [2026 tiers](https://ekfrazo.com/resources/blogs/salesforce-agentforce-pricing-2026/)
- [Data Cloud pricing changes (Salesforce Ben)](https://www.salesforceben.com/new-pricing-for-salesforce-data-cloud-is-here-what-you-need-to-know/), [credit consumption](https://davidpalencia.com/salesforce-data-cloud-pricing-credit-consumption/)
- [AWS IoT Core pricing](https://aws.amazon.com/iot-core/pricing/)
- [Salesforce editions 2026](https://tech.co/crm-software/salesforce-pricing-how-much-does-salesforce-cost)
- [AWS Free Tier $200/6-month plan](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/), [Free Tier FAQs (Organizations voids credits)](https://aws.amazon.com/free/free-tier-faqs/)
