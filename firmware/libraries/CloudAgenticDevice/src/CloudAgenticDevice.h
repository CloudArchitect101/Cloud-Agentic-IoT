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
#include "DeviceCommands.h"

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

  /** True once per live interval while connected and a LIVE window is open.
   *  The first is due at once after each LIVE command, not an interval later,
   *  so a card that has just opened is not kept waiting. Stored readings go on
   *  as before: telemetryDue() keeps its own schedule. */
  bool liveDue();

  /** True while a LIVE window is open, whether or not the board is online. */
  bool live() const { return _live.open(millis()); }

  /** Publish a live reading to device/<thing>/live: a plain MQTT topic, QoS 0,
   *  through the message broker rather than Basic Ingest, because a card
   *  subscribes to it and Basic Ingest reaches only rules. That is also why it
   *  flows only while someone watches: AWS bills it as messaging. Adds
   *  firmware (this version), rssi (Wi-Fi signal, dBm) and uptime (whole
   *  seconds since boot) to `doc` first. */
  bool publishLive(JsonDocument& doc);

  /** Register a handler for the commands on device/<thing>/command that the
   *  library does not handle itself (WIFI_UPDATE, SET_TELEMETRY_INTERVAL, LIVE
   *  and RESTART are the library's). It returns true once it has carried the
   *  command out, false when the operation is not one it knows. The library
   *  answers from that: done, or refused. Read what you need from `doc`
   *  before publishing anything: with ArduinoJson 6 its strings live in the
   *  MQTT client's buffer, which a publish reuses. */
  void onCommand(bool (*handler)(JsonDocument& doc));

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

  // Live mode is kept in RAM only, never NVS: a restart ends it, so a board
  // can never be left streaming for good, and flash is not worn by a setting
  // that changes every few minutes.
  cad::LiveWindow _live;

  // Reconnect pacing: 1 s, then random waits doubling up to 5 minutes.
  cad::Backoff _retry{1000, 300000, 1000};
  uint32_t _nextAttemptAt = 0;
  bool _waiting = false;

  Preferences _prefs;
  WiFiClientSecure _net;
  PubSubClient _mqtt;
  bool (*_commandHandler)(JsonDocument&) = nullptr;

  // The commands carried out lately, so that one arriving twice is answered
  // again rather than carried out again. RAM only: see DeviceCommands.h.
  cad::RecentCommands _recent;

  bool loadIdentity();
  void loadSettings();
  bool connectWiFi();
  void configureMqtt();
  bool connectAWS();
  void retryLater(const char* what);
  bool setTelemetryInterval(long seconds, const char* source);
  bool setLive(long seconds, long minutes);
  bool saveNetwork(const String& ssid, const String& pass);
  bool provisionFromSerial(bool hasIdentity);
  void checkSerialWifiUpdate();

  bool publishTo(const String& topic, const JsonDocument& doc);
  void handleMessage(char* topic, byte* payload, unsigned int len);
  cad::CommandResult carryOut(JsonDocument& doc, const char* operation, char* detail, size_t size);
  void finishCommand(const char* commandId, const char* operation, cad::CommandResult result,
                     const char* detail);
  void restart(const char* commandId);
  void handleJobDocument(byte* payload, unsigned int len);
  void handleConfigJob(const String& jobId, JsonObject jobDocument);
  void applyFirmware(const String& jobId, const String& url);
  void reportJobStatus(const String& jobId, const char* status, const String& detail);

  static CloudAgenticDevice* _instance;   // PubSubClient takes a C callback
  static void trampoline(char* t, byte* p, unsigned int l);
};
