# Migration Runbook: Single Account → Governed Dev/Prod

The capstone is not a bigger demo. It is the migration this system has to go through to become production-representative, written as the runbook I would hand a client.

## Starting state

Everything in one AWS account, one Salesforce Developer Edition org, deploys run from a laptop. This is how most proofs of concept actually look at the point someone asks "can we run this for real?"

## Target state

Two AWS accounts under an Organization (`iot-dev`, `iot-prod`) with IAM Identity Center SSO, two Salesforce orgs, and every deploy running through GitHub Actions with `Prod` behind a required reviewer.

## Phases

### Phase 1 — Establish the target, change nothing
Create the Organization, member accounts, and the second Salesforce org. **Free-tier note:** joining an AWS Organization instantly voids free-plan credits and converts the account to paid — so during the free build phase, Dev and Prod run as standalone free-plan accounts, and *this phase is deliberately deferred until go-live funding exists.* That makes this runbook's starting state literal, not hypothetical. Deploy nothing into them yet. The point is that the target exists and is reachable before anything depends on it.

**Rollback:** delete the accounts. Nothing references them.

### Phase 2 — Move Dev, keep the old account running
Point CI at `iot-dev`. Redeploy every stack. Run the full verification set: telemetry arrives, the queue indicator moves, the Slack command works, the agent takes an action.

**Rollback:** repoint CI at the original account. The old stacks were never deleted.

### Phase 3 — Stand up Prod, dual-run
Deploy to `iot-prod`. Both environments run in parallel against the same physical device fleet reporting to Dev only. Compare CloudWatch metrics for a week.

**Rollback:** stop promoting to Prod. Dev is unaffected.

### Phase 4 — Cut over the fleet
Reprovision devices with Prod certificates, in batches, starting with one. This is the irreversible-feeling step, which is exactly why it is batched and why OTA (chapter 09's saga) exists — a bad firmware push is recoverable, a bad certificate rotation on the whole fleet is not.

**Rollback:** devices retain their Dev certificates until explicitly revoked. Roll a batch back by reflashing.

### Phase 5 — Decommission
Only after Prod has run the fleet for two weeks. Delete the original account's stacks last, and take a final export first.

## What makes this a real migration story

- **Every phase has a rollback**, and the rollback is tested before the phase runs, not designed after it fails.
- **The irreversible step is isolated and batched** — certificate rotation is the one thing you cannot undo remotely.
- **Dual-run before cutover**, because "it deployed" and "it works" are different claims.
- **Decommission is a separate, delayed phase.** Deleting the old environment the same day you cut over removes your only rollback.

## Why this artefact matters

Migration engagements live or die on exactly this: a phased, reversible plan with the risk concentrated where it is visible, written so both engineers and stakeholders can follow it.
