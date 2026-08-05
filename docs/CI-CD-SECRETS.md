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
| One-time AWS OIDC provider + IAM role setup (commands below) | **Manual**, run once per account | Establishes trust, shouldn't be re-run automatically |
| One-time Salesforce External Client App + JWT cert setup (steps below) | **Manual**, run once per org | Same reason |
| Entering secret values into GitHub | **Manual**, one-time (~10 min) | Secret values must never pass through an automated agent or chat |
| Compiling the ESP32 firmware | **Automated** — `.github/workflows/build-firmware.yml` runs on every push | Pure build, no physical access needed |
| Flashing firmware onto the physical device | **Always manual** | Needs the device plugged into a USB port — cannot be automated by definition |
| Deploying Lambda/CloudFormation to Dev/Prod AWS | **Automated** — `.github/workflows/deploy-aws.yml`, on push to `Dev`/`Prod` | Validates every template, deploys stacks, then packages and uploads the real Lambda source |
| Deploying Salesforce metadata to Dev/Prod org | **Automated** — `.github/workflows/deploy-salesforce.yml`, on push to `Dev`/`Prod` | Runs a check-only dry run with `RunLocalTests` before the real deploy |
| Publishing firmware + creating the **canary** OTA Job | **Automated** — `.github/workflows/ota-release.yml`, on push to `Dev`/`Prod` touching `firmware/**` | Only if `FIRMWARE_VERSION` was bumped; always targets `canary-ring-1` first |
| Promoting an OTA build **canary → fleet** | **Manual** — `.github/workflows/ota-promote.yml`, `workflow_dispatch` | Deliberately human: it is the judgement that the canary behaved. Refuses to run if no COMPLETED canary Job exists for that version |
| Triggering a one-off device command | **Manual**, from the Salesforce app | That's the demo of Salesforce managing the device |

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
| `OTA_PRESIGN_ROLE_ARN` | Role AWS IoT assumes to sign per-device firmware URLs |

Variables (not secrets): `AWS_REGION`, `FIRMWARE_BUCKET`, `SF_LOGIN_URL`.

## Conventions the pipelines enforce

These are not style preferences — break one and the build fails loudly (which is the point; the alternative is a green pipeline running placeholder code).

| Convention | Why | Enforced by |
|---|---|---|
| A Lambda's `FunctionName` must be `cloud-agentic-iot-<source directory name>` | Lets the packaging step map source to function with no lookup table | `deploy-aws.yml` errors and exits if a function is missing |
| Every `AWS::Lambda::Function` needs a `Code` property | It is required by CloudFormation; without it the stack fails validation | Template validation step, before any deploy |
| Every `.cls` needs a matching `.cls-meta.xml` | Salesforce source-format deploys reject classes without it | `sf project deploy start` |
| Salesforce metadata goes in the shared `force-app/`, not a per-chapter copy | One package directory means `sf project deploy start` just works on `Dev` and `Prod` alike | `sfdx-project.json` declares the single path |
| Per-chapter prose goes in `content/<chapter>/`, code does not | Every chapter has its own ARCHITECTURE/BLOG/LINKEDIN/VIDEO; code stays in the one shared layout | Convention, generated by `chapter-setup.sh` |
| A sketch folder must contain a `.ino` named after the folder | `arduino-cli` fails with "main file missing from sketch" otherwise | `build-firmware.yml` checks the name explicitly |
| A sketch must declare `#define FIRMWARE_VERSION "x.y.z"` | It is the OTA version gate; without it the sketch is never released | `ota-release.yml` skips sketches that omit it |
| Bump `FIRMWARE_VERSION` to ship firmware | An unchanged version publishes nothing, so refactors and docs edits cannot reach devices | The S3 artefact's existence is the gate |

`scripts/chapter-setup.sh` generates scaffolding that already satisfies all of these — use it rather than hand-creating a new chapter.

## Pipeline failures and what they actually mean

Every one of these was hit for real getting the pipeline green. The error text
rarely names the cause, which is the whole reason for this table.

