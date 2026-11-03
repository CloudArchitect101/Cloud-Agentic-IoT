#pragma once
/**
 * CloudAgenticDevice — the runtime every device type in this project shares.
 *
 * Two device types exist (patient monitor, queue indicator). They differ only
 * in what they sense and actuate. Identity, connectivity, provisioning and
 * over-the-air updates are identical, so they live here rather than being
 * copy-pasted into each sketch and drifting apart — which is exactly what had
 * happened: one sketch could be provisioned but not updated, the other could
 * be updated but not provisioned.
 *
 * Credentials live in NVS, never compiled in. That is what makes one binary
 * per device TYPE serve every device of that type, which is the precondition
 * for OTA working at all.
 */

#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include "DeviceTiming.h"

// Telemetry goes to AWS IoT Basic Ingest: straight into this rule, past the
// message broker, so AWS does not charge for it as messaging. At a million
// boards reading every 30 seconds that is about 86 billion messages a month.
// It MUST equal RuleName in lambda/patient-vitals/cloudformation.yaml, and the
// device policy in lambda/queue-relay/cloudformation.yaml must allow publishing
// under it; test/firmware/contract.test.js fails the build if either drifts.
#define TELEMETRY_RULE "cloud_agentic_iot_patient_vitals"

class CloudAgenticDevice {
public:
  /**
   * @param sketchName  MUST match the firmware/<dir> name. It is checked
   *                    against every OTA job document: pushing queue-indicator
   *                    firmware to a patient monitor would brick it (different
   *                    pins, different logic), so a device refuses any image
   *                    not built for it.
   * @param version     Semantic version, compared against the job to avoid
   *                    re-flashing an image the device already runs.
   * @param defaultTelemetrySeconds
   *                    Seconds between readings until the fleet sets its own
   *                    with SET_TELEMETRY_INTERVAL, which is kept in NVS.
   */
  CloudAgenticDevice(const char* sketchName, const char* version,
                     uint32_t defaultTelemetrySeconds = 30);

  /** Loads NVS identity, or enters serial provisioning if there is none.
   *  Returns false when the device is provisioning (caller should return). */
  bool begin();

  /** Call from loop(): keeps MQTT alive, handles serial wifi updates, and
   *  reconnects. Never blocks waiting for the network: between attempts it
   *  returns at once, so the sketch keeps running while the board is offline. */
  void loop();

  /** Publish JSON to a device-scoped topic, e.g. "status" ->
   *  device/<thing>/status */
  bool publish(const char* subTopic, const JsonDocument& doc);

  /** Publish a reading to the patient-vitals rule through Basic Ingest:
   *  $aws/rules/<TELEMETRY_RULE>/device/<thing>/telemetry. The rule sees the
   *  topic without the prefix, so it reads it exactly as device/<thing>/telemetry. */
  bool publishTelemetry(const JsonDocument& doc);

  /** True once per telemetry interval while connected. The first comes at a
   *  random point inside the first interval: boards that power up together, a
   *  ward after a power cut, would otherwise report in lockstep for good. */
  bool telemetryDue();

  uint32_t telemetrySeconds() const { return _telemetrySeconds; }

  /** Register a handler for commands on device/<thing>/command. */
  void onCommand(void (*handler)(JsonDocument& doc));

  const String& thingName() const { return _thingName; }
  bool connected() { return _mqtt.connected(); }

private:
  const char* _sketch;
  const char* _version;
  String _thingName, _endpoint, _cert, _key;

  bool _haveIdentity = false;
  uint32_t _telemetrySeconds;
  bool _telemetryScheduled = false;
  uint32_t _nextTelemetryAt = 0;

  // Reconnect pacing: 1 s, then random waits doubling up to 5 minutes.
  cad::Backoff _retry{1000, 300000, 1000};
  uint32_t _nextAttemptAt = 0;
  bool _waiting = false;

  Preferences _prefs;
  WiFiClientSecure _net;
  PubSubClient _mqtt;
  void (*_commandHandler)(JsonDocument&) = nullptr;

  bool loadIdentity();
  void loadSettings();
  bool connectWiFi();
  void configureMqtt();
  bool connectAWS();
  void retryLater(const char* what);
  bool setTelemetryInterval(long seconds, const char* source);
  void saveNetwork(const String& ssid, const String& pass);
  bool provisionFromSerial(bool hasIdentity);
  void checkSerialWifiUpdate();

  bool publishTo(const String& topic, const JsonDocument& doc);
  void handleMessage(char* topic, byte* payload, unsigned int len);
  void handleJobDocument(byte* payload, unsigned int len);
  void handleConfigJob(const String& jobId, JsonObject jobDocument);
  void applyFirmware(const String& jobId, const String& url);
  void reportJobStatus(const String& jobId, const char* status, const String& detail);

  static CloudAgenticDevice* _instance;   // PubSubClient takes a C callback
  static void trampoline(char* t, byte* p, unsigned int l);
};
