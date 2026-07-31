/*
 * StreamingAlertServiceTest.cls
 *
 * Test class for StreamingAlertService covering alert evaluation and Platform Event publishing.
 */
@isTest
private class StreamingAlertServiceTest {

    @Test
    static void test_process_vitals_critical_heart_rate() {
        StreamingAlertService.VitalsPayload payload = new StreamingAlertService.VitalsPayload();
        payload.deviceId = 'TEST-DEVICE-001';
        payload.heartRate = 130.0;
        payload.spo2 = 98.0;
        payload.temperature = 36.8;
        payload.bpSystolic = 120.0;
        payload.bpDiastolic = 80.0;
        payload.sourceSystem = 'AWS_IoT';

        List<StreamingAlertService.VitalsPayload> payloads = new List<StreamingAlertService.VitalsPayload> { payload };

        Test.startTest();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(payloads);
        Test.stopTest();

        System.assertEquals(1, results.size());
        System.assertTrue(results[0].alertPublished, 'Should publish alert for critical heart rate');
        System.assertEquals('CRITICAL_VITALS', results[0].alertType);
    }

    @Test
    static void test_process_vitals_critical_spo2() {
        StreamingAlertService.VitalsPayload payload = new StreamingAlertService.VitalsPayload();
        payload.deviceId = 'TEST-DEVICE-002';
        payload.heartRate = 75.0;
        payload.spo2 = 88.0;
        payload.temperature = 36.8;
        payload.bpSystolic = 120.0;
        payload.bpDiastolic = 80.0;
        payload.sourceSystem = 'AWS_IoT';

        List<StreamingAlertService.VitalsPayload> payloads = new List<StreamingAlertService.VitalsPayload> { payload };

        Test.startTest();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(payloads);
        Test.stopTest();

        System.assertTrue(results[0].alertPublished, 'Should publish alert for critical SpO2');
        System.assertEquals('CRITICAL_VITALS', results[0].alertType);
    }

    @Test
    static void test_process_vitals_normal_range() {
        StreamingAlertService.VitalsPayload payload = new StreamingAlertService.VitalsPayload();
        payload.deviceId = 'TEST-DEVICE-003';
        payload.heartRate = 75.0;
        payload.spo2 = 98.0;
        payload.temperature = 36.8;
        payload.bpSystolic = 120.0;
        payload.bpDiastolic = 80.0;
        payload.sourceSystem = 'AWS_IoT';

        List<StreamingAlertService.VitalsPayload> payloads = new List<StreamingAlertService.VitalsPayload> { payload };

        Test.startTest();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(payloads);
        Test.stopTest();

        System.assertFalse(results[0].alertPublished, 'Should not publish alert for normal vitals');
    }

    @Test
    static void test_process_vitals_abnormal_trend() {
        StreamingAlertService.VitalsPayload payload = new StreamingAlertService.VitalsPayload();
        payload.deviceId = 'TEST-DEVICE-004';
        payload.heartRate = 55.0;  // Below normal but not critical
        payload.spo2 = 96.0;
        payload.temperature = 36.8;
        payload.bpSystolic = 120.0;
        payload.bpDiastolic = 80.0;
        payload.sourceSystem = 'AWS_IoT';

        List<StreamingAlertService.VitalsPayload> payloads = new List<StreamingAlertService.VitalsPayload> { payload };

        Test.startTest();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(payloads);
        Test.stopTest();

        System.assertTrue(results[0].alertPublished, 'Should publish warning for abnormal trend');
        System.assertEquals('ABNORMAL_TREND', results[0].alertType);
    }

    @Test
    static void test_process_vitals_multiple_payloads() {
        StreamingAlertService.VitalsPayload critical = new StreamingAlertService.VitalsPayload();
        critical.deviceId = 'TEST-DEVICE-001';
        critical.heartRate = 130.0;
        critical.spo2 = 98.0;
        critical.temperature = 36.8;
        critical.bpSystolic = 120.0;
        critical.bpDiastolic = 80.0;
        critical.sourceSystem = 'AWS_IoT';

        StreamingAlertService.VitalsPayload normal = new StreamingAlertService.VitalsPayload();
        normal.deviceId = 'TEST-DEVICE-002';
        normal.heartRate = 75.0;
        normal.spo2 = 98.0;
        normal.temperature = 36.8;
        normal.bpSystolic = 120.0;
        normal.bpDiastolic = 80.0;
        normal.sourceSystem = 'AWS_IoT';

        List<StreamingAlertService.VitalsPayload> payloads = new List<StreamingAlertService.VitalsPayload> { critical, normal };

        Test.startTest();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(payloads);
        Test.stopTest();

        System.assertEquals(2, results.size());
        System.assertTrue(results[0].alertPublished, 'First payload should trigger alert');
        System.assertFalse(results[1].alertPublished, 'Second payload should not trigger alert');
    }
}
