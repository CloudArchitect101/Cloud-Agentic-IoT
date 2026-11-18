# CI/CD & Secrets: What's Automated, What's Manual

Goal: nothing sensitive ever gets committed to this public repo. Real credentials live in **GitHub Environment secrets**, only reachable by GitHub Actions workflows running on this repo — never visible in code, never visible to someone just browsing the repository.

This doc is written so anyone can fork/clone this repo, follow it top to bottom, and end up with their own working Dev + Prod pipeline against their own AWS/Salesforce accounts.

## The model

- Two GitHub **Environments**: `Dev` and `Prod` (Settings → Environments), matching the `Dev`/`Prod` git branches.
- Each environment has its own scoped secrets/variables — a value stored under `Prod` is not readable by a workflow run triggered from `Dev`, and vice versa.
- `Prod`'s environment has a **required reviewer** protection rule — a deploy to the real production AWS account/Salesforce org needs a manual approval click, even though the workflow itself is automated.
- **No long-lived AWS access keys anywhere.** GitHub Actions authenticates to AWS via OIDC federation — a workflow run gets a short-lived token by presenting a signed OIDC claim, nothing stored to steal.
- **No Salesforce username/password anywhere.** Auth uses the JWT Bearer Flow — an External Client App + a private key, never a password. (External Client Apps are the current framework for the same OAuth surface Connected Apps used to provide; new orgs have legacy Connected App creation switched off by default.)

## What's automated vs. what's manual

| Step | Automated or Manual | Why |
|---|---|---|
| Create accounts + all five identities | **Manual**, once — see [`SETUP.md`](SETUP.md) | Billing identity, license allocation and credentials must not pass through automation |
| Create your Salesforce Dev + Prod orgs | **Manual** | Signup flow, needs a real email |
| Create the GitHub repo | **Manual** | One-time |
| One-time AWS OIDC provider, deploy role and budget | **One command per account**, `scripts/bootstrap-aws.sh <env>` as `iot-operator` ([`SETUP.md`](SETUP.md) §3.2) | The pipeline cannot create the role it signs in with |
| Putting the Salesforce integration settings into SSM | **Automated** in the pipeline; on a laptop the same `scripts/seed-ssm.sh <env>` | One script, so the laptop and the pipeline write the same parameters the same way |
| One-time Salesforce External Client App + JWT cert setup (steps below) | **Manual**, run once per org | Same reason |
| Entering secret values into GitHub | **Manual**, one-time (~10 min), through `scripts/setup-github-secrets.sh` | Secret values must never pass through an automated agent or chat |
| Checking a change: Lambda tests, template lint, script lint, Salesforce metadata, firmware build | **Automated** — `.github/workflows/checks.yml` on every pull request, and again before every deploy. Locally: `scripts/check.sh` | Nothing here needs credentials, so it runs on any branch |
| A board's first flash, over USB | **Always manual** — `scripts/setup-device.sh`; day to day, `scripts/firmware.sh flash` | A blank ESP32 has no network stack, so the first firmware cannot arrive over the air |
| Deploying Lambda/CloudFormation to Dev/Prod AWS | **Automated** — `.github/workflows/deploy.yml` on push to `Dev`/`Prod`, running `scripts/deploy-aws.sh` | Validates every template, deploys stacks, then packages and uploads the real Lambda source |
| Deploying Salesforce metadata to Dev/Prod org | **Automated** — the same run, `scripts/deploy-salesforce.sh` | Runs a check-only dry run with `RunLocalTests` before the real deploy |
| Publishing firmware over the air | **Automated** — the same run, `scripts/ota.sh release` | Only a version not yet published. Dev: every Dev board (`fleet-<type>`). Prod: the canary ring (`canary-<type>`) |
| Promoting a Prod release **canary → fleet** | **Manual** — `.github/workflows/ota-promote.yml`, `workflow_dispatch` on `Prod` | Deliberately human: it is the judgement that the canary behaved. Refuses unless that version's canary job finished with a board updated and none failed |
| Triggering a one-off device command | **Manual**, from the Salesforce app | That's the demo of Salesforce managing the device |

