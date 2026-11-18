# Spend and limits

The Cloud Agentic IoT app's Home page is one card, **Usage and limits**: this
month's AWS spend against its limit, and how much of Salesforce's limits the
org has used. It reads everything once, each time the page loads, and never in
between: no polling, no timers. It is for admins only: a user needs the
`Platform_Usage_Viewer` permission set and View Setup and Configuration to see
any figure. Other apps, and the org's own Home page, are unchanged.

- [What you see](#what-you-see)
- [Where the numbers come from](#where-the-numbers-come-from)
- [How fresh the numbers are](#how-fresh-the-numbers-are)
- [What it costs](#what-it-costs)
- [Who can see it](#who-can-see-it)
- [Setting it up](#setting-it-up)
- [When something looks wrong](#when-something-looks-wrong)
- [Why it is built this way](#why-it-is-built-this-way)
- [Where the code is](#where-the-code-is)
- [Teardown](#teardown)
- [Sources](#sources)

## What you see

| Section | Content |
|---|---|
| AWS this month | Spend so far this UTC month, in US dollars, against the limit and how that limit was chosen (the budget `cloud-agentic-iot-monthly`, or the largest monthly cost budget). A coloured bar, a line on what the amount counts, any notices, and when it was read. |
| Salesforce org limits | Every `OrgLimits` entry with a maximum above 0, grouped: Storage (data and files), API, Apex, Platform events and streaming, Email and flows, Analytics and Einstein, and Other. Within a group, the most used come first. |
| CPU and memory | "Salesforce does not report CPU time or memory (heap) for the whole org, only per request." Below it, as plain text with no bars, what loading the card used of each per-request limit: CPU, heap, SOQL queries, rows queried, DML statements and callouts. |
| AI tokens and credits | Usage-based entitlement rows, if the org has any, or the error type when they cannot be read. Always a note on where token counts live. |

**Bars** appear on AWS spend, org limits and entitlements only:

| Share used | Colour |
|---|---|
| Below 50% | Green |
| 50% to 79% | Amber |
| 80% and above | Red |

A bar never grows past its track; the text beside it shows the true share,
which may be over 100%. Some use that rounds to 0% shows as "under 1%".

**What the amount counts** is said under it:

| Line | When |
|---|---|
| Before credits, refunds and tax, as a spend limit counts. | The budget leaves out credits, refunds and tax (the budget this page creates does), or the figure came from Cost Explorer. |
| After credits and refunds, with tax: the budget has no charge-type filter. | The budget has no charge-type filter. |
| What this counts depends on the budget's charge-type filter. | Any other charge-type filter. |

When Cost Explorer marks its figure as estimated, the line adds "AWS marks
this figure as estimated."

**When AWS does not answer**, the card shows the error and what to do, and
under it the last spend AWS did report: "Last known: $3.42 of $20.00
(November 2026), read Nov 6, 5:20 PM." The Salesforce half keeps working.

**AI tokens.** Salesforce gives Apex no AI token count without Data 360:
token counts need Data 360 with Einstein Audit and Feedback on, and querying
them uses Data 360 credits, so the card does not. A Developer Edition org may
make 150 LLM generation requests an hour; paid orgs show their credits in
Digital Wallet.

## Where the numbers come from

**AWS.** The card calls `PlatformUsageController.awsSpend`, which makes one
callout through the `AWS_IoT_Relay` Named Credential (SigV4) to
`POST /aws-spend` on the device API, served by the Lambda function
`cloud-agentic-iot-aws-spend`. The function reads `DescribeBudgets`, for
which AWS lists no charge, and picks one budget:

1. The budget named by the stack parameter `SpendLimitBudgetName`, by default
   `cloud-agentic-iot-monthly`, if it is a monthly cost budget in USD that
   counts every service (no filter, or a filter on charge type alone).
2. Otherwise the largest such budget above $1.00. Ties go to the first name
   in alphabetical order. Budgets of $1 or less, such as AWS's zero-spend
   template, are alerts and never chosen.

Spend is the budget's `ActualSpend`; the limit is its amount.

With no such budget, the card shows "No monthly cost budget found" and costs
nothing, unless the stack parameter `SpendCostExplorer` is `true`. Then the
function asks Cost Explorer `GetCostAndUsage` for the month, leaving out
credits, refunds and tax, at $0.01 a request. It writes a claim on the SSM
parameter `/cloud-agentic-iot/cache/aws-spend` before every paid request: if
SSM cannot be read or written, Cost Explorer is not asked and nothing is
charged. The SDK never retries a Cost Explorer request on its own.

**AWS projects and regular accounts.** No documented API returns an AWS
project's spend limit; AWS calls a spend limit "a type of AWS Budgets". So
each project gets the budget `cloud-agentic-iot-monthly` with its amount equal
to the spend limit, and it wins by name whatever other budgets exist. Only a
project owner can see or set the spend limit, in AWS Settings. Regular
accounts (Dev and Prod) have no spend limit: the same budget is simply the
monthly amount to watch, and the card calls it a budget, not a cap.

**Salesforce.** `PlatformUsageController.salesforceLimits` reads
`System.OrgLimits` for the org's limits, `System.Limits` for what this request
used, and `TenantUsageEntitlement` for usage-based entitlements.

**The AWS account ID never reaches the card.** The Lambda and the Apex both
replace every run of 12 digits with `[account]`, in budget names and in error
text alike.

## How fresh the numbers are

| Number | Fresh to |
|---|---|
| Budget spend | AWS recalculates budgets about every 8 to 12 hours. "Read at" is when the card asked, not when AWS last recalculated. |
| Cost Explorer spend | Refreshed daily, covering usage up to yesterday. A reading is kept for `SpendCacheHours` (24); a zero, a reading on the 1st or "no data yet" for 3 hours; a busy Cost Explorer for 15 minutes; a refusal that needs a person to act for `SpendCacheHours`. |
| Org limits | About 5 minutes. |
| CPU and memory | This request. |

The month is the UTC month, as AWS bills, and the card says "(UTC)". On the
1st (UTC), the card always adds "A new month began at 00:00 UTC…", because
AWS can take up to a day to show the new month's spend.

## What it costs

Per AWS account, at 100 page loads a day (3,000 a month):

| Item | Rate | Cost |
|---|---|---|
| API Gateway HTTP API | $1.00 per million | $0.003 |
| Lambda requests | $0.20 per million | $0.0006 |
| Lambda compute (about 375 GB-s) | inside the free 400,000 GB-s | $0 |
| `DescribeBudgets` | AWS lists no charge (budgets without actions are free) | $0 |
| SSM standard parameter | no charge | $0 |
| CloudWatch Logs (about 3 MB) | $0.50 per GB | about $0.002 |
| **Total, budget path or Cost Explorer off** | | **under $0.01** |
| Cost Explorer on, no budget | about 30 normal reads, plus up to 7 extra on the 1st | **about $0.31 to $0.40 extra** |
| Worst case with Cost Explorer on and SSM writing claims but failing to keep results | one request per 10 minutes | $1.44 a day, visible in the log as "Could not keep" |
| Cost Explorer on every load (not built) | 3,000 × $0.01 | $30 |

Across the three environments on the budget path: about $0.01 to $0.03 a
month.

**Salesforce**, per page load: two Apex requests, one callout, three SOQL
queries and, after a successful AWS answer, one DML statement on the single
`Aws_Spend_Snapshot__c` row. No other records, no Platform Cache.

**The patient portal** ([PATIENT-PORTAL.md](PATIENT-PORTAL.md)) adds no AWS
cost and no callout. Its costs are Salesforce's, and the card does not show
them yet:
- Experience Cloud user licences: one per patient who signs in. Setup >
  Company Information > User Licenses shows used and total, and the card's
  org limits do not include them.
- Agentforce: 20 Flex Credits per action and 60 per Agentforce Voice minute,
  in Digital Wallet (paid orgs) or against the Developer Edition allowance.
- Each `GET /portal/my-devices` is one Apex REST request per patient every 30
  seconds while My room is open: it counts against the org's daily API
  requests, about 2,880 a day for one patient who keeps the page open all
  day. The Developer Edition allows 15,000 a day, so close the tab when you
  are done.
Full figures: [COST-MODEL.md §7](COST-MODEL.md#7-patient-portal-react-site-enhanced-chat-and-agentforce-voice).

## Who can see it

- Only users who hold `Platform_Usage_Viewer` **and** View Setup and
  Configuration (from their profile or any permission set). The Apex checks
  both on every call; everyone else sees "Costs and limits are for admins".
- The AWS half also needs the hand-made `AWS_IoT_Relay_Callers` permission set
  (INSTALL-GUIDE.md, Stage 2 part d).
- `Device_Platform_Admin` gets neither the class nor the permission, so device
  operators never see costs.
- `Aws_Spend_Snapshot__c` holds the last spend figure. Outside the card, only
  users who may view custom settings (admins) can read it.
- Nothing assigns the permission set automatically:

```bash
sf org assign permset --name Platform_Usage_Viewer --target-org <admin alias>
```

## Setting it up

1. Deploy AWS first (`scripts/deploy-aws.sh <env>`), then Salesforce
   (`scripts/deploy-salesforce.sh <env>`).
2. Assign `Platform_Usage_Viewer` to each admin who should see costs, and make
   sure each holds `AWS_IoT_Relay_Callers`.
3. Give the account a budget (below).

### Give the account a budget

Once per AWS account. In Dev and Prod, `scripts/bootstrap-aws.sh` creates it
with `BUDGET_USD` and `BUDGET_EMAIL` ([SETUP.md §3.2](SETUP.md#32-the-deploy-role-and-the-budget-scriptsbootstrap-awssh)),
counting the same way as the command below. In an AWS project, a project
owner runs the command below in the project's CloudShell, or tries
`GITHUB_OIDC=no scripts/bootstrap-aws.sh Dev` ([TRY-IT.md](TRY-IT.md#see-what-it-costs)).

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
# What is there now. In the project, look for a budget whose limit equals the spend limit.
aws budgets describe-budgets --region us-east-1 --account-id "$ACCOUNT" --show-filter-expression \
  --query 'Budgets[].{name:BudgetName,type:BudgetType,unit:TimeUnit,limit:BudgetLimit.Amount,filter:FilterExpression,old:CostFilters}'

LIMIT=20                    # the project's spend limit; in Dev and Prod, the monthly amount to watch
EMAIL='<your email>'
aws budgets create-budget --region us-east-1 --account-id "$ACCOUNT" \
  --budget "{\"BudgetName\":\"cloud-agentic-iot-monthly\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"$LIMIT\",\"Unit\":\"USD\"},\"Metrics\":[\"UnblendedCost\"],\"FilterExpression\":{\"Not\":{\"Dimensions\":{\"Key\":\"RECORD_TYPE\",\"Values\":[\"Credit\",\"Refund\",\"Tax\"]}}}}" \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}]"
```

- A budget without actions is free.
- It leaves out credits, refunds and tax, as a spend limit does, so the card
  says "Before credits, refunds and tax".
- Its first figure appears within about 12 hours; until then the card says
  AWS has not calculated it yet.
- **In an AWS project, keep its amount equal to the spend limit.** Change both
  together from then on.

**`SpendCostExplorer`** (in `config/<env>.json`, `stacks.queue-relay`) is
`"false"` everywhere. Turn it on only for an account that will have no budget:
it costs about $0.31 to $0.40 a month at 100 loads a day. A budget never needs
it.

## When something looks wrong

| The card says | Cause | Fix |
|---|---|---|
| "Costs and limits are for admins" | No `Platform_Usage_Viewer`, or no View Setup and Configuration | Assign the permission set to an admin who has View Setup. |
| "Salesforce could not reach AWS" (HTTP 0) | The credential, or STS | INSTALL-GUIDE.md, "If a callout fails". |
| "has no aws-spend route yet" (404) | The queue-relay stack predates this card | Deploy queue-relay: `scripts/deploy-aws.sh <env>`. |
| "AWS refused the AWS_IoT_Relay credential" (401 or 403) | The Named Credential or its IAM role | INSTALL-GUIDE.md Stage 2, parts b and c. |
| "Check AwsSpendRole" | The function's role, or `aws-portal:ViewBilling` in an account created before 6 March 2023 | Look for the denied call in CloudTrail. |
| "See the cloud-agentic-iot-aws-spend log" | Budgets refused for another reason | CloudWatch log group `/aws/lambda/cloud-agentic-iot-aws-spend`. |
| "AWS Budgets is busy" | Throttling or an AWS fault | Reload in a minute. |
| "still runs placeholder code" | The stack was deployed but not the code | Run `scripts/deploy-aws.sh <env>`. |
| "API Gateway throttled the request" | Too many requests at once | Reload in a minute. |
| "AWS did not answer…" | Often a project near its spend limit, where AWS stops running Lambda functions | Check AWS Settings. "Last known" still shows. |
| "No monthly cost budget found" | No budget that counts every service | [Give the account a budget](#give-the-account-a-budget). |
| "the largest budget (…)" when that is not the spend limit | No `cloud-agentic-iot-monthly` yet | Create it. |
| "AWS has not calculated this budget's spend yet" | A new budget | Wait up to about 12 hours. |
| "Cost Explorer is not enabled in this account" | Cost Explorer on, never enabled | Create the budget instead. |
| "Cost Explorer has no data for this month yet", "was busy", "is being asked right now", "could not be read", "could not be recorded" | Cost Explorer or SSM, with Cost Explorer on | Wait or reload; the last two mean nothing was charged. |
| "A new month began at 00:00 UTC" | The 1st (UTC) | Nothing; the figure settles within a day. |
| "Entitlements could not be read (…)" | The org has no `TenantUsageEntitlement`, or the user may not read it | Nothing to fix; the type is named. |
| AI tokens shows only the note | No usage-based entitlements: expected on Developer Edition | Nothing. |

**Resetting the Cost Explorer reading**, so the next load asks again
(`iot-operator` may do this):

```bash
aws ssm put-parameter --name /cloud-agentic-iot/cache/aws-spend --value '{}' --type String --overwrite
```

## Why it is built this way

- **Budgets, not Cost Explorer.** AWS lists no charge for reading budgets,
  while Cost Explorer costs $0.01 a read: $30 a month per account at 100 loads
  a day if asked on every load.
- **Claim first, no retries.** When Cost Explorer is on, a claim is written
  before any paid read and the SDK does not retry, so a failing SSM can never
  turn page loads into paid requests.
- **Cost Explorer is off by default.** A budget gives the same figure free.
- **A named budget.** A spend limit has no API, so the project mirrors it in a
  budget that wins by name.
- **A last-known snapshot, not a cache.** Platform Cache is 0 MB on Developer
  Edition, and the last figure must stay visible when a project near its spend
  limit stops answering.
- **CPU and heap per request only.** Salesforce keeps them per transaction and
  no total for the org.
- **No token counts.** They live in Data 360, and querying them uses credits.
- **Two Apex methods, one after the other.** AWS being unreachable never
  blanks the Salesforce half, and two calls started together travel in one
  batched request, which would make the Salesforce half wait for the callout.
- **A custom permission plus View Setup**, rather than a profile, so costs are
  for admins in every org whatever the profiles are called.

## Where the code is

| Path | What |
|---|---|
| `lambda/aws-spend/` | The function behind `POST /aws-spend` |
| `lambda/queue-relay/cloudformation.yaml` | Its role, cache parameter, route and settings (`SpendLimitBudgetName`, `SpendCostExplorer`, `SpendCacheHours`) |
| `config/Dev.json`, `config/Prod.json` | `SpendCacheHours` and `SpendCostExplorer` |
| `force-app/main/default/classes/PlatformUsageController.cls` | The two Apex methods |
| `force-app/main/default/objects/Aws_Spend_Snapshot__c/` | The last-known snapshot (hierarchy custom setting) |
| `force-app/main/default/lwc/platformUsageCard/` | The card; `usage.js` works out everything it shows |
| `force-app/main/default/flexipages/Cloud_Agentic_IoT_Home.flexipage-meta.xml` | The Home page |
| `force-app/main/default/applications/Cloud_Agentic_IoT.app-meta.xml` | The Home override, in this app only |
| `force-app/main/default/customPermissions/View_Platform_Usage.customPermission-meta.xml`, `permissionsets/Platform_Usage_Viewer.permissionset-meta.xml` | Who may see it |
| `test/lambda/aws-spend.test.js`, `test/lambda/aws-spend-role.test.js`, `test/lwc/platform-usage.test.js`, `PlatformUsageControllerTest.cls` | The tests |

## Teardown

Deleting the queue-relay stack deletes the function and its cache parameter.
Budgets stay until root (or a project owner) deletes them. Delete the
`Aws_Spend_Snapshot__c` record along with the Salesforce metadata.

## Sources

- AWS: creating a spend limit for an AWS project; AWS Budgets pricing and FAQ;
  the Budgets `DescribeBudgets` API; the Cost Explorer `GetCostAndUsage` API
  and Cost Explorer pricing; the project's service control policies; AWS SDK
  retry behaviour; migrating to fine-grained billing actions.
- Salesforce: the Apex `OrgLimits` and `Limits` classes; the
  `TenantUsageEntitlement` object; Platform Cache in Developer Edition;
  Agentforce in Developer Edition; Data 360 in Apex.
