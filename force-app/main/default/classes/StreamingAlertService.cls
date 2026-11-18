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
        @AuraEnabled @InvocableVariable public String deviceId;
        @AuraEnabled @InvocableVariable public Decimal heartRate;
        @AuraEnabled @InvocableVariable public Decimal spo2;
        @AuraEnabled @InvocableVariable public Decimal temperature;
        @AuraEnabled @InvocableVariable public Decimal bpSystolic;
        @AuraEnabled @InvocableVariable public Decimal bpDiastolic;
        @AuraEnabled @InvocableVariable public String sourceSystem;
    }

    /**
     * Process incoming vitals and publish a Platform Event for each payload
     * that needs attention.
     *
     * The bands are Vital_Sign_Threshold__mdt records (VitalSignEvaluator):
     * any vital in its critical band is CRITICAL_VITALS, any in its warning
     * band is ABNORMAL_TREND. All events go out in one EventBus.publish, which
     * counts as one DML statement however many payloads there are; publishing
     * inside the loop, as before, failed the 151st payload of a call.
     *
     * @param payloads Vitals from AWS Lambda
     * @return One AlertResult per payload, in order
     */
    @InvocableMethod(label='Process Real-time Vitals Alert' description='Processes incoming vitals and publishes Platform Event for critical conditions')
    public static List<AlertResult> processVitalsAlert(List<VitalsPayload> payloads) {
        List<AlertResult> results = new List<AlertResult>();
        List<Patient_Vital_Alert__e> events = new List<Patient_Vital_Alert__e>();
        List<AlertResult> resultForEvent = new List<AlertResult>();

        for (VitalsPayload payload : payloads) {
            AlertResult result = new AlertResult();
            result.deviceId = payload.deviceId;
            result.alertPublished = false;
            results.add(result);

            VitalSignEvaluator.Assessment assessment = VitalSignEvaluator.assess(new Map<String, Decimal>{
                'heartRate'   => payload.heartRate,
                'spo2'        => payload.spo2,
                'temperature' => payload.temperature,
                'bpSystolic'  => payload.bpSystolic
            });
            String alertType = alertTypeFor(assessment);
            if (alertType == null) {
                continue;
            }
            result.alertType = alertType;
            events.add(buildEvent(payload, alertType, assessment));
            resultForEvent.add(result);
        }

        if (!events.isEmpty()) {
            // Publish = producing to a topic: Agentforce agents subscribe to
            // Patient_Vital_Alert__e and take action.
            List<Database.SaveResult> saves = EventBus.publish(events);
            for (Integer i = 0; i < saves.size(); i++) {
                resultForEvent[i].alertPublished = saves[i].isSuccess();
                if (!saves[i].isSuccess()) {
                    System.debug(LoggingLevel.ERROR, 'Patient_Vital_Alert__e publish failed for '
                        + resultForEvent[i].deviceId + ': ' + saves[i].getErrors()[0].getMessage());
                }
            }
        }
        return results;
    }

    @TestVisible
    private static String alertTypeFor(VitalSignEvaluator.Assessment assessment) {
        if (assessment.anyCritical()) {
            return 'CRITICAL_VITALS';
        }
        if (assessment.anyWarning()) {
            return 'ABNORMAL_TREND';
        }
        return null;
    }

    private static Patient_Vital_Alert__e buildEvent(
        VitalsPayload payload, String alertType, VitalSignEvaluator.Assessment assessment
    ) {
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
        alertEvent.Risk_Score__c = assessment.riskScore;
        alertEvent.Heart_Rate__c = payload.heartRate;
        alertEvent.SpO2__c = payload.spo2;
        alertEvent.Temperature__c = payload.temperature;
        alertEvent.Message__c = message;
        return alertEvent;
    }

    /**
     * Alert result DTO
     */
    public class AlertResult {
        @AuraEnabled @InvocableVariable public String deviceId;
        @AuraEnabled @InvocableVariable public Boolean alertPublished;
        @AuraEnabled @InvocableVariable public String alertType;
    }
}
