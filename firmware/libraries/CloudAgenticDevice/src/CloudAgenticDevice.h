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
   */
  CloudAgenticDevice(const char* sketchName, const char* version);

  /** Loads NVS identity, or enters serial provisioning if there is none.
   *  Returns false when the device is provisioning (caller should return). */
  bool begin();

  /** Call from loop(): keeps MQTT alive, handles serial wifi updates,
   *  and reconnects. */
  void loop();

  /** Publish JSON to a device-scoped topic, e.g. "telemetry" ->
   *  device/<thing>/telemetry */
  bool publish(const char* subTopic, const JsonDocument& doc);

  /** Register a handler for commands on device/<thing>/command. */
  void onCommand(void (*handler)(JsonDocument& doc));

  const String& thingName() const { return _thingName; }
  bool connected() { return _mqtt.connected(); }

private:
  const char* _sketch;
  const char* _version;
  String _thingName, _endpoint, _cert, _key;

  Preferences _prefs;
  WiFiClientSecure _net;
  PubSubClient _mqtt;
  void (*_commandHandler)(JsonDocument&) = nullptr;

  bool loadIdentity();
  bool connectWiFi();
  void connectAWS();
  void saveNetwork(const String& ssid, const String& pass);
  bool provisionFromSerial(bool hasIdentity);
  void checkSerialWifiUpdate();

  void handleMessage(char* topic, byte* payload, unsigned int len);
  void handleJobDocument(byte* payload, unsigned int len);
  void applyFirmware(const String& jobId, const String& url);
  void reportJobStatus(const String& jobId, const char* status, const String& detail);

  static CloudAgenticDevice* _instance;   // PubSubClient takes a C callback
  static void trampoline(char* t, byte* p, unsigned int l);
};
