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
