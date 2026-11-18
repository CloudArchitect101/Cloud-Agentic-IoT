---
id: SOP-WARD-005
title: Case alert motor acknowledgement
version: 1.1
owner: Ward charge nurse
reviewed: 2026-10-15
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## When this applies

A room's patient monitor sweeps its alert motor from 0 to 180 degrees and
back every 2 seconds. It does that while the room's device has at least one
open Case owned by Care_Team_Queue. The sweep is the room's visible "someone
needs to pick this up" signal.

## Steps

1. Open the Case from Care_Team_Queue. More than one open Case can keep the
   motor going; check the device's Cases.
2. Acknowledge by taking ownership: assign the Case to yourself. The motor
   stops when the last open queue-owned Case on that device is given to a
   person, closed or moved to another Asset.
3. Go to the room and follow the procedure for the Case's reason, for
   example SOP-WARD-001 for a room temperature Case.
4. If the motor keeps sweeping after every Case is owned by a person, the
   monitor did not get the change. Check it is online (SOP-WARD-003); when it
   reconnects, the system sends the current state again.

## Do not

- Do not stop the motor by unplugging the monitor: that also stops the
  room's readings.
- Do not hand a Case back to the queue to silence another room. Ask the
  charge nurse to reassign it.
