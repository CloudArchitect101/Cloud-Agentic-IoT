/**
 * @file queue-indicator.ino
 * @brief Device type 2 of 2: physical Salesforce Case queue indicator.
 *
 * A servo that runs while open cases sit in a bound Salesforce queue and parks
 * when it empties. Which queue drives it is Salesforce custom metadata
 * (Device_Queue_Binding__mdt); this firmware only ever sees a 0-100 intensity.
 *
 * Identity, provisioning, WiFi and OTA come from CloudAgenticDevice - identical
 * to the patient monitor, because only the actuator differs.
 *
 * Build:
 *   arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 \
 *     --libraries firmware/libraries firmware/queue-indicator
 */

#include <CloudAgenticDevice.h>
#include <ESP32Servo.h>

CloudAgenticDevice device("queue-indicator", "2.0.0");

#define SERVO_PIN 5
// Uncomment for a continuous-rotation servo (FS90R / SG90-360). A standard
// SG90 is positional (0-180) and physically cannot spin, so it sweeps instead.
// #define CONTINUOUS_ROTATION_SERVO

Servo indicator;
int  queueIntensity = 0;
int  openCaseCount  = 0;
bool motorActive    = false;

int sweepAngle = 0, sweepDirection = 1;
unsigned long lastStep = 0;

unsigned long stepIntervalMs() {
  if (queueIntensity <= 0) return 0;
  const unsigned long slowest = 24, fastest = 3;
  return slowest - ((slowest - fastest) * queueIntensity / 100);
}

void onCommand(JsonDocument& doc) {
  const char* op = doc["operation"] | "";
  if (strcmp(op, "QUEUE_DEPTH") != 0 && !doc.containsKey("intensity")) return;

  openCaseCount  = doc["openCaseCount"] | 0;
  queueIntensity = constrain((int)(doc["intensity"] | 0), 0, 100);
  motorActive    = queueIntensity > 0;
  Serial.printf("queue: %d case(s), intensity %d%% -> %s\n",
                openCaseCount, queueIntensity, motorActive ? "RUNNING" : "STOPPED");

  if (!motorActive) {
    sweepAngle = 0;
#ifdef CONTINUOUS_ROTATION_SERVO
    indicator.write(90);   // neutral = stop
#else
    indicator.write(0);
#endif
  }
  StaticJsonDocument<200> status;
  status["deviceId"]      = device.thingName();
  status["openCaseCount"] = openCaseCount;
  status["intensity"]     = queueIntensity;
  device.publish("status", status);
}

void driveIndicator() {
  if (!motorActive) return;
#ifdef CONTINUOUS_ROTATION_SERVO
  indicator.write(90 + (queueIntensity * 90 / 100));
#else
  // Non-blocking: delay() here would stall MQTT and drop the connection.
  unsigned long interval = stepIntervalMs();
  if (interval == 0 || millis() - lastStep < interval) return;
  lastStep = millis();
  sweepAngle += sweepDirection;
  if (sweepAngle >= 180 || sweepAngle <= 0) {
    sweepDirection = -sweepDirection;
    sweepAngle = constrain(sweepAngle, 0, 180);
  }
  indicator.write(sweepAngle);
#endif
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  indicator.attach(SERVO_PIN);
  indicator.write(0);

  device.onCommand(onCommand);
  if (!device.begin()) return;
}

void loop() {
  device.loop();
  driveIndicator();
}
