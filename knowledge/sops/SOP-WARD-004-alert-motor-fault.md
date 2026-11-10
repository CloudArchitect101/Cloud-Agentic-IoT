---
id: SOP-WARD-004
title: Alert motor not turning or not stopping
version: 2.0
owner: Clinical engineering
reviewed: 2026-11-10
---

> Sample procedure for the Smart Ward demo. Fictional, not clinical advice,
> and not a substitute for your organisation's own policies.

## When this applies

A monitored device's alert motor does not do what its temperature says: it
stays still while a high temperature Case is open and the agent shows
readings of 30.0 C or more, or it keeps turning after readings are below
30.0 C. The motor is decided on the device itself, from its own sensor
every few seconds, so a fault is in the device, its sensor or its wiring,
not in Salesforce.

## Steps

1. Do not rely on the motor while it is faulty: until it is fixed, check
   what the device monitors in person, as SOP-WARD-001 says, at least every
   hour.
2. Ask the agent for the device's latest readings and connection status. An
   offline device follows SOP-WARD-003 instead.
3. If the readings are normal and the motor still turns, or high and it
   stays still, restart the device from its Asset (Send Command, RESTART)
   and watch it for two minutes.
4. If that does not fix it, check the servo's cable is seated. Do not force
   the motor's arm by hand.
5. Open a Case for clinical engineering with the device's serial number, its
   firmware version and what the motor did.

## Do not

- Do not take the device apart on the ward.
- Do not unplug the device to stop the motor: that also stops its readings.