| Error | Real cause | Fix |
|---|---|---|
| `webidl.util.markAsUncloneable is not a function` during `sf` startup | The Salesforce CLI pulls in jsforce → undici 8, which requires Node ≥ 22.19.0. npm only *warns* on an unmet `engines`, so the install succeeds and the CLI dies on first run | `node-version: '22'` in the workflow. Same trap in `lambda/slack-integration`, which bundles jsforce — its `Runtime` is `nodejs22.x` for this reason |
| `sf org login jwt` runs with `--instance-url ""` | `SF_LOGIN_URL` was never set as a GitHub Environment **variable** | Set it, or rely on the workflow default. `scripts/setup-github-secrets.sh` prompts for it |
| `External client app is not installed in this org` | Misleading — the app usually *is* installed. It means the org will not honour the JWT for that app: no certificate uploaded, the user not pre-authorized (permission set **and** profile), or the login blocked by `ipRelaxationPolicyType: Enforce` against a runner IP you cannot predict | See [`SETUP.md`](SETUP.md) §5, which lists the known-good configuration to diff against |
| JWT auth succeeds but the CLI then fails against the Metadata API | **"Issue JSON Web Token (JWT)-based access tokens for named users"** (`isNamedUserJwtEnabled`) is on. That is not the JWT bearer *flow* — it changes the access token handed back into a JWT, and the CLI needs an opaque session ID | Turn it **off**. It is a different setting from "Enable JWT Bearer Flow" despite the near-identical name |
| `invalid_grant` on an otherwise correct JWT | The certificate uploaded to the app is not the public half of the key being signed with | Compare moduli — `openssl x509 -noout -modulus` vs `openssl rsa -noout -modulus` |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The IAM trust policy matches a `sub` claim GitHub no longer sends. Jobs declaring `environment:` get `...:environment:Dev`, **not** `...:ref:refs/heads/Dev`; new repos additionally get immutable owner/repo IDs | See [`SETUP.md`](SETUP.md) §6 Step 2. Read the real claim from CloudTrail rather than guessing |
| Every Apex component fails `Not available for deploy for this organization`, every LWC fails `insufficient access rights on entity: LightningComponentResource` | The deploy user's permission set lacks **Author Apex**. One missing permission, two unrelated-looking messages. Invisible locally — admins hold it implicitly, so only the pipeline sees it | Add Author Apex to `Metadata_Deploy` — see [`SETUP.md`](SETUP.md) §4 |
| Only the LWC bundle fails, with `insufficient access rights on entity: LightningComponentResource`, after Author Apex is granted | Lightning components need **Customize Application** as well as Author Apex | §4 |
| Objects or fields fail while Apex now succeeds | **Customize Application** missing. Each metadata type needs its own permission; `Modify Metadata Through Metadata API Functions` only grants Metadata API access, not the right to change any given type | §4 has the full type→permission table |
| Apex tests fail with `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY` while the same tests pass locally | Tests run as the **deploying user**, not as you. Anything creating setup objects — a `Group` of `Type='Queue'` in our case — needs admin rights that no permission grant supplies | The deploy user's profile is System Administrator for this reason — see [`SETUP.md`](SETUP.md) §4 |
| A trigger reports `Test coverage … is 0%, at least 1% is required` even though org-wide coverage looks fine | Salesforce enforces ≥1% per **trigger** separately from the 75% org-wide rule. A trigger whose only tests failed counts as 0% | Fix the failing tests first; the coverage warning is usually a symptom, not the cause |
| The pipeline goes green in Dev, then fails wholesale on the first Prod deploy | Dev was hand-deployed by an admin first. Unchanged components skip the permission check entirely, so Dev never exercised the deploy user's real permissions; Prod has nothing pre-deployed and exercises all of them at once | Read effective permissions rather than trusting a green Dev run — §4 |
| A `PermissionSet` component fails but nothing else does | **Manage Profiles and Permission Sets** missing | Same table |
| A single component fails `Not available for deploy for this organization` | That *type* needs a feature switched on — `Bot` needs Einstein Bots, the `GenAi*` types need Agentforce | Enable the feature. If it persists on `Bot`, check `<type>`: classic `Bot` needs an Einstein Bots licence, Agentforce agents use `InternalCopilot` |
| `Expected source files for type 'GenAiFunction'` | `GenAiFunction` is a bundle type — it needs its own directory, not a bare `.genAiFunction-meta.xml` | `genAiFunctions/<Name>/<Name>.genAiFunction-meta.xml` |
| `Could not infer a metadata type` on an `__e` event | Platform events are CustomObjects in source format. A `platform_events/` directory with a `<CustomEventDefinition>` root is MDAPI shape and does not resolve | `objects/<Event>__e/<Event>__e.object-meta.xml` with `<CustomObject>`, fields split into `fields/` |
| A platform event field silently will not deploy | Platform events support only Checkbox, Date, Date/Time, Number, Text and Text Area (Long) — **Picklist is not supported** | Use Text and document the permitted values in the field description |

Two habits that catch most of the above before a push:

```bash
sf project convert source -d "$(mktemp -d)"   # resolves all source offline, no org contact
ruby -ryaml -e "YAML.load_file('.github/workflows/deploy-salesforce.yml')"
```
