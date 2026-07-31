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

// The sketch name MUST match this folder's name: it is sent in every OTA job
// document and checked by the device, so a job aimed at the wrong device type
// is refused rather than bricking the hardware.
CloudAgenticDevice device("patient-monitor", "2.0.0");

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

  static unsigned long last = 0;
  if (device.connected() && millis() - last > 30000) {
    last = millis();
    float h = dht.readHumidity(), t = dht.readTemperature();
    if (isnan(h) || isnan(t)) { Serial.println("DHT read failed"); return; }

    StaticJsonDocument<200> doc;
    doc["deviceId"]    = device.thingName();
    doc["temperature"] = t;
    doc["humidity"]    = h;
    device.publish("telemetry", doc);
    Serial.printf("telemetry: %.1fC %.0f%%\n", t, h);
  }
}
