/*
 * DataIngestionService.cls
 *
 * Apex service that handles patient vital ingestion from AWS IoT data streams.
 * This service is invoked by Agentforce agents to process incoming patient vitals
 * and prepare them for Data Cloud RAG pipeline ingestion.
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
     * Creates Patient_Vitals__c records and calculates clinical risk scores.
     *
     * @param vitals List of vital records to ingest
     * @return IngestionResult with success status and risk score
     */
    @InvocableMethod(label='Ingest Patient Vitals' description='Ingests patient vitals from external data sources and calculates risk scores')
    public static List<IngestionResult> ingestVitals(List<VitalRecord> vitals) {
        List<IngestionResult> results = new List<IngestionResult>();

        // Group vitals by device for batch processing
        Map<String, List<VitalRecord>> vitalsByDevice = new Map<String, List<VitalRecord>>();
        for (VitalRecord v : vitals) {
            if (!vitalsByDevice.containsKey(v.deviceId)) {
                vitalsByDevice.put(v.deviceId, new List<VitalRecord>());
            }
            vitalsByDevice.get(v.deviceId).add(v);
        }

        // Process each device's vitals
        for (String deviceId : vitalsByDevice.keySet()) {
            List<VitalRecord> deviceVitals = vitalsByDevice.get(deviceId);
            VitalRecord latest = deviceVitals[0]; // Most recent (assorted by caller)

            // Calculate clinical risk score (0-100, higher = more critical)
            Integer riskScore = calculateRiskScore(latest);

            // Create Patient_Vitals__c record
            Patient_Vitals__c vitalsRecord = new Patient_Vitals__c(
                Device__c = deviceId,
                Heart_Rate__c = latest.heartRate,
                SpO2__c = latest.spo2,
                Temperature__c = latest.temperature,
                BP_Systolic__c = latest.bloodPressureSystolic,
                BP_Diastolic__c = latest.bloodPressureDiastolic,
                Timestamp__c = latest.timestamp,
                Source_System__c = latest.sourceSystem,
                Risk_Score__c = riskScore,
                // Required, unique external ID. Same deviceId-timestamp key the
                // patient-vitals Lambda upserts on, so a reading that arrives via
                // both paths lands on one record instead of duplicating.
                Device_Reading_Id__c = deviceId + '-' +
                    String.valueOf(latest.timestamp != null ? latest.timestamp : System.now())
            );

            // Upsert, not insert: IoT deliveries retry, and a retried insert
            // would violate the unique constraint rather than being a no-op.
            upsert vitalsRecord Device_Reading_Id__c;

            IngestionResult result = new IngestionResult();
            result.success = true;
            result.message = 'Vitals ingested successfully for device ' + deviceId;
            result.recordId = vitalsRecord.Id;
            result.riskScore = riskScore;
            results.add(result);
        }

        return results;
    }

    /**
     * Calculate clinical risk score (0-100) based on vital thresholds.
     * Mirrors clinical triage logic used in healthcare settings.
     *
     * @param vital The latest vital record
     * @return Risk score from 0 (stable) to 100 (critical)
     */
    private static Integer calculateRiskScore(VitalRecord vital) {
        Integer score = 0;

        // Heart rate assessment (normal: 60-100 bpm)
        if (vital.heartRate != null) {
            if (vital.heartRate < 50 || vital.heartRate > 120) score += 30;
            else if (vital.heartRate < 60 || vital.heartRate > 100) score += 15;
        }

        // SpO2 assessment (normal: 95-100%)
        if (vital.spo2 != null) {
            if (vital.spo2 < 90) score += 35;
            else if (vital.spo2 < 95) score += 20;
        }

        // Temperature assessment (normal: 36.1-37.2°C)
        if (vital.temperature != null) {
            if (vital.temperature > 39.0 || vital.temperature < 35.0) score += 25;
            else if (vital.temperature > 38.5 || vital.temperature < 36.5) score += 15;
        }

        // Blood pressure assessment
        if (vital.bloodPressureSystolic != null) {
            if (vital.bloodPressureSystolic > 160) score += 20;
            else if (vital.bloodPressureSystolic > 140) score += 10;
        }

        return Math.min(100, score);
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
