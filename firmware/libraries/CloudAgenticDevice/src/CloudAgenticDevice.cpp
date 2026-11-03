#include "CloudAgenticDevice.h"

// esp_random() moved headers between ESP-IDF 4 (Arduino core 2.x) and 5 (3.x).
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#else
#include <esp_system.h>
#endif

#define NVS_IDENTITY "identity"
#define NVS_WIFI     "wifi"
#define NVS_CONFIG   "config"
#define WIFI_SLOTS   3
#define WIFI_ATTEMPT_MS 15000

// Amazon Root CA 1 is identical for every device in every account, so unlike
// per-device material it is fine to compile in. It is public: the same file is
// published at https://www.amazontrust.com/repository/AmazonRootCA1.pem
// (SHA-256 fingerprint 8E:CD:E6:88:4F:3D:87:B1:12:5B:A3:1A:C3:FC:B1:3D:
// 70:16:DE:7F:57:CC:90:4F:E1:CB:97:C6:AE:98:19:6E). It also signs the S3
// certificate, which is why the OTA download below can use it too.
static const char AWS_ROOT_CA[] = R"EOF_CA(
-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----
)EOF_CA";

CloudAgenticDevice* CloudAgenticDevice::_instance = nullptr;

CloudAgenticDevice::CloudAgenticDevice(const char* sketchName, const char* version,
                                       uint32_t defaultTelemetrySeconds)
  : _sketch(sketchName), _version(version), _telemetrySeconds(defaultTelemetrySeconds), _mqtt(_net) {
  _instance = this;
}

void CloudAgenticDevice::trampoline(char* t, byte* p, unsigned int l) {
  if (_instance) _instance->handleMessage(t, p, l);
}

/* ------------------------------------------------------------- identity */

bool CloudAgenticDevice::loadIdentity() {
  _prefs.begin(NVS_IDENTITY, true);
  _thingName = _prefs.getString("thingName", "");
  _endpoint  = _prefs.getString("endpoint", "");
  _cert      = _prefs.getString("cert", "");
  _key       = _prefs.getString("key", "");
  _prefs.end();
  _haveIdentity = _thingName.length() && _endpoint.length() && _cert.length() && _key.length();
  return _haveIdentity;
}

/* ------------------------------------------------------------- settings */

// Settings the fleet changes at run time, kept apart from identity and Wi-Fi.
void CloudAgenticDevice::loadSettings() {
  _prefs.begin(NVS_CONFIG, false);   // read-write creates the namespace, so no "not found" log on a new board
  uint32_t stored = _prefs.getUInt("telemetrySec", 0);
  _prefs.end();
  if (cad::validTelemetrySeconds(stored)) _telemetrySeconds = stored;
  Serial.printf("telemetry: every %lu s\n", (unsigned long)_telemetrySeconds);
}

bool CloudAgenticDevice::setTelemetryInterval(long seconds, const char* source) {
  if (!cad::validTelemetrySeconds(seconds)) {
    Serial.printf("telemetry: %ld s from %s refused, allowed %lu-%lu\n", seconds, source,
                  (unsigned long)cad::MIN_TELEMETRY_SECONDS, (unsigned long)cad::MAX_TELEMETRY_SECONDS);
    return false;
  }
  if ((uint32_t)seconds != _telemetrySeconds) {
    // Written only when it changes: flash wears out with every write.
    _prefs.begin(NVS_CONFIG, false);
    _prefs.putUInt("telemetrySec", (uint32_t)seconds);
    _prefs.end();
    _telemetrySeconds = (uint32_t)seconds;
    _telemetryScheduled = false;   // spread again from now, at the new pace
  }
  Serial.printf("telemetry: every %ld s, set by %s\n", seconds, source);
  return true;
}

bool CloudAgenticDevice::telemetryDue() {
  if (!_mqtt.connected()) return false;
  uint32_t now = millis();
  uint32_t interval = _telemetrySeconds * 1000UL;
  if (!_telemetryScheduled) {
    _nextTelemetryAt = now + cad::between(0, interval, esp_random());
    _telemetryScheduled = true;
    return false;
  }
  if (!cad::due(now, _nextTelemetryAt, interval)) return false;
  // From now, not from the missed slot: a board back from an outage sends one
  // reading, not a burst of every one it missed.
  _nextTelemetryAt = now + interval;
  return true;
}

/* ----------------------------------------------------------------- wifi */

