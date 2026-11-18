---
id: SOP-WARD-007
title: Using the Patient Care Agent
version: 1.0
owner: Nurse unit manager
reviewed: 2026-10-15
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## What the agent does

The Patient Care Agent reads what a room's device reports, finds the ward
procedure that applies, and opens a Case for the care team when a person
confirms it should. It acts as the person using it and sees only what that
person may see.

## Steps

1. Name the device by its serial number. If a patient has more than one
   device, say which one.
2. Ask what the device reports before asking what to do. The agent answers
   from stored readings only.
3. Ask which procedure applies. The agent quotes the procedure ID and
   version it used, for example SOP-WARD-001 v1.2; check that is the
   procedure you expected.
4. Confirm before it acts. The agent states the device and the reading it
   will escalate and waits for a yes.
5. Write the Case number it reports into your notes.

## Limits

- The procedures here are samples for the demo. Follow your own
  organisation's procedures where they differ.
- The agent does not diagnose, recommend treatment or change medication.
- If the agent cannot find a procedure, it says so. Ask the charge nurse.
