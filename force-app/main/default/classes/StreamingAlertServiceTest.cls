/*
 * StreamingAlertServiceTest.cls
 *
 * Test class for StreamingAlertService covering alert evaluation and Platform Event publishing.
 */
@isTest
private class StreamingAlertServiceTest {

    @IsTest
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
        Assert.isTrue(results[0].alertPublished, 'Should publish alert for critical heart rate');
        System.assertEquals('CRITICAL_VITALS', results[0].alertType);
    }

    @IsTest
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

        Assert.isTrue(results[0].alertPublished, 'Should publish alert for critical SpO2');
        System.assertEquals('CRITICAL_VITALS', results[0].alertType);
    }

    @IsTest
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

        Assert.isFalse(results[0].alertPublished, 'Should not publish alert for normal vitals');
    }

    @IsTest
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

        Assert.isTrue(results[0].alertPublished, 'Should publish warning for abnormal trend');
        System.assertEquals('ABNORMAL_TREND', results[0].alertType);
    }

    @IsTest
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
        Assert.isTrue(results[0].alertPublished, 'First payload should trigger alert');
        Assert.isFalse(results[1].alertPublished, 'Second payload should not trigger alert');
    }

    private static StreamingAlertService.VitalsPayload payload(String deviceId, Decimal heartRate, Decimal temperature) {
        StreamingAlertService.VitalsPayload p = new StreamingAlertService.VitalsPayload();
        p.deviceId = deviceId;
        p.heartRate = heartRate;
        p.spo2 = 98.0;
        p.temperature = temperature;
        p.sourceSystem = 'AWS_IoT';
        return p;
    }

    @IsTest
    static void test_three_hundred_alerts_are_one_publish() {
        // EventBus.publish inside the loop counted one DML statement per
        // alert, so the 151st alert of one call failed the call.
        DeviceTestSettings.use();
        DeviceTestSettings.useStandardThresholds();
        List<StreamingAlertService.VitalsPayload> payloads = new List<StreamingAlertService.VitalsPayload>();
        for (Integer i = 0; i < 300; i++) {
            payloads.add(payload('BULK-' + i, 130, 36.8));
        }

        Test.startTest();
        Integer before = Limits.getDmlStatements();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(payloads);
        Integer used = Limits.getDmlStatements() - before;
        Test.stopTest();

        Assert.isTrue(used <= 1, 'At most one DML statement for 300 alerts, used ' + used);
        Assert.areEqual(300, results.size(), 'One result per payload');
        Assert.isTrue(results[299].alertPublished, 'The last one was published too');
    }

    @IsTest
    static void test_any_vital_in_its_warning_band_is_an_abnormal_trend() {
        // Bands come from Vital_Sign_Threshold__mdt, so temperature is judged
        // like every other vital: 38.7 C is in its warning band.
        DeviceTestSettings.use();
        DeviceTestSettings.useStandardThresholds();
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(
            new List<StreamingAlertService.VitalsPayload>{ payload('TEST-DEVICE-005', 75, 38.7) });
        Assert.areEqual('ABNORMAL_TREND', results[0].alertType, 'Temperature warning');
    }

    @IsTest
    static void test_a_changed_band_changes_the_alert_without_code() {
        DeviceTestSettings.use();
        VitalSignEvaluator.testThresholds = new List<Vital_Sign_Threshold__mdt>{
            DeviceTestSettings.band('heartRate', 50, 100, 60, 90, 30, 15, 10)
        };
        List<StreamingAlertService.AlertResult> results = StreamingAlertService.processVitalsAlert(
            new List<StreamingAlertService.VitalsPayload>{ payload('TEST-DEVICE-006', 105, null) });
        Assert.areEqual('CRITICAL_VITALS', results[0].alertType, '105 bpm is critical once the band says so');
    }
}
