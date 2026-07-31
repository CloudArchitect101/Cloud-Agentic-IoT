/*
 * StreamingAlertService.cls
 *
 * Apex service that processes real-time patient vitals alerts from AWS EventBridge
 * and publishes Platform Events to trigger Agentforce agent actions.
 *
 * This is the bridge between AWS streaming infrastructure and Salesforce agent actions:
 * 1. Receives vitals from AWS Lambda via REST API
 * 2. Evaluates clinical thresholds
 * 3. Publishes Platform Events for critical conditions
 * 4. Triggers Agentforce topics to take autonomous action
 *
 * Demonstrates: Real-time data streams, event-driven architecture, Platform Events, async
 */
public with sharing class StreamingAlertService {

    /**
     * Incoming vitals payload from AWS Lambda
     */
    public class VitalsPayload {
        @AuraEnabled public String deviceId;
        @AuraEnabled public Decimal heartRate;
        @AuraEnabled public Decimal spo2;
        @AuraEnabled public Decimal temperature;
        @AuraEnabled public Decimal bpSystolic;
        @AuraEnabled public Decimal bpDiastolic;
        @AuraEnabled public String sourceSystem;
    }

    /**
     * Process incoming vitals and publish Platform Event if critical
     *
     * @param payload Vitals from AWS Lambda
     * @return Alert result with Platform Event ID if published
     */
    @InvocableMethod(label='Process Real-time Vitals Alert' description='Processes incoming vitals and publishes Platform Event for critical conditions')
    public static List<AlertResult> processVitalsAlert(List<VitalsPayload> payloads) {
        List<AlertResult> results = new List<AlertResult>();

        for (VitalsPayload payload : payloads) {
            AlertResult result = new AlertResult();
            result.deviceId = payload.deviceId;
            result.alertPublished = false;

            // Evaluate clinical thresholds and determine alert type
            String alertType = evaluateAlertType(payload);

            if (alertType != null) {
                // Publish Platform Event for Agentforce agents to consume
                publishPlatformEvent(payload, alertType);
                result.alertPublished = true;
                result.alertType = alertType;
            }

            results.add(result);
        }

        return results;
    }

    /**
     * Evaluate vitals against clinical thresholds to determine alert type
     *
     * @param payload Patient vitals payload
     * @return Alert type if critical condition detected, null otherwise
     */
    private static String evaluateAlertType(VitalsPayload payload) {
        // Critical heart rate
        if (payload.heartRate != null && (payload.heartRate < 50 || payload.heartRate > 120)) {
            return 'CRITICAL_VITALS';
        }

        // Critical SpO2
        if (payload.spo2 != null && payload.spo2 < 90) {
            return 'CRITICAL_VITALS';
        }

        // Critical temperature
        if (payload.temperature != null && (payload.temperature > 39.0 || payload.temperature < 35.0)) {
            return 'CRITICAL_VITALS';
        }

        // Critical blood pressure
        if (payload.bpSystolic != null && payload.bpSystolic > 160) {
            return 'CRITICAL_VITALS';
        }

        // Abnormal trend (non-critical but concerning)
        if (payload.heartRate != null && (payload.heartRate < 60 || payload.heartRate > 100)) {
            return 'ABNORMAL_TREND';
        }

        if (payload.spo2 != null && payload.spo2 < 95) {
            return 'ABNORMAL_TREND';
        }

        return null;
    }

    /**
     * Publish Platform Event for Agentforce agents to consume
     * This is the key integration point — agents subscribe to Platform Events
     * and take autonomous action when critical vitals are detected
     *
     * @param payload Patient vitals
     * @param alertType Type of alert
     */
    private static void publishPlatformEvent(VitalsPayload payload, String alertType) {
        String message;

        if (alertType == 'CRITICAL_VITALS') {
            message = 'CRITICAL: Patient device ' + payload.deviceId +
                      ' has abnormal vitals — HR: ' + payload.heartRate +
                      ', SpO2: ' + payload.spo2 +
                      ', Temp: ' + payload.temperature + '°C';
        } else {
            message = 'WARNING: Patient device ' + payload.deviceId +
                      ' shows abnormal trends — HR: ' + payload.heartRate +
                      ', SpO2: ' + payload.spo2;
        }

        Patient_Vital_Alert__e alertEvent = new Patient_Vital_Alert__e();
        alertEvent.Patient_Device_Id__c = payload.deviceId;
        alertEvent.Alert_Type__c = alertType;
        alertEvent.Patient_State__c = alertType == 'CRITICAL_VITALS' ? 'CRITICAL' : 'AT_RISK';
        alertEvent.Heart_Rate__c = payload.heartRate;
        alertEvent.SpO2__c = payload.spo2;
        alertEvent.Temperature__c = payload.temperature;
        alertEvent.Message__c = message;

        Database.insert(new List<Patient_Vital_Alert__e> { alertEvent }, false);
    }

    /**
     * Alert result DTO
     */
    public class AlertResult {
        @AuraEnabled public String deviceId;
        @AuraEnabled public Boolean alertPublished;
        @AuraEnabled public String alertType;
    }
}
