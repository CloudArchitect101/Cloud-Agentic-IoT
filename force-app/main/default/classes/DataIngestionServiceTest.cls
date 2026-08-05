/*
 * DataIngestionServiceTest.cls
 *
 * Test class for DataIngestionService covering all ingestion and risk scoring scenarios.
 */
@isTest
private class DataIngestionServiceTest {

    @TestSetup
    static void setup() {
        // Devices are standard Assets. An Asset must belong to an Account,
        // which in the B2C model is the patient's Person Account.
        Account patient = new Account(Name = 'Test Patient');
        insert patient;
        insert new Asset(
            Name = 'TEST-DEVICE-001',
            SerialNumber = 'TEST-DEVICE-001',
            AccountId = patient.Id,
            Status = 'Installed'
        );
    }

    @IsTest
    static void test_ingest_vitals_normal_range() {
        // Prepare vitals within normal range
        DataIngestionService.VitalRecord vital = new DataIngestionService.VitalRecord();
        vital.deviceId = 'TEST-DEVICE-001';
        vital.heartRate = 75.0;
        vital.spo2 = 98.0;
        vital.temperature = 36.8;
        vital.bloodPressureSystolic = 120.0;
        vital.bloodPressureDiastolic = 80.0;
        vital.timestamp = DateTime.now();
        vital.sourceSystem = 'AWS_IoT';

        List<DataIngestionService.VitalRecord> vitals = new List<DataIngestionService.VitalRecord> { vital };

        Test.startTest();
        List<DataIngestionService.IngestionResult> results = DataIngestionService.ingestVitals(vitals);
        Test.stopTest();

        System.assertEquals(1, results.size(), 'Should return one result per device');
        Assert.isTrue(results[0].success, 'Ingestion should succeed');
        System.assertEquals(0, results[0].riskScore, 'Normal vitals should have zero risk score');
        System.assertNotEquals(null, results[0].recordId, 'Should create a record');
    }

    @IsTest
    static void test_ingest_vitals_critical_range() {
        // Prepare vitals in critical range
        DataIngestionService.VitalRecord vital = new DataIngestionService.VitalRecord();
        vital.deviceId = 'TEST-DEVICE-001';
        vital.heartRate = 130.0;  // High HR
        vital.spo2 = 88.0;        // Low SpO2
        vital.temperature = 39.5; // High temp
        vital.bloodPressureSystolic = 170.0; // High BP
        vital.bloodPressureDiastolic = 110.0;
        vital.timestamp = DateTime.now();
        vital.sourceSystem = 'AWS_IoT';

        List<DataIngestionService.VitalRecord> vitals = new List<DataIngestionService.VitalRecord> { vital };

        Test.startTest();
        List<DataIngestionService.IngestionResult> results = DataIngestionService.ingestVitals(vitals);
        Test.stopTest();

        System.assertEquals(1, results.size());
        Assert.isTrue(results[0].success);
        System.assert(results[0].riskScore >= 80, 'Critical vitals should have high risk score');
    }

    @IsTest
    static void test_ingest_vitals_multiple_devices() {
        // Second device on the same patient account
        Account patient = [SELECT Id FROM Account LIMIT 1];
        insert new Asset(
            Name = 'TEST-DEVICE-002',
            SerialNumber = 'TEST-DEVICE-002',
            AccountId = patient.Id,
            Status = 'Installed'
        );

        DataIngestionService.VitalRecord vital1 = new DataIngestionService.VitalRecord();
        vital1.deviceId = 'TEST-DEVICE-001';
        vital1.heartRate = 75.0;
        vital1.spo2 = 98.0;
        vital1.temperature = 36.8;
        vital1.bloodPressureSystolic = 120.0;
        vital1.bloodPressureDiastolic = 80.0;
        vital1.timestamp = DateTime.now();
        vital1.sourceSystem = 'AWS_IoT';

        DataIngestionService.VitalRecord vital2 = new DataIngestionService.VitalRecord();
        vital2.deviceId = 'TEST-DEVICE-002';
        vital2.heartRate = 80.0;
        vital2.spo2 = 97.0;
        vital2.temperature = 37.0;
        vital2.bloodPressureSystolic = 118.0;
        vital2.bloodPressureDiastolic = 78.0;
        vital2.timestamp = DateTime.now();
        vital2.sourceSystem = 'AWS_IoT';

        List<DataIngestionService.VitalRecord> vitals = new List<DataIngestionService.VitalRecord> { vital1, vital2 };

        Test.startTest();
        List<DataIngestionService.IngestionResult> results = DataIngestionService.ingestVitals(vitals);
        Test.stopTest();

        System.assertEquals(2, results.size(), 'Should return one result per unique device');
    }

    @IsTest
    static void test_get_vitals_for_data_cloud() {
        // Create some vitals records
        Patient_Vitals__c vitals = new Patient_Vitals__c();
        vitals.Device__c = 'TEST-DEVICE-001';
        vitals.Heart_Rate__c = 75.0;
        vitals.SpO2__c = 98.0;
        vitals.Temperature__c = 36.8;
        vitals.Timestamp__c = DateTime.now();
        vitals.Risk_Score__c = 0;
        vitals.Device_Reading_Id__c = 'TEST-DEVICE-001-' + String.valueOf(DateTime.now());
        insert vitals;

        Test.startTest();
        List<Patient_Vitals__c> result = DataIngestionService.getVitalsForDataCloud('TEST-DEVICE-001');
        Test.stopTest();

        System.assertEquals(1, result.size(), 'Should return vitals for the specified device');
        System.assertEquals('TEST-DEVICE-001', result[0].Device__c);
    }
}