void CloudAgenticDevice::saveNetwork(const String& ssid, const String& pass) {
  if (!ssid.length()) return;
  _prefs.begin(NVS_WIFI, false);
  int count = _prefs.getInt("count", 0);
  int slot = -1;
  for (int i = 0; i < count && i < WIFI_SLOTS; i++) {
    if (_prefs.getString(("s" + String(i)).c_str(), "") == ssid) { slot = i; break; }
  }
  if (slot < 0) {
    slot = (count < WIFI_SLOTS) ? count : (WIFI_SLOTS - 1);
    if (count < WIFI_SLOTS) _prefs.putInt("count", count + 1);
  }
  _prefs.putString(("s" + String(slot)).c_str(), ssid);
  _prefs.putString(("p" + String(slot)).c_str(), pass);
  _prefs.end();
  Serial.printf("wifi: stored '%s' in slot %d\n", ssid.c_str(), slot);
}

bool CloudAgenticDevice::connectWiFi() {
  _prefs.begin(NVS_WIFI, true);
  int count = _prefs.getInt("count", 0);
  for (int i = 0; i < count; i++) {
    String ssid = _prefs.getString(("s" + String(i)).c_str(), "");
    String pass = _prefs.getString(("p" + String(i)).c_str(), "");
    if (!ssid.length()) continue;
    Serial.printf("wifi: trying '%s'\n", ssid.c_str());
    WiFi.begin(ssid.c_str(), pass.c_str());
    unsigned long deadline = millis() + WIFI_ATTEMPT_MS;
    while (WiFi.status() != WL_CONNECTED && millis() < deadline) { delay(250); Serial.print("."); }
    if (WiFi.status() == WL_CONNECTED) {
      _prefs.end();
      Serial.printf("\nwifi: connected to '%s', ip %s\n", ssid.c_str(), WiFi.localIP().toString().c_str());
      return true;
    }
    Serial.println("\nwifi: failed, next candidate");
    WiFi.disconnect();
  }
  _prefs.end();
  return false;
}

/* --------------------------------------------------------- provisioning */

bool CloudAgenticDevice::provisionFromSerial(bool hasIdentity) {
  Serial.println();
  Serial.println(hasIdentity
    ? "WIFI RECOVERY MODE - paste {\"ssid\":...,\"passphrase\":...} and press Enter:"
    : "PROVISIONING MODE - paste the provisioning bundle and press Enter:");

  unsigned long deadline = millis() + 120000;
  String line;
  while (millis() < deadline) {
    if (Serial.available()) { line = Serial.readStringUntil('\n'); line.trim(); if (line.length()) break; }
    delay(50);
  }
  if (!line.length()) { Serial.println("timed out"); return false; }

  StaticJsonDocument<6144> doc;
  if (deserializeJson(doc, line)) { Serial.println("not valid JSON"); return false; }

  saveNetwork(doc["ssid"] | "", doc["passphrase"] | "");

  if (!hasIdentity) {
    _prefs.begin(NVS_IDENTITY, false);
    _prefs.putString("thingName", doc["thingName"] | "");
    _prefs.putString("endpoint",  doc["endpoint"]  | "");
    _prefs.putString("cert",      doc["certificatePem"] | "");
    _prefs.putString("key",       doc["privateKey"] | "");
    _prefs.end();
    Serial.println("identity stored (write-once)");
  } else {
    Serial.println("identity left untouched");
  }
  Serial.println("restarting");
  delay(300);
  ESP.restart();
  return true;
}

void CloudAgenticDevice::checkSerialWifiUpdate() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (!line.length()) return;
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, line)) { Serial.println("wifi: not valid JSON, ignored"); return; }
  if (!doc.containsKey("ssid")) { Serial.println("wifi: no 'ssid' field, ignored"); return; }
  saveNetwork(doc["ssid"] | "", doc["passphrase"] | "");
  Serial.println("wifi: updated over serial - identity and certificate untouched");
  // Someone is at the board: try the new network now, not after the backoff.
  _waiting = false;
  _retry.reset();
}

/* ------------------------------------------------------------------ OTA */

void CloudAgenticDevice::reportJobStatus(const String& jobId, const char* status, const String& detail) {
  String topic = "$aws/things/" + _thingName + "/jobs/" + jobId + "/update";
  StaticJsonDocument<256> doc;
  doc["status"] = status;
  if (detail.length()) doc["statusDetails"]["detail"] = detail;
  char buf[256];
  serializeJson(doc, buf);
  _mqtt.publish(topic.c_str(), buf);
}

