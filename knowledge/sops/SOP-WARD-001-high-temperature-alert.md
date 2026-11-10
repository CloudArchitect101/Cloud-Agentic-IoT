---
id: SOP-WARD-001
title: High temperature alert
version: 2.0
owner: Ward charge nurse
reviewed: 2026-11-10
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies. The demo
> sensor is a DHT11, not a calibrated thermometer, and an alert is never a
> diagnosis.

## When this applies

A monitored device's temperature sensor reads 30.0 C or higher. The sensor
can sit wherever the temperature matters: against a patient, in a
medication fridge, in a room. The device's own motor starts turning at once
to tell whoever is near, and stops by itself when a reading is below
30.0 C. The system also opens a Case with Origin "Temperature Alert Rule" in
Care_Team_Queue on the device the first time it crosses 30.0 C. While the
temperature stays high, the reading is reported again
at most every 15 minutes, but no second Case opens while the first is open. The episode ends
only when the device reads below 29.0 C.

## Steps

1. Take the Case from Care_Team_Queue so the team can see someone has it.
2. Go to what the device monitors within 10 minutes: the person wearing the
   sensor, the fridge, or the room.
3. Recheck the temperature with a suitable instrument: a clinical
   thermometer for a person, the fridge's own display or a calibrated probe
   for a fridge, a room thermometer for a room. Record the recheck in the
   Case.
4. Ask the agent for the device's latest readings to confirm the trend. A
   single high reading next to normal ones can be the sensor itself: in
   direct sun, against a warm surface, or held in a hand. Move it and
   recheck.
5. If the recheck confirms a high temperature, tell the person in charge:
   the nurse looking after the patient, the pharmacy lead for a medication
   fridge, facilities for a room. Follow their process; this procedure does
   not replace it.
6. Close the Case once the device has read below 29.0 C for 15 minutes and
   the recheck is recorded. Note the lowest and highest readings in the
   Case.

## Fridges and stored medication

If the sensor is in a fridge or a store that held medication, check each
item's storage label. Anything that sat above its labelled range goes back
to pharmacy for review; do not use it until pharmacy clears it.

## Do not

- Do not silence the alert by turning off or unplugging the device.
- Do not treat the device's reading as a body temperature measurement.
- Do not open a second Case for the same episode: add to the open one.
