/**
 * @file patient-monitor.ino
 * @brief The firmware of every board: patient monitors and ward indicators.
 *
 * Reads a DHT11 and drives a servo as a temperature alert: on a monitored
 * device the servo sweeps back and forth without stopping while its own DHT11
 * reads 30 C or more, and stops once a reading is below 30 C, decided on the
 * board from every reading, with no Case involved. The sensor can sit wherever
 * the temperature matters: against a patient (the demo puts it under an arm),
 * in a fridge, in a room. On a ward's internal board such as a
 * nurse-station indicator, it turns while any Case waits in the queue, faster as
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
#include "ServoSweep.h"
#include "ServoDemand.h"
#include "SensorPresence.h"

// Raise this to ship a change. The pipeline publishes each version once and a
// board installs only a version it is not already running, so a change under
// the same number never reaches a board; the pull request checks fail it.
#define FIRMWARE_VERSION "2.6.0"

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
// while the temperature is high instead of sweeping. A standard SG90 is positional
// (0-180) and physically cannot spin.
// #define CONTINUOUS_ROTATION_SERVO

DHT dht(DHT_PIN, DHT11);
Servo motor;
pm::SensorPresence sensor;

// Up to 2.4.0 the board kept a Case alert here. 2.5.0 follows its own
// sensor's temperature instead, so it clears what an older version left, once, at
// start: a stale "on" must not keep the motor turning. The library's
// namespaces are identity, wifi and config; this one was the sketch's own.
// Nothing else is kept: the sensor is read again within seconds, and
// Salesforce sends the queue's depth every time the board connects.
#define NVS_CASE_ALERT "caseAlert"
pm::ServoDemand demand;

// How often the board reads its DHT11 for the motor, between the readings it
// stores. The DHT11 answers at most once a second.
#define ROOM_CHECK_MS 5000
uint32_t lastRoomCheck = 0;
pm::ServoSweep sweep;

// Where the servo rests: arm home on a positional servo, standing still on a
// continuous one.
void park() {
#ifdef CONTINUOUS_ROTATION_SERVO
  motor.write(pm::CONTINUOUS_STOP);
#else
  motor.write(0);
#endif
}

void clearOldCaseAlert() {
  Preferences old;
  old.begin(NVS_CASE_ALERT, false);   // read-write creates the namespace, so no "not found" log
  if (old.isKey("active")) {
    old.clear();
    Serial.println("case alert: retired in 2.5.0, the motor follows the sensor's temperature");
  }
  old.end();
}

// Sets the servo going, faster or slower, or stops it, for what the
// temperature and the queue ask now.
void applyDemand() {
  uint32_t now = millis();
  if (demand.active()) {
    if (!sweep.active()) sweep.set(true, now);
    sweep.setPeriod(demand.sweepPeriodMs(), now);
  } else if (sweep.active()) {
    sweep.set(false, now);
  }
#ifdef CONTINUOUS_ROTATION_SERVO
  motor.write(demand.continuousWrite());
#else
  if (!demand.active()) park();
#endif
}

// A good reading of this board's DHT11: the motor turns from 30 C and stops
// below it. Said only when it changes.
void roomReading(float celsius) {
  bool hot = pm::roomIsHot(celsius);
  if (!demand.setRoomHot(hot)) return;
  applyDemand();
  Serial.printf("temperature %.1fC: %s\n", celsius, hot ? "30 C or more, motor turning"
                : demand.active() ? "below 30 C, motor turning for the queue" : "below 30 C, motor stopped");
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
                : demand.active() ? "motor turning for the temperature" : "motor stopped");

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
  if (angle >= 0) motor.write(angle);
#endif
}

// True once the command is carried out, false for an operation this sketch
// does not know: the library answers the command with that, done or refused.
bool onCommand(JsonDocument& doc) {
  const char* op = doc["operation"] | doc["command"] | "";
  // DISPENSE_MEDICATION was retired in 2.6.0: this is a temperature alert,
  // not a dispenser, so the board refuses it as an operation it does not know.
  if (strcmp(op, "CASE_ALERT") == 0) {
    // Retired in 2.5.0: the motor follows the sensor, not the Cases. Answered
    // as done, so an org that still sends it sees no failed command.
    Serial.println("case alert: ignored, the motor follows the sensor's temperature");
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
  motor.attach(SERVO_PIN);
  park();
  clearOldCaseAlert();

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
  // And a third, for the motor alone: the sensor every few seconds, so it
  // starts and stops within seconds of 30 C, not at the next stored reading.
  bool room = !sensor.missing() && millis() - lastRoomCheck >= ROOM_CHECK_MS;
  if (!store && !live && !room) return;

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
    lastRoomCheck = millis();
    // A failed read changes nothing: the motor keeps doing what the last
    // good reading said.
    if (ok) roomReading(t);
  }
  if (!store && !live) return;

  StaticJsonDocument<256> doc;   // room for what publishLive() adds
  doc["deviceId"] = device.thingName();
  if (ok) {
    doc["temperature"] = t;
    doc["humidity"]    = h;
  }

  if (store) {
    // Said on stored readings only: every 2 s it would bury the console.
    reportSensor(ok);
    // A sensor that stopped answering cannot say the temperature is still high.
    if (sensor.missing() && demand.setRoomHot(false)) {
      applyDemand();
      Serial.println("temperature: no sensor, motor stopped");
    }
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
