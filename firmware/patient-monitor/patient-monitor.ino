/**
 * @file patient-monitor.ino
 * @brief Device type 1 of 2: patient vitals monitor.
 *
 * Reads a DHT11 and drives a servo: a medication dispenser that swings out a
 * dose (DISPENSE_MEDICATION), and sweeps back and forth without stopping while
 * a Case for this device waits in the care team queue (CASE_ALERT, sent by
 * Salesforce's CaseAlertService). Everything else -
 * NVS credentials, provisioning, WiFi, MQTT, and over-the-air updates - comes
 * from the shared CloudAgenticDevice library, so this file contains only what
 * makes THIS device type different.
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

// Raise this to ship a change. The pipeline publishes each version once and a
// board installs only a version it is not already running, so a change under
// the same number never reaches a board; the pull request checks fail it.
#define FIRMWARE_VERSION "2.3.0"

// Seconds between readings until the fleet sets its own. The fleet's value
// (scripts/ota.sh interval, or SET_TELEMETRY_INTERVAL through the device
// command API) is kept in NVS and wins over this from then on.
#define DEFAULT_TELEMETRY_SECONDS 30

// The sketch name MUST match this folder's name: it is sent in every OTA job
// document and checked by the device, so a job aimed at the wrong device type
// is refused rather than bricking the hardware.
CloudAgenticDevice device("patient-monitor", FIRMWARE_VERSION, DEFAULT_TELEMETRY_SECONDS);

#define DHT_PIN   4
#define SERVO_PIN 5
// Uncomment for a continuous-rotation servo (FS90R / SG90-360), as on the
// queue indicator: it spins while a Case waits instead of sweeping. A
// standard SG90 is positional (0-180) and physically cannot spin.
// #define CONTINUOUS_ROTATION_SERVO
#define CONTINUOUS_STOP  90    // a continuous servo stands still at 90
#define CONTINUOUS_SPIN  135   // and turns at about half speed here

DHT dht(DHT_PIN, DHT11);
Servo dispenser;

// The case alert, kept in NVS so the motor goes on turning after a restart
// or an update while the Case still waits. The library's namespaces are
// identity, wifi and config; this one is the sketch's own.
#define NVS_CASE_ALERT "caseAlert"
Preferences caseAlertStore;
pm::CaseAlertSweep caseAlert;

// Where the servo rests: arm home on a positional servo, standing still on a
// continuous one.
void park() {
#ifdef CONTINUOUS_ROTATION_SERVO
  dispenser.write(CONTINUOUS_STOP);
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

// Turns the case alert on or off. `save` is false when the state came from
// NVS: written only when it changes, since flash wears with every write.
void setCaseAlert(bool active, bool save) {
  if (!caseAlert.set(active, millis())) {
    Serial.printf("case alert: already %s\n", active ? "on" : "off");
    return;
  }
  if (save) {
    caseAlertStore.begin(NVS_CASE_ALERT, false);
    caseAlertStore.putBool("active", active);
    caseAlertStore.end();
  }
  Serial.printf("case alert: %s\n", active ? "on, motor turning" : "off, motor stopped");
#ifdef CONTINUOUS_ROTATION_SERVO
  dispenser.write(active ? CONTINUOUS_SPIN : CONTINUOUS_STOP);
#else
  if (!active) park();
#endif
}

// Called on every pass of loop(). Never waits: the angle comes from the clock.
void driveCaseAlert() {
#ifndef CONTINUOUS_ROTATION_SERVO
  int angle = caseAlert.next(millis());
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
  // Then the case alert, if it is on, carries on from 0, where the arm is.
  if (caseAlert.active()) {
    caseAlert.restart(millis());
#ifdef CONTINUOUS_ROTATION_SERVO
    dispenser.write(CONTINUOUS_SPIN);
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
  return false;
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
  driveCaseAlert();
  // Two schedules: the stored reading every telemetry interval, and while a
  // card is open in Salesforce a live one every few seconds (the library
  // keeps both). Ask both on every pass; either can fall due alone.
  bool store = device.telemetryDue();
  bool live  = device.liveDue();
  if (!store && !live) return;

  // One read serves both. Live mode's default of 2 s is as fast as it helps to
  // go: asked again sooner, the DHT library returns the reading it already has.
  float h = dht.readHumidity(), t = dht.readTemperature();
  bool ok = !isnan(h) && !isnan(t);

  StaticJsonDocument<256> doc;   // room for what publishLive() adds
  doc["deviceId"] = device.thingName();
  if (ok) {
    doc["temperature"] = t;
    doc["humidity"]    = h;
  }

  if (store) {
    if (ok) {
      device.publishTelemetry(doc);
      Serial.printf("telemetry: %.1fC %.0f%%\n", t, h);
    } else {
      // Said on stored readings only: every 2 s it would bury the console.
      Serial.println("DHT read failed");
    }
  }
  if (live) {
    // The card then says the board is up but its sensor is not reading,
    // rather than going quiet as if the board were offline.
    if (!ok) doc["sensorError"] = "DHT read failed";
    device.publishLive(doc);   // after publishTelemetry: it adds to doc
  }
}