> **Pushes deploy only once you switch them on.** `deploy.yml` deploys a push only when the repository variable `AUTO_DEPLOY` names the branch: set it to `Dev` once Dev's secrets are in, then `Dev Prod`. Until then, run Deploy by hand (Actions tab → Deploy → *Run workflow* → choose `Dev` or `Prod`). See [`DEVELOPMENT.md`](DEVELOPMENT.md), "Turning it on".

## Setting all of this up

The step-by-step — creating accounts, the five identities, Salesforce license
allocation, both External Client Apps, the OIDC role, VS Code authorization, and the
exact GitHub secrets — lives in **[`SETUP.md`](SETUP.md)** so there is one
canonical copy rather than two that drift apart.

The short version of what the pipelines need:

| Environment secret | Purpose |
|---|---|
| `AWS_ROLE_ARN` | OIDC role the workflow assumes — no long-lived keys exist |
| `SF_CONSUMER_KEY`, `SF_JWT_KEY`, `SF_USERNAME` | The **deploy** External Client App and user, never the runtime integration one |
| `SF_INTEGRATION_CONSUMER_KEY`, `SF_INTEGRATION_JWT_KEY`, `SF_INTEGRATION_USERNAME` | The **integration** app and user the Lambdas run as, copied into SSM by the deploy |

Variables (not secrets): `AWS_REGION` (`ca-central-1`), `SF_LOGIN_URL`, the optional `ALARM_EMAIL`, and, for Data Cloud's read access to the readings archive, the optional `DATA_CLOUD_OIDC_PROVIDER_ARN` and `DATA_CLOUD_EXTERNAL_ID` (a role, no key; [DATA-CLOUD.md](DATA-CLOUD.md)). None of these is a credential. The Lambdas learn the org's instance from the token Salesforce returns, so nothing names it. The integration key and the Slack signing secret are stored in SSM as SecureString, which the Lambdas decrypt when they read them; neither ever appears in a CloudFormation parameter. The firmware bucket and the role AWS IoT signs download links with come from the `ota` stack, so OTA needs nothing set. One repository variable, `AUTO_DEPLOY`, switches automatic deploys on.

## Conventions the pipelines enforce

These are not style preferences — break one and the build fails loudly (which is the point; the alternative is a green pipeline running placeholder code).

| Convention | Why | Enforced by |
|---|---|---|
| A Lambda's `FunctionName` must be `cloud-agentic-iot-<source directory name>` | Lets the packaging step map source to function with no lookup table | `scripts/deploy-aws.sh` errors and exits if a function is missing |
| Every `AWS::Lambda::Function` needs a `Code` property | It is required by CloudFormation; without it the stack fails validation | Template validation step, before any deploy |
| Every `.cls` needs a matching `.cls-meta.xml` | Salesforce source-format deploys reject classes without it | `sf project deploy start` |
| Salesforce metadata goes in the shared `force-app/`, not a per-chapter copy | One package directory means `sf project deploy start` just works on `Dev` and `Prod` alike | `sfdx-project.json` declares the single path |
| Per-chapter prose goes in `content/<chapter>/`, code does not | Every chapter has its own ARCHITECTURE/BLOG/LINKEDIN/VIDEO; code stays in the one shared layout | Convention, generated by `chapter-setup.sh` |
| A sketch folder must contain a `.ino` named after the folder | `arduino-cli` fails with "main file missing from sketch" otherwise | `scripts/firmware.sh build` checks the name explicitly |
| A sketch must declare `#define FIRMWARE_VERSION "x.y.z"` | It is the OTA version gate; without it the sketch could never be released | `scripts/firmware.sh build` fails without it |
| Raise `FIRMWARE_VERSION` to ship firmware | An unchanged version publishes nothing, so refactors and docs edits cannot reach devices, and a board skips a version it already runs | `scripts/firmware.sh check-version` fails a pull request that changes firmware without raising it; the S3 artefact's existence is the release gate |
| Every sketch has `fleet-<sketch>` and `canary-<sketch>` in `infra/ota/cloudformation.yaml` | A release needs a group to target | `scripts/check.sh templates` |