void CloudAgenticDevice::applyFirmware(const String& jobId, const String& url) {
  Serial.printf("OTA: downloading %s\n", url.c_str());
  reportJobStatus(jobId, "IN_PROGRESS", "downloading");

  WiFiClientSecure otaClient;
  otaClient.setCACert(AWS_ROOT_CA);
  HTTPClient http;
  if (!http.begin(otaClient, url)) { reportJobStatus(jobId, "FAILED", "http begin failed"); return; }

  int code = http.GET();
  if (code != HTTP_CODE_OK) { reportJobStatus(jobId, "FAILED", "http " + String(code)); http.end(); return; }

  int len = http.getSize();
  if (len <= 0 || !Update.begin(len)) { reportJobStatus(jobId, "FAILED", "insufficient space"); http.end(); return; }

  size_t written = Update.writeStream(http.getStream());
  http.end();
  if (written != (size_t)len || !Update.end(true)) {
    reportJobStatus(jobId, "FAILED", "write incomplete");
    Update.abort();
    return;
  }
  // Report before rebooting: after ESP.restart() there is no chance to speak.
  reportJobStatus(jobId, "SUCCEEDED", "rebooting");
  _mqtt.loop();
  delay(500);
  Serial.println("OTA: complete, restarting");
  ESP.restart();
}

void CloudAgenticDevice::handleJobDocument(byte* payload, unsigned int length) {
  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, payload, length)) { Serial.println("OTA: malformed job document"); return; }

  JsonObject execution = doc["execution"];
  if (execution.isNull()) return;   // notify-next with nothing pending

  String jobId  = execution["jobId"].as<String>();
  JsonObject jobDocument = execution["jobDocument"];
  if (strcmp(jobDocument["operation"] | "", "SET_TELEMETRY_INTERVAL") == 0) {
    handleConfigJob(jobId, jobDocument);
    return;
  }

  String url    = execution["jobDocument"]["url"].as<String>();
  String ver    = execution["jobDocument"]["version"].as<String>();
  String sketch = execution["jobDocument"]["sketch"].as<String>();

  // The safety check that matters most. Device types have different pins and
  // different logic; flashing a queue indicator with patient-monitor firmware
  // bricks it, and a bricked device cannot be fixed over the air. Thing Group
  // targeting should prevent this, but a mis-targeted job must not be able to
  // destroy hardware - so the device refuses anything not built for it.
  if (sketch.length() && sketch != String(_sketch)) {
    Serial.printf("OTA: REFUSED - job is for '%s', this device runs '%s'\n", sketch.c_str(), _sketch);
    reportJobStatus(jobId, "REJECTED", "wrong sketch for this device type");
    return;
  }
  if (ver == String(_version)) {
    Serial.println("OTA: already on this version");
    reportJobStatus(jobId, "SUCCEEDED", "already current");
    return;
  }
  if (!url.length()) { reportJobStatus(jobId, "FAILED", "no url in job document"); return; }

  applyFirmware(jobId, url);
}

// A job that sets the reading interval for a whole Thing Group: one AWS call
// reaches every board of a type, at the rollout pace and with the abort rules
// of the job (scripts/ota.sh interval). Boards that are offline pick it up
// when they reconnect, like firmware.
void CloudAgenticDevice::handleConfigJob(const String& jobId, JsonObject jobDocument) {
  long seconds = jobDocument["seconds"] | 0L;
  if (!setTelemetryInterval(seconds, "job")) {
    reportJobStatus(jobId, "REJECTED", "seconds must be " + String((unsigned long)cad::MIN_TELEMETRY_SECONDS)
                                        + "-" + String((unsigned long)cad::MAX_TELEMETRY_SECONDS));
    return;
  }
  reportJobStatus(jobId, "SUCCEEDED", "telemetry every " + String(seconds) + " s");
}

/* -------------------------------------------------------------- runtime */

