/**
 * @file patient-monitor.ino
 * @brief Device type 1 of 2: patient vitals monitor.
 *
 * Reads a DHT11 and drives a servo (medication dispenser). Everything else -
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

// Raise this to ship a change. The pipeline publishes each version once and a
// board installs only a version it is not already running, so a change under
// the same number never reaches a board; the pull request checks fail it.
#define FIRMWARE_VERSION "2.2.0"

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
DHT dht(DHT_PIN, DHT11);
Servo dispenser;

void onCommand(JsonDocument& doc) {
  const char* op = doc["operation"] | doc["command"] | "";
  if (strcmp(op, "DISPENSE_MEDICATION") == 0) {
    Serial.println("dispensing");
    dispenser.write(90);
    delay(1000);
    dispenser.write(0);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  dht.begin();
  dispenser.attach(SERVO_PIN);
  dispenser.write(0);

  device.onCommand(onCommand);
  if (!device.begin()) return;   // provisioning mode; begin() reboots on success
}

void loop() {
  device.loop();
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