`scripts/chapter-setup.sh` generates scaffolding that already satisfies all of these — use it rather than hand-creating a new chapter.

## Pull requests from outside contributors

Once the repository is public, anyone can fork it and open a pull request into
`Dev`. Their code never sees the project's credentials:

- `checks.yml` is the only workflow a pull request triggers. It runs on
  `pull_request` (never `pull_request_target`), with `contents: read`, no
  secrets and no OIDC. GitHub also withholds secrets from fork pull requests.
- Every workflow that uses AWS OIDC or Salesforce secrets runs only on a push
  to `Dev` or `Prod`, or when the maintainer starts it by hand. A push to
  those branches only happens through a merged pull request.
- `test/config/contribution-safety.test.js` fails the checks if a workflow
  change breaks either rule, so a pull request cannot quietly widen them.
- `.github/CODEOWNERS` names the maintainer for every path.

These repository settings complete it. They live in GitHub, not in the repo:

| Setting | Where | Value |
|---|---|---|
| Fork pull request workflows | Settings > Actions > General | "Require approval for all external contributors" |
| Workflow permissions | Settings > Actions > General | "Read repository contents and packages permissions" |
| Branch protection for `Dev` and `Prod` | Settings > Rules > Rulesets | Require a pull request, 1 approval, review from Code Owners, dismiss stale approvals, all `Checks` jobs passing; block force pushes and deletion. Add the Repository admin role to the bypass list: GitHub never lets you approve your own pull request, so a solo maintainer needs it to merge their own changes |
| `Prod` environment | Settings > Environments > Prod | Required reviewer: the maintainer; deployment branch `Prod` only |
| `Dev` environment | Settings > Environments > Dev | Deployment branch `Dev` only |
| Private vulnerability reporting | Settings > Security | Enabled (used by [SECURITY.md](../SECURITY.md)) |
| Secret scanning and push protection | Settings > Security | Enabled (free on public repositories) |

## Pipeline failures and what they actually mean

Every one of these was hit for real getting the pipeline green. The error text
rarely names the cause, which is the whole reason for this table.

