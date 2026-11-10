---
id: SOP-WARD-003
title: Room monitor offline
version: 1.1
owner: Clinical engineering
reviewed: 2026-10-15
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## When this applies

A room's device shows Connection Status "Offline" on its Asset, or the agent
reports that the newest stored reading is more than 5 minutes old. A monitor
reads every 30 seconds, so 5 minutes is ten missed readings. While a monitor
is offline, nothing about that room reaches the system: no temperature
Case, no high temperature alert. The device's own motor still follows its
sensor while it has power.

## Steps

1. Ask the agent for the device's connection status and last disconnect
   reason.
2. Check the room in person within 15 minutes. Until the monitor is back,
   the room is watched by people: note a manual check of the room in the
   patient's chart every hour.
3. Check the monitor has power: the board's light is on and the USB cable is
   seated. Do not unplug anything connected to the patient.
4. If the disconnect reason mentions Wi-Fi, check whether other rooms on the
   same network are also offline. Several rooms at once is a network
   problem: call the service desk and say which rooms.
5. If only this room is offline after a power check, open a Case for
   clinical engineering with the device's serial number and the time it went
   offline.

## Back online

When the monitor reconnects, the system sends an internal board the
queue's depth again. Confirm in the agent that new readings are arriving before
stopping the manual checks.
