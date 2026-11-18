---
id: SOP-WARD-004
title: Dispenser jam or dose command failed
version: 1.0
owner: Pharmacy lead
reviewed: 2026-10-15
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## When this applies

A Device Command with Command DISPENSE_MEDICATION ends in Status "Failed",
stays "Sent" for more than 5 minutes without being acknowledged, or the
nurse sees the dispenser's servo move without a dose coming out. A dose
command goes to exactly one room, and the room-temperature rule requests at
most one dose per device per hour.

## Steps

1. Do not send the command again straight away. A dose that did leave the
   dispenser but was not acknowledged would be given twice.
2. Go to the room. Look in the dispenser tray and the patient's area for the
   dose.
3. If the dose is found, give it only if it is clean and within its time
   window, record it as given, and note in the Device Command that the
   acknowledgement was lost.
4. If the dispenser is jammed, switch the dispenser to manual, do not force
   the servo, and give the dose from ward stock under the normal medication
   process.
5. Open a Case for clinical engineering with the device's serial number,
   the Device Command number and its Status Detail.
6. Tell the pharmacy lead about every failed dose command before the end of
   the shift.

## Do not

- Do not send a second dispense command for the same dose from Slack, the
  agent or a Flow.
- Do not take the dispenser apart on the ward.