| Error | Real cause | Fix |
|---|---|---|
| `webidl.util.markAsUncloneable is not a function` during `sf` startup | The Salesforce CLI pulls in jsforce → undici 8, which requires Node ≥ 22.19.0. npm only *warns* on an unmet `engines`, so the install succeeds and the CLI dies on first run | `node-version: '22'` in the workflow. `lambda/slack-integration` used to bundle jsforce too; it now uses the shared fetch client |
| `sf org login jwt` runs with `--instance-url ""` | `SF_LOGIN_URL` was never set as a GitHub Environment **variable** | Set it, or rely on the workflow default. `scripts/setup-github-secrets.sh` prompts for it |
| `External client app is not installed in this org` | Misleading — the app usually *is* installed. It means the org will not honour the JWT for that app: no certificate uploaded, the user not pre-authorized (permission set **and** profile), or the login blocked by `ipRelaxationPolicyType: Enforce` against a runner IP you cannot predict | See [`SETUP.md`](SETUP.md) §2.4, which lists the known-good configuration to diff against |
| JWT auth succeeds but the CLI then fails against the Metadata API | **"Issue JSON Web Token (JWT)-based access tokens for named users"** (`isNamedUserJwtEnabled`) is on. That is not the JWT bearer *flow* — it changes the access token handed back into a JWT, and the CLI needs an opaque session ID | Turn it **off**. It is a different setting from "Enable JWT Bearer Flow" despite the near-identical name |
| `invalid_grant` on an otherwise correct JWT | The certificate uploaded to the app is not the public half of the key being signed with | Compare moduli — `openssl x509 -noout -modulus` vs `openssl rsa -noout -modulus` |
| `AccessDenied` on an SSM, Lambda, IoT, S3 or IAM call in the first run | The deploy role had only `AWSCloudFormationFullAccess`, but CloudFormation runs with the caller's rights and the scripts call those services directly | `scripts/bootstrap-aws.sh` gives the role the `cloud-agentic-iot-deploy` policy; a new call a script makes must be added there, and `test/config/deploy-policy.test.js` fails until it is |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The IAM trust policy matches a `sub` claim GitHub no longer sends. Jobs declaring `environment:` get `...:environment:Dev`, **not** `...:ref:refs/heads/Dev`; new repos additionally get immutable owner/repo IDs | See [`SETUP.md`](SETUP.md) §3.2. Read the real claim from CloudTrail rather than guessing |
| Every Apex component fails `Not available for deploy for this organization`, every LWC fails `insufficient access rights on entity: LightningComponentResource` | The deploy user's permission set lacks **Author Apex**. One missing permission, two unrelated-looking messages. Invisible locally — admins hold it implicitly, so only the pipeline sees it | Add Author Apex to `Metadata_Deploy` — see [`SETUP.md`](SETUP.md) §2.3 |
| Only the LWC bundle fails, with `insufficient access rights on entity: LightningComponentResource`, after Author Apex is granted | Lightning components need **Customize Application** as well as Author Apex | §4 |
| Objects or fields fail while Apex now succeeds | **Customize Application** missing. Each metadata type needs its own permission; `Modify Metadata Through Metadata API Functions` only grants Metadata API access, not the right to change any given type | §4 has the full type→permission table |
| Apex tests fail with `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY` while the same tests pass locally | Tests run as the **deploying user**, not as you. Anything creating setup objects — a `Group` of `Type='Queue'` in our case — needs admin rights that no permission grant supplies | The deploy user's profile is System Administrator for this reason — see [`SETUP.md`](SETUP.md) §2.3 |
| A trigger reports `Test coverage … is 0%, at least 1% is required` even though org-wide coverage looks fine | Salesforce enforces ≥1% per **trigger** separately from the 75% org-wide rule. A trigger whose only tests failed counts as 0% | Fix the failing tests first; the coverage warning is usually a symptom, not the cause |
| The pipeline goes green in Dev, then fails wholesale on the first Prod deploy | Dev was hand-deployed by an admin first. Unchanged components skip the permission check entirely, so Dev never exercised the deploy user's real permissions; Prod has nothing pre-deployed and exercises all of them at once | Read effective permissions rather than trusting a green Dev run — §4 |
| A `PermissionSet` component fails but nothing else does | **Manage Profiles and Permission Sets** missing | Same table |
| A single component fails `Not available for deploy for this organization` | That *type* needs a feature switched on — `Bot` needs Einstein Bots, the `GenAi*` types need Agentforce | Turn on Einstein, then Agentforce ([SETUP.md §2.1](SETUP.md#21-create-the-org-and-secure-the-admin), steps 3 and 4). If it persists on `Bot`, check `<type>`: classic `Bot` needs an Einstein Bots licence, Agentforce agents use `InternalCopilot` |
| `Expected source files for type 'GenAiFunction'` | `GenAiFunction` is a bundle type — it needs its own directory, not a bare `.genAiFunction-meta.xml` | `genAiFunctions/<Name>/<Name>.genAiFunction-meta.xml` |
| `Could not infer a metadata type` on an `__e` event | Platform events are CustomObjects in source format. A `platform_events/` directory with a `<CustomEventDefinition>` root is MDAPI shape and does not resolve | `objects/<Event>__e/<Event>__e.object-meta.xml` with `<CustomObject>`, fields split into `fields/` |
| A platform event field silently will not deploy | Platform events support only Checkbox, Date, Date/Time, Number, Text and Text Area (Long) — **Picklist is not supported** | Use Text and document the permitted values in the field description |

One habit catches most of the above before a push, and it is the same check the pull request runs:

```bash
scripts/check.sh                               # includes resolving all Salesforce source offline
scripts/deploy-salesforce.sh Dev --dry-run --with-tests   # then validate against the Dev org, as the deploy user, with every Apex test
```
