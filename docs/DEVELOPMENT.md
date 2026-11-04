# Development: your laptop, then Dev, then Prod

Every change takes the same path. You prove it on your laptop and on a board on
your desk. A merge into `Dev` deploys it to the Dev environment and every Dev
board. A merge into `Prod` deploys it to production, with the firmware going to
a few canary boards first.

One rule holds this together: **the pipeline runs the same scripts you do.**
`scripts/check.sh` is the pull request check, `scripts/deploy-aws.sh` is the AWS
deploy step, and `scripts/firmware.sh` builds the binary the boards receive over
the air. A green run on your laptop predicts a green pipeline, and a red pipeline
reproduces on your laptop with one command.

```mermaid
flowchart LR
  subgraph laptop [Your laptop]
    A[Change] --> B[scripts/check.sh]
    B --> C[Flash a board over USB]
    B --> D[Deploy to Dev directly]
  end
  subgraph dev [Dev]
    E[Pull request into Dev: Checks] --> F[Merge: Deploy runs]
    F --> G[Dev AWS, Dev org, every Dev board]
  end
  subgraph prod [Prod]
    H[Pull request Dev into Prod: Checks] --> I[Merge, then your approval]
    I --> J[Prod AWS, Prod org, canary boards]
    J --> K[OTA promote: every Prod board]
  end
  C --> E
  D --> E
  G --> H
```

## The two environments

| | Dev | Prod |
|---|---|---|
| Branch | `Dev`, the default branch | `Prod`, changed only by pull requests from `Dev` |
| AWS | its own account | its own account |
| Salesforce | the Dev org | the Prod org |
| Boards | the ones on your desk, all in `fleet-<type>` | `canary-<type>` first, then `fleet-<type>` |
| Deployed by | the pipeline on merge, or you from your laptop | the pipeline on merge, after your approval |

Separate AWS accounts are not a nicety. Function and group names are fixed, so
two environments in one account would overwrite each other. Each account carries
a label, the SSM parameter `/cloud-agentic-iot/environment`, written by its first
deploy and checked by every deploy after that. The wrong `AWS_PROFILE` stops a
deploy before it changes anything.

While you're only trying the system, Dev can be an AWS project with a spend
limit that you deploy to from your laptop. [SANDBOX.md](SANDBOX.md) covers that
setup, and how to move to regular accounts when you want the pipelines.

## 1. On your laptop

Once, on top of the tools in [`SETUP.md`](SETUP.md):

```bash
scripts/firmware.sh setup     # the ESP32 core and the libraries the sketches use
pip install cfn-lint          # optional: without it, check.sh skips the template lint
brew install shellcheck       # optional: without it, check.sh skips the script lint
export AWS_PROFILE=iot-dev    # per shell, deliberately (SETUP.md, "Authorizing your local machine")
```

The Salesforce deploy runs as the deploy user, alias `iot-dev-deploy` (SETUP.md,
"The deploy user can actually deploy"), never as your admin user. An admin
deploy passes where the deploy user fails, so it would hide exactly the problems
the pipeline will hit.

The loop:

| Step | Command | What it tells you |
|---|---|---|
| Check | `scripts/check.sh` | The Lambda tests pass, every template lints, the scripts pass shellcheck, the Salesforce metadata resolves, and every sketch compiles. No credentials needed. |
| Flash | `scripts/firmware.sh flash patient-monitor` | Your working copy runs on a real board. It finds the USB port itself and keeps the board's Wi-Fi and certificate. |
| Watch | `scripts/firmware.sh monitor` | What the board prints on its serial console |
| Deploy AWS | `scripts/deploy-aws.sh Dev` | Every stack and the real Lambda code, in the Dev account |
| Deploy Salesforce | `scripts/deploy-salesforce.sh Dev` | A check-only deploy with every Apex test, then the deploy. Add `--dry-run` to validate only. |

Two things happen only in the pipeline, on purpose:

- **Prod.** The scripts refuse `Prod` from a laptop. Prod changes through a
  merge, checks on that exact commit, and your approval.
  `ALLOW_LOCAL_PROD=yes` exists for a genuine emergency.
- **Over-the-air releases.** Each version is published once per environment. If
  you published one from your laptop, the merged code under the same version
  could never be published, and the boards would keep the unreviewed build. To
  try firmware before merging, flash it over USB.

