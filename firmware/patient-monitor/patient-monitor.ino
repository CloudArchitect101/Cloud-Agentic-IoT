/**
 * @file patient-monitor.ino
 * @brief The firmware of every board: patient monitors and ward indicators.
 *
 * Reads a DHT11 and drives a servo: a medication dispenser that swings out a
 * dose (DISPENSE_MEDICATION); sweeps back and forth without stopping while a
 * Case for this device waits in the care team queue (CASE_ALERT, sent by
 * Salesforce's CaseAlertService); and, on a ward's internal board such as a
 * nurse-station indicator, turns while any Case waits in the queue, faster as
 * it fills (QUEUE_DEPTH, sent by CaseQueueMonitorService). Which of these a
 * board is told depends on its Asset's record type in Salesforce, not on its
 * firmware, so one OTA build serves every board. A board without a DHT11, as
 * an internal one is, says so once and sends no readings.
 *
 * Everything else - NVS credentials, provisioning, WiFi, MQTT, and
 * over-the-air updates - comes from the shared CloudAgenticDevice library, so
 * this file contains only what the boards do.
 *
 * Build:
 *   arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 \
 *     --libraries firmware/libraries firmware/patient-monitor
 */

#include <CloudAgenticDevice.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include "CaseAlertSweep.h"
#include "ServoDemand.h"
#include "SensorPresence.h"

// Raise this to ship a change. The pipeline publishes each version once and a
// board installs only a version it is not already running, so a change under
// the same number never reaches a board; the pull request checks fail it.
#define FIRMWARE_VERSION "2.4.0"

// Seconds between readings until the fleet sets its own. The fleet's value
// (scripts/ota.sh interval, or SET_TELEMETRY_INTERVAL through the device
// command API) is kept in NVS and wins over this from then on.
#define DEFAULT_TELEMETRY_SECONDS 30

// The sketch name MUST match this folder's name: it is sent in every OTA job
// document and checked by the device, so a job aimed at the wrong device type
// is refused rather than bricking the hardware. Every board in the field runs
// "patient-monitor", internal ones included, so it stays this name: a board
// refuses a build under any other.
CloudAgenticDevice device("patient-monitor", FIRMWARE_VERSION, DEFAULT_TELEMETRY_SECONDS);

#define DHT_PIN   4
#define SERVO_PIN 5
// Uncomment for a continuous-rotation servo (FS90R / SG90-360): it spins
// while a Case waits instead of sweeping. A standard SG90 is positional
// (0-180) and physically cannot spin.
// #define CONTINUOUS_ROTATION_SERVO

DHT dht(DHT_PIN, DHT11);
Servo dispenser;
pm::SensorPresence sensor;

// The case alert, kept in NVS so the motor goes on turning after a restart
// or an update while the Case still waits. The library's namespaces are
// identity, wifi and config; this one is the sketch's own. The queue's depth
// is not kept: Salesforce sends it again every time the board connects.
#define NVS_CASE_ALERT "caseAlert"
Preferences caseAlertStore;
pm::ServoDemand demand;
pm::CaseAlertSweep sweep;

// Where the servo rests: arm home on a positional servo, standing still on a
// continuous one.
void park() {
#ifdef CONTINUOUS_ROTATION_SERVO
  dispenser.write(pm::CONTINUOUS_STOP);
#else
  dispenser.write(0);
#endif
}

bool storedCaseAlert() {
  caseAlertStore.begin(NVS_CASE_ALERT, false);   // read-write creates the namespace, so no "not found" log
  bool active = caseAlertStore.getBool("active", false);
  caseAlertStore.end();
  return active;
}

// Sets the servo going, faster or slower, or stops it, for what the case
// alert and the queue ask now.
void applyDemand() {
  uint32_t now = millis();
  if (demand.active()) {
    if (!sweep.active()) sweep.set(true, now);
    sweep.setPeriod(demand.sweepPeriodMs(), now);
  } else if (sweep.active()) {
    sweep.set(false, now);
  }
#ifdef CONTINUOUS_ROTATION_SERVO
  dispenser.write(demand.continuousWrite());
#else
  if (!demand.active()) park();
#endif
}

// Turns the case alert on or off. `save` is false when the state came from
// NVS: written only when it changes, since flash wears with every write.
void setCaseAlert(bool active, bool save) {
  if (!demand.setCaseAlert(active)) {
    Serial.printf("case alert: already %s\n", active ? "on" : "off");
    return;
  }
  if (save) {
    caseAlertStore.begin(NVS_CASE_ALERT, false);
    caseAlertStore.putBool("active", active);
    caseAlertStore.end();
  }
  applyDemand();
  Serial.printf("case alert: %s\n", active ? "on, motor turning"
                : demand.active() ? "off, motor turning for the queue" : "off, motor stopped");
}

