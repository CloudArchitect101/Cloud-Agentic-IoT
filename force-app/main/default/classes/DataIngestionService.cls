/*
 * DataIngestionService.cls
 *
 * Apex service that handles patient vital ingestion from AWS IoT data streams.
 * This service is invoked by Agentforce agents to process incoming patient vitals
 * and prepare them for Data Cloud RAG pipeline ingestion.
 *
 * The clinical bands are not in this class: they are Vital_Sign_Threshold__mdt
 * records, read through VitalSignEvaluator.
 *
 * Demonstrates: Data Cloud, RAG pipeline, ETL/ELT, data engineering
 */
public with sharing class DataIngestionService {

    /**
     * Patient vital record DTO for ingestion
     */
    public class VitalRecord {
        @AuraEnabled @InvocableVariable public String deviceId;
        @AuraEnabled @InvocableVariable public Decimal heartRate;
        @AuraEnabled @InvocableVariable public Decimal spo2;
        @AuraEnabled @InvocableVariable public Decimal temperature;
        @AuraEnabled @InvocableVariable public Decimal humidity;
        @AuraEnabled @InvocableVariable public Decimal bloodPressureSystolic;
        @AuraEnabled @InvocableVariable public Decimal bloodPressureDiastolic;
        @AuraEnabled @InvocableVariable public DateTime timestamp;
        @AuraEnabled @InvocableVariable public String sourceSystem;
    }

    /**
     * Ingestion result DTO
     */
    public class IngestionResult {
        @AuraEnabled @InvocableVariable public Boolean success;
        @AuraEnabled @InvocableVariable public String message;
        @AuraEnabled @InvocableVariable public Id recordId;
        @AuraEnabled @InvocableVariable public Integer riskScore;
    }

    /**
     * Ingest a batch of patient vitals from external data sources.
     * Upserts one Patient_Vitals__c record per device - its latest reading in
     * the batch - and scores it against Vital_Sign_Threshold__mdt.
     *
     * One upsert for the whole batch, whatever its size. The previous version
     * upserted inside the per-device loop, so the 151st device in one call
     * hit the DML statement limit and the whole batch failed.
     *
     * @param vitals List of vital records to ingest
     * @return One IngestionResult per device, in the order devices first appear
     */
    @InvocableMethod(label='Ingest Patient Vitals' description='Ingests patient vitals from external data sources and calculates risk scores')
    public static List<IngestionResult> ingestVitals(List<VitalRecord> vitals) {
        List<IngestionResult> results = new List<IngestionResult>();
        if (vitals == null || vitals.isEmpty()) {
            return results;
        }

        // The latest reading per device. Callers are not trusted to sort:
        // "the first one" was only the latest when the caller happened to send
        // newest first.
        Map<String, VitalRecord> latestByDevice = new Map<String, VitalRecord>();
        for (VitalRecord v : vitals) {
            if (v == null || String.isBlank(v.deviceId)) {
                continue;
            }
            VitalRecord current = latestByDevice.get(v.deviceId);
            if (current == null || isLater(v.timestamp, current.timestamp)) {
                latestByDevice.put(v.deviceId, v);
            }
        }

        List<Patient_Vitals__c> records = new List<Patient_Vitals__c>();
        List<VitalSignEvaluator.Assessment> assessments = new List<VitalSignEvaluator.Assessment>();
        for (String deviceId : latestByDevice.keySet()) {
            VitalRecord latest = latestByDevice.get(deviceId);
            VitalSignEvaluator.Assessment assessment = VitalSignEvaluator.assess(new Map<String, Decimal>{
                'heartRate'   => latest.heartRate,
                'spo2'        => latest.spo2,
                'temperature' => latest.temperature,
                'bpSystolic'  => latest.bloodPressureSystolic
            });
            Datetime readingTime = latest.timestamp != null ? latest.timestamp : System.now();
            records.add(new Patient_Vitals__c(
                Device__c        = deviceId,
                Heart_Rate__c    = latest.heartRate,
                SpO2__c          = latest.spo2,
                Temperature__c   = latest.temperature,
                Humidity__c      = latest.humidity,
                BP_Systolic__c   = latest.bloodPressureSystolic,
                BP_Diastolic__c  = latest.bloodPressureDiastolic,
                Timestamp__c     = readingTime,
                Source_System__c = latest.sourceSystem,
                Risk_Score__c    = assessment.riskScore,
                Patient_State__c = assessment.patientState,
                Device_Reading_Id__c = readingIdFor(deviceId, readingTime)
            ));
            assessments.add(assessment);
        }

        // Upsert, not insert: IoT deliveries retry, and a retried insert
        // would violate the unique constraint rather than being a no-op.
        // allOrNone=false: one bad reading must not reject the other devices'.
        List<Database.UpsertResult> saves = Database.upsert(records, Patient_Vitals__c.Device_Reading_Id__c, false);
        for (Integer i = 0; i < saves.size(); i++) {
            IngestionResult result = new IngestionResult();
            result.riskScore = assessments[i].riskScore;
            if (saves[i].isSuccess()) {
                result.success = true;
                result.recordId = saves[i].getId();
                result.message = 'Vitals ingested successfully for device ' + records[i].Device__c;
            } else {
                result.success = false;
                result.message = 'Vitals for device ' + records[i].Device__c + ' were not saved: '
                    + saves[i].getErrors()[0].getMessage();
            }
            results.add(result);
        }
        return results;
    }

    /**
     * The external ID of one reading: deviceId-<ISO 8601 UTC with milliseconds>,
     * exactly what the AWS sync writes (JavaScript's toISOString()), so a
     * reading that arrives by both paths lands on one record. The previous
     * key used String.valueOf(Datetime), which is neither ISO nor UTC, so the
     * two paths never matched and every such reading was stored twice.
     */
    @TestVisible
    private static String readingIdFor(String deviceId, Datetime readingTime) {
        return deviceId + '-' + readingTime.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'');
    }

    private static Boolean isLater(Datetime candidate, Datetime current) {
        if (candidate == null) {
            return false;
        }
        return current == null || candidate > current;
    }

    /**
     * Sync patient vitals to Data Cloud External Object.
     * This method is called by the Data Cloud real-time sync configuration.
     *
     * @param deviceId The patient device identifier
     * @return List of Patient_Vitals__c records for the device
     */
    // Not @InvocableMethod: Apex allows only one per class, and that slot
    // belongs to ingestVitals. Called directly rather than from a Flow.
    public static List<Patient_Vitals__c> getVitalsForDataCloud(String deviceId) {
        return [
            SELECT Id, Device__c, Heart_Rate__c, SpO2__c, Temperature__c,
                   BP_Systolic__c, BP_Diastolic__c, Timestamp__c, Risk_Score__c
            FROM Patient_Vitals__c
            WHERE Device__c = :deviceId
            ORDER BY Timestamp__c DESC
            LIMIT 100
        ];
    }
}