## 2. Dev: every merge deploys

Open a pull request into `Dev`. The **Checks** workflow runs the same parts as
`scripts/check.sh`, one job each, plus one more rule: if anything under
`firmware/` changed, `FIRMWARE_VERSION` must go up in every sketch it affects.
A change to the shared library affects them all.

Merge it, and **Deploy** runs on `Dev`:

1. **Checks**, again, on the merged commit.
2. **AWS.** It copies the Dev environment's secrets into SSM, deploys every
   stack, and uploads the real Lambda code.
3. **Salesforce.** A check-only deploy with every local Apex test, then the
   deploy, as the deploy user.
4. **Boards.** Every sketch whose version is not published yet is built,
   uploaded, and sent as an AWS IoT job to `fleet-<type>`, which is every Dev
   board.

A merge that leaves the versions alone, such as a Lambda fix or a docs edit,
sends no firmware anywhere. The published binary is the record that a version
shipped.

## 3. Prod: the same pipeline, two human checkpoints

Open a pull request from `Dev` into `Prod`, and the checks run. Merge it, and
Deploy runs on `Prod`, but the deploy job waits for **your approval** on the
Prod environment. Approve, and it deploys exactly what Dev ran, into the Prod
account and org, with new firmware going to `canary-<type>` only.

When the canary boards have run it long enough, run **OTA promote** from the
Actions tab on the `Prod` branch, giving the device type and the version. It
refuses unless that version's canary job finished with at least one board
updated and none that failed, refused it or timed out.

## Boards and groups

Each device type has two Thing Groups, created by
[`infra/ota/cloudformation.yaml`](../infra/ota/cloudformation.yaml):
`fleet-<type>` and, inside it, `canary-<type>`. A job sent to the fleet reaches
the canary boards too; they already run that version and report "already
current". A board is in one group or the other, never both:

```bash
scripts/ota.sh join Dev pm-desk-01 patient-monitor           # a Dev board: the fleet
scripts/ota.sh join Prod pm-ward-07 patient-monitor canary   # a Prod canary board
scripts/ota.sh status Prod                                   # the last five jobs, board by board
```

`scripts/setup-device.sh` puts a newly provisioned board in its fleet group.
Every sketch needs its pair of groups in that template, and `scripts/check.sh`
fails when one is missing.

## Turning it on

These are one-time GitHub settings, which the pipeline cannot make for itself:

1. **Branches.** Rename `main` to `Dev` and keep it as the default branch
   (Settings, Branches). GitHub redirects old links and moves open pull requests
   to the new name. Create `Prod` from `Dev` once the first Dev deploy is green.
2. **Environments** `Dev` and `Prod` (Settings, Environments), each with its own
   secrets and variables, listed in SETUP.md under "Secrets and variables, per
   environment". On `Prod`, add yourself as a required reviewer. On each one,
   limit deployment branches to the branch of the same name, so only `Prod`
   can use Prod's secrets.
3. **Branch rules** for `Dev` and `Prod`: require a pull request, and require
   the Checks jobs to pass (Lambda tests, CloudFormation templates, Shell
   scripts, Salesforce metadata, Firmware).
4. **The switch.** A push deploys only once the repository variable
   `AUTO_DEPLOY` names its branch:

   ```bash
   gh variable set AUTO_DEPLOY --body "Dev"        # once Dev's secrets are in
   gh variable set AUTO_DEPLOY --body "Dev Prod"   # once Prod's are too
   ```

   Until then, run Deploy by hand from the Actions tab, choosing the branch.
   A manual run can also deploy one part alone: aws, salesforce or firmware.

The first AWS deploy into a new account has to come from the pipeline, or have
its SSM parameters put by hand, because the stacks read the Salesforce settings
that the pipeline's seed step writes. `scripts/deploy-aws.sh` names any that
are missing before it deploys anything.

## What stays manual, and why

| Step | Why |
|---|---|
| A new board's first flash, over USB (`scripts/setup-device.sh`) | A blank ESP32 has no network stack. OTA works only once our firmware runs. |
| Approving a Prod deploy | It is the last look before production |
| Promoting a Prod release to the whole fleet | It is the judgement that the canary behaved |
| Entering secrets | Secret values never pass through automation or chat |