// QUEUE_DEPTH: how many Cases wait in the queue this board follows, and how
// fast to turn for them (0 stops it). The queue-depth API sends no commandId,
// so nothing answers it.
void setQueue(JsonDocument& doc) {
  long intensity = doc["intensity"] | 0L;
  long openCases = doc["openCaseCount"] | 0L;
  bool changed = demand.setQueue(intensity, openCases);
  if (changed) applyDemand();
  Serial.printf("queue: %d case(s), intensity %d%% -> %s\n", demand.openCases(), demand.queueIntensity(),
                demand.queueIntensity() > 0 ? "motor turning"
                : demand.active() ? "motor turning for the case alert" : "motor stopped");

  StaticJsonDocument<200> status;
  status["deviceId"]      = device.thingName();
  status["openCaseCount"] = demand.openCases();
  status["intensity"]     = demand.queueIntensity();
  device.publish("status", status);
}

// Called on every pass of loop(). Never waits: the angle comes from the clock.
void driveServo() {
#ifndef CONTINUOUS_ROTATION_SERVO
  int angle = sweep.next(millis());
  if (angle >= 0) dispenser.write(angle);
#endif
}

void dispense() {
  Serial.println("dispensing");
  dispenser.write(90);
  delay(1000);
  dispenser.write(0);
  // Done means the dose is out and the arm is home again, so a dose sent
  // right behind this one starts from 0, not from halfway back. A hobby
  // servo turns 90 degrees in well under half a second.
  delay(500);
  // Then the sweep, if anything asks for it, carries on from 0, where the arm is.
  if (demand.active()) {
    sweep.restart(millis());
#ifdef CONTINUOUS_ROTATION_SERVO
    dispenser.write(demand.continuousWrite());
#endif
  } else {
    park();
  }
}

// True once the command is carried out, false for an operation this sketch
// does not know: the library answers the command with that, done or refused.
bool onCommand(JsonDocument& doc) {
  const char* op = doc["operation"] | doc["command"] | "";
  if (strcmp(op, "DISPENSE_MEDICATION") == 0) {
    dispense();
    return true;
  }
  if (strcmp(op, "CASE_ALERT") == 0) {
    // active is true or false; anything else is refused, and the motor stays
    // as it was. A repeat (Salesforce sends the state again when the board
    // reconnects) changes nothing and is still done.
    if (!doc["active"].is<bool>()) {
      Serial.println("case alert: refused, active must be true or false");
      return false;
    }
    setCaseAlert(doc["active"].as<bool>(), true);
    return true;
  }
  if (strcmp(op, "QUEUE_DEPTH") == 0) {
    setQueue(doc);
    return true;
  }
  return false;
}

// What to say about one stored reading's sensor read. Live reads say nothing.
void reportSensor(bool ok) {
  switch (sensor.report(ok)) {
    case pm::SensorPresence::FAILED:
      Serial.println("DHT read failed");
      break;
    case pm::SensorPresence::NONE:
      Serial.println("DHT11: no sensor answers, so this board sends no readings (normal on a ward board)");
      break;
    case pm::SensorPresence::STOPPED:
      Serial.println("DHT11: stopped answering, no readings until it does");
      break;
    case pm::SensorPresence::BACK:
      Serial.println("DHT11: answering again, readings on");
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  dht.begin();
  dispenser.attach(SERVO_PIN);
  park();
  // A Case that was waiting before a restart or an update still is, as far
  // as this board knows, so the motor turns again before it reconnects.
  // Salesforce sends the state again once it is online.
  if (storedCaseAlert()) setCaseAlert(true, false);

  device.onCommand(onCommand);
  if (!device.begin()) return;   // provisioning mode; begin() reboots on success
}

void loop() {
  device.loop();
  driveServo();
  // Two schedules: the stored reading every telemetry interval, and while a
  // card is open in Salesforce a live one every few seconds (the library
  // keeps both). Ask both on every pass; either can fall due alone.
  bool store = device.telemetryDue();
  bool live  = device.liveDue();
  if (!store && !live) return;

  // One read serves both. Live mode's default of 2 s is as fast as it helps to
  // go: asked again sooner, the DHT library returns the reading it already has.
  // With no sensor there, only a stored reading tries again, to notice one
  // being plugged in; live readings just say so.
  bool ok = false;
  float h = NAN, t = NAN;
  if (store || !sensor.missing()) {
    h = dht.readHumidity();
    t = dht.readTemperature();
    ok = !isnan(h) && !isnan(t);
  }

  StaticJsonDocument<256> doc;   // room for what publishLive() adds
  doc["deviceId"] = device.thingName();
  if (ok) {
    doc["temperature"] = t;
    doc["humidity"]    = h;
  }

  if (store) {
    // Said on stored readings only: every 2 s it would bury the console.
    reportSensor(ok);
    if (ok) {
      device.publishTelemetry(doc);
      Serial.printf("telemetry: %.1fC %.0f%%\n", t, h);
    }
  }
  if (live) {
    // The card then says the board is up but its sensor is not reading,
    // rather than going quiet as if the board were offline.
    if (!ok) doc["sensorError"] = sensor.missing() ? "no sensor" : "DHT read failed";
    device.publishLive(doc);   // after publishTelemetry: it adds to doc
  }
}
