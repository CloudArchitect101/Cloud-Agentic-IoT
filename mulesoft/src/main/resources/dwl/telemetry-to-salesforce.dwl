%dw 2.0
output application/java
/**
 * AWS IoT telemetry -> Salesforce Patient_Vitals__c.
 *
 * The deterministic external ID is the important part: device retries deliver
 * the same reading more than once, and deviceId + timestamp makes the upsert
 * idempotent without needing a dedupe table.
 */
var readings = if (payload is Array) payload else [payload]
---
readings map (reading) -> {
    Device_Reading_Id__c: reading.deviceId ++ "-" ++ (reading.timestamp as String),
    Device_Id__c:         reading.deviceId,
    Temperature__c:       reading.temperature as Number default 0,
    Humidity__c:          reading.humidity as Number default 0,
    // Device clocks drift; record when we received it as well as when it claims
    Reading_Time__c:      (reading.timestamp as Number) as DateTime {unit: "milliseconds"},
    Received_Time__c:     now()
}
