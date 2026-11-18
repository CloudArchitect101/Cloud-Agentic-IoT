---
id: SOP-WARD-001
title: Room temperature excursion
version: 1.2
owner: Ward charge nurse
reviewed: 2026-10-15
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## When this applies

A patient room's monitor reads 30.0 C or higher. The system opens a Case
with Origin "Room Temperature Rule" in Care_Team_Queue on the room's device
the first time it crosses 30.0 C. While the room stays hot, the reading is
reported again at most every 15 minutes, but no second Case opens while the
first is open. The episode ends only when the room reads below 29.0 C.

## Steps

1. Take the Case from Care_Team_Queue so the room's alert motor stops
   (SOP-WARD-005) and the team can see someone has it.
2. Go to the room within 10 minutes. Check the patient first, then the room:
   closed window blinds in direct sun, a blocked air vent, a space heater,
   equipment venting into the room.
3. Ask the agent for the device's latest readings to confirm the trend. A
   single reading of 30 C or more next to normal readings can be a sensor
   in direct sunlight; move the sensor away from the window and recheck.
4. If the cause is found and fixed, record it in the Case and leave the Case
   open until the room reads below 29.0 C.
5. If the room is still at or above 30.0 C after 30 minutes, call facilities
   on the ward's facilities line and escalate under SOP-WARD-006.
6. Close the Case once the room has read below 29.0 C for 15 minutes. Note
   the lowest and highest readings in the Case.

## Medication in the room

If the room held medication during the excursion, check its storage label.
Anything labelled "store below 25 C" or "refrigerate" that sat in the room
goes back to pharmacy for review; do not give it until pharmacy clears it.

## Do not

- Do not silence the room's alert by turning off the monitor.
- Do not open a second Case for the same episode: add to the open one.