void CloudAgenticDevice::handleMessage(char* topic, byte* payload, unsigned int length) {
  if (String(topic).indexOf("/jobs/") >= 0) { handleJobDocument(payload, length); return; }

  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, payload, length)) { Serial.println("command: malformed JSON"); return; }

  // Credentials are library business, not sketch business. Handling WIFI_UPDATE
  // here means every device type gets remote WiFi changes for free, and no
  // sketch has to know that WiFi exists. Storing is all that happens: the
  // device is by definition still on the OLD network to have received this, so
  // it keeps that connection and only uses the new entry once the old one is
  // gone. That is why the push must be sent BEFORE the network changes.
  if (strcmp(doc["operation"] | "", "WIFI_UPDATE") == 0) {
    saveNetwork(doc["ssid"] | "", doc["passphrase"] | "");
    Serial.println("wifi: updated over MQTT - identity and certificate untouched");
    return;
  }
  // The same setting the fleet job carries, for one board or a list of them
  // (the device-command API).
  if (strcmp(doc["operation"] | "", "SET_TELEMETRY_INTERVAL") == 0) {
    setTelemetryInterval(doc["seconds"] | 0L, "command");
    return;
  }

  if (_commandHandler) _commandHandler(doc);
}

void CloudAgenticDevice::configureMqtt() {
  _net.setCACert(AWS_ROOT_CA);
  _net.setCertificate(_cert.c_str());
  _net.setPrivateKey(_key.c_str());
  _mqtt.setServer(_endpoint.c_str(), 8883);
  // Jobs documents exceed PubSubClient's 256-byte default and oversized
  // messages are dropped silently - it looks like AWS never sent anything.
  _mqtt.setBufferSize(2048);
  _mqtt.setCallback(trampoline);
}

// One attempt. Retrying is loop()'s job, paced by the backoff, so that a board
// that cannot reach AWS keeps running its sketch instead of spinning here.
bool CloudAgenticDevice::connectAWS() {
  Serial.printf("aws: connecting as %s\n", _thingName.c_str());
  if (!_mqtt.connect(_thingName.c_str())) {
    Serial.printf("aws: not connected, state %d\n", _mqtt.state());
    return false;
  }
  Serial.printf("aws: connected, %s v%s\n", _sketch, _version);

  _mqtt.subscribe(("$aws/things/" + _thingName + "/jobs/notify-next").c_str());
  _mqtt.subscribe(("device/" + _thingName + "/command").c_str());
  // The answer to $next/get arrives on $next/get/accepted, not notify-next.
  // Without this subscription a job queued while the device was offline is
  // never picked up.
  _mqtt.subscribe(("$aws/things/" + _thingName + "/jobs/$next/get/accepted").c_str());
  // Ask for anything queued while this device was offline.
  _mqtt.publish(("$aws/things/" + _thingName + "/jobs/$next/get").c_str(), "{}");
  return true;
}

void CloudAgenticDevice::retryLater(const char* what) {
  uint32_t wait = _retry.fail(esp_random());
  _nextAttemptAt = millis() + wait;
  _waiting = true;
  Serial.printf("%s: attempt %lu failed, next in %lu ms\n", what,
                (unsigned long)_retry.failures(), (unsigned long)wait);
}

bool CloudAgenticDevice::begin() {
  if (!loadIdentity()) { provisionFromSerial(false); return false; }
  loadSettings();
  configureMqtt();
  if (!connectWiFi()) { provisionFromSerial(true); return false; }
  if (connectAWS()) _retry.reset();
  else retryLater("aws");
  return true;
}

void CloudAgenticDevice::loop() {
  checkSerialWifiUpdate();
  if (!_haveIdentity) return;   // still waiting to be provisioned
  if (_mqtt.connected()) { _mqtt.loop(); return; }

  // Offline. Until the next attempt is due, return at once.
  if (_waiting && !cad::due(millis(), _nextAttemptAt, _retry.capMs())) return;
  _waiting = false;

  if (WiFi.status() != WL_CONNECTED && !connectWiFi()) { retryLater("wifi"); return; }
  if (!connectAWS()) { retryLater("aws"); return; }
  _retry.reset();
  _mqtt.loop();
}

bool CloudAgenticDevice::publishTo(const String& topic, const JsonDocument& doc) {
  if (!_mqtt.connected()) return false;
  char buf[512];
  serializeJson(doc, buf);
  return _mqtt.publish(topic.c_str(), buf);
}

bool CloudAgenticDevice::publish(const char* subTopic, const JsonDocument& doc) {
  return publishTo("device/" + _thingName + "/" + subTopic, doc);
}

bool CloudAgenticDevice::publishTelemetry(const JsonDocument& doc) {
  return publishTo("$aws/rules/" TELEMETRY_RULE "/device/" + _thingName + "/telemetry", doc);
}

void CloudAgenticDevice::onCommand(void (*handler)(JsonDocument&)) { _commandHandler = handler; }
