#include "CloudAgenticDevice.h"

#define NVS_IDENTITY "identity"
#define NVS_WIFI     "wifi"
#define WIFI_SLOTS   3
#define WIFI_ATTEMPT_MS 15000

// Amazon Root CA 1 is identical for every device in every account, so unlike
// per-device material it is fine to compile in.
static const char AWS_ROOT_CA[] = R"EOF_CA(
-----BEGIN CERTIFICATE-----
[... PASTE AMAZON ROOT CA 1 HERE - identical for all devices ...]
-----END CERTIFICATE-----
)EOF_CA";

CloudAgenticDevice* CloudAgenticDevice::_instance = nullptr;

CloudAgenticDevice::CloudAgenticDevice(const char* sketchName, const char* version)
  : _sketch(sketchName), _version(version), _mqtt(_net) {
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
  return _thingName.length() && _endpoint.length() && _cert.length() && _key.length();
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
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
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

  if (_commandHandler) _commandHandler(doc);
}

void CloudAgenticDevice::connectAWS() {
  _net.setCACert(AWS_ROOT_CA);
  _net.setCertificate(_cert.c_str());
  _net.setPrivateKey(_key.c_str());
  _mqtt.setServer(_endpoint.c_str(), 8883);
  // Jobs documents exceed PubSubClient's 256-byte default and oversized
  // messages are dropped silently - it looks like AWS never sent anything.
  _mqtt.setBufferSize(2048);
  _mqtt.setCallback(trampoline);

  Serial.printf("aws: connecting as %s\n", _thingName.c_str());
  while (!_mqtt.connect(_thingName.c_str())) { Serial.print("."); delay(1000); }
  Serial.printf("\naws: connected, %s v%s\n", _sketch, _version);

  _mqtt.subscribe(("$aws/things/" + _thingName + "/jobs/notify-next").c_str());
  _mqtt.subscribe(("device/" + _thingName + "/command").c_str());
  // Ask for anything queued while this device was offline.
  _mqtt.publish(("$aws/things/" + _thingName + "/jobs/$next/get").c_str(), "{}");
}

bool CloudAgenticDevice::begin() {
  if (!loadIdentity()) { provisionFromSerial(false); return false; }
  if (!connectWiFi()) { provisionFromSerial(true); return false; }
  connectAWS();
  return true;
}

void CloudAgenticDevice::loop() {
  checkSerialWifiUpdate();
  if (WiFi.status() != WL_CONNECTED) { if (!connectWiFi()) { delay(5000); return; } }
  if (!_mqtt.connected()) connectAWS();
  _mqtt.loop();
}

bool CloudAgenticDevice::publish(const char* subTopic, const JsonDocument& doc) {
  if (!_mqtt.connected()) return false;
  char buf[512];
  serializeJson(doc, buf);
  return _mqtt.publish(("device/" + _thingName + "/" + subTopic).c_str(), buf);
}

void CloudAgenticDevice::onCommand(void (*handler)(JsonDocument&)) { _commandHandler = handler; }
