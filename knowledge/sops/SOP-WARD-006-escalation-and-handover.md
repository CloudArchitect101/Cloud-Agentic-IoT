---
id: SOP-WARD-006
title: Escalation and shift handover
version: 1.3
owner: Nurse unit manager
reviewed: 2026-10-15
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## Escalation levels

1. Level 1, the assigned nurse: any open Case in Care_Team_Queue. Respond
   within 10 minutes.
2. Level 2, the charge nurse: a Case not taken within 10 minutes, a room
   still out of range after its procedure's time limit, or two rooms with
   the same problem at once.
3. Level 3, the nurse unit manager and the on-call clinical engineer: a
   ward-wide problem, such as several monitors offline or the medication
   store out of range for more than an hour.

A patient who looks unwell is always a clinical call through the ward's own
deterioration process first. Device procedures never delay that.

## Asking the agent to escalate

The agent may open a Case for a device condition, but only after it has
read the device's latest readings and the user has confirmed which device
and which reading. It never diagnoses, and it never sends a dose.

## Handover

At every shift change, the outgoing nurse goes through each open Case the
ward owns with the incoming nurse:

1. The room and device serial number.
2. What happened, when, and the latest reading.
3. What was done, under which procedure ID.
4. What is still waiting and who has it.

Reassign each Case to the incoming nurse in Salesforce during handover. A
Case owned by someone who has gone home is a Case nobody is watching.
