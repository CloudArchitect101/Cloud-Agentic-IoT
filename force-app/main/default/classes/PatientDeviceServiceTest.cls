/*
 * PatientDeviceServiceTest.cls
 *
 * A patient's devices are the Patient Device Assets on their own account:
 * never another patient's, never an internal board, and a serial number on
 * another account is simply not found.
 */
@IsTest
private class PatientDeviceServiceTest {

    @IsTest
    static void aPatientSeesOnlyTheirOwnPatientDevices() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();

        List<PatientDeviceService.Device> mine = PatientDeviceService.devicesFor(both[0].account.Id, 5);

        Assert.areEqual(1, mine.size(), 'Only A\'s patient device: not B\'s, not A\'s internal board');
        Assert.areEqual(PatientPortalTestData.SERIAL_A, mine[0].serialNumber);
        Assert.areEqual(2, mine[0].readings.size());
        Assert.areEqual(23.0, mine[0].readings[0].temperature, 'Newest first');
    }

    @IsTest
    static void anotherPatientsSerialIsNotFound() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();

        Assert.isTrue(PatientDeviceService.devicesFor(both[0].account.Id, PatientPortalTestData.SERIAL_B, 5).isEmpty(),
            'Patient A asking for B\'s device gets nothing');
        Assert.isTrue(PatientDeviceService.devicesFor(both[0].account.Id, PatientPortalTestData.SERIAL_A_INTERNAL, 5).isEmpty(),
            'Nor an internal board on their own account');
        Assert.areEqual(1, PatientDeviceService.devicesFor(both[1].account.Id, PatientPortalTestData.SERIAL_B, 5).size(),
            'B gets their own');
    }

    @IsTest
    static void noAccountMeansNoDevices() {
        PatientPortalTestData.twoPatients();
        Assert.isTrue(PatientDeviceService.devicesFor(null, 5).isEmpty());
    }

    @IsTest
    static void readingsAreCapped() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        List<Patient_Vitals__c> many = new List<Patient_Vitals__c>();
        for (Integer i = 10; i < 40; i++) {
            many.add(PatientPortalTestData.reading(PatientPortalTestData.SERIAL_A, i, 22));
        }
        insert many;
        Assert.areEqual(PatientDeviceService.MAX_READINGS,
            PatientDeviceService.devicesFor(both[0].account.Id, 500)[0].readings.size());
    }

    private static DeviceApiClient.Result awsAnswer(Integer status, String at, Decimal temperature) {
        return awsAnswer(status, at, temperature, null);
    }

    private static DeviceApiClient.Result awsAnswer(Integer status, String at, Decimal temperature, Boolean alert) {
        DeviceApiClient.Result result = new DeviceApiClient.Result();
        result.statusCode = status;
        result.body = JSON.serialize(new Map<String, Object>{
            'latest' => at == null ? null : new Map<String, Object>{ 'at' => at, 'temperature' => temperature, 'humidity' => 40 },
            'state' => alert == null ? null : new Map<String, Object>{ 'patientState' => 'STABLE', 'temperatureAlert' => alert }
        });
        return result;
    }

    @IsTest
    static void aNewerReadingFromAwsComesFirst() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        PatientDeviceService.Device device = PatientDeviceService.devicesFor(both[0].account.Id, 5)[0];

        PatientDeviceService.addLatest(device, awsAnswer(200, '2026-11-19T23:00:00.000Z', 31.5, true));

        Assert.areEqual(3, device.readings.size());
        Assert.isTrue(device.readings[0].live, 'The AWS reading is marked live');
        Assert.areEqual(31.5, device.readings[0].temperature);
        Assert.isTrue(device.readings[0].roomTemperatureAlert, 'The alert is the one AWS reports');
        Assert.isFalse(device.readings[1].live);
        Assert.isNull(device.liveNote);
    }

    @IsTest
    static void aCooledDeviceShowsNoAlertEvenIfTheLastSavedReadingHadOne() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        PatientDeviceService.Device device = PatientDeviceService.devicesFor(both[0].account.Id, 5)[0];
        device.readings[0].roomTemperatureAlert = true;

        PatientDeviceService.addLatest(device, awsAnswer(200, '2026-11-19T23:00:00.000Z', 19.2, false));
        Assert.isFalse(device.readings[0].roomTemperatureAlert, 'AWS says the episode ended');

        device = PatientDeviceService.devicesFor(both[0].account.Id, 5)[0];
        device.readings[0].roomTemperatureAlert = true;
        PatientDeviceService.addLatest(device, awsAnswer(200, '2026-11-19T23:00:00.000Z', 19.2));
        Assert.isFalse(device.readings[0].roomTemperatureAlert, 'No flag from AWS is no alert');
    }

    @IsTest
    static void anOlderReadingFromAwsIsIgnored() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        PatientDeviceService.Device device = PatientDeviceService.devicesFor(both[0].account.Id, 5)[0];

        PatientDeviceService.addLatest(device, awsAnswer(200, '2026-11-01T00:00:00.000Z', 20));

        Assert.areEqual(2, device.readings.size(), 'The saved readings are already newer');
        Assert.isFalse(device.readings[0].live);
    }

    @IsTest
    static void aFailedAwsCallKeepsTheSavedReadings() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 403;
        Test.setMock(HttpCalloutMock.class, aws);

        Test.startTest();
        List<PatientDeviceService.Device> mine =
            PatientDeviceService.withLatestFromAws(PatientDeviceService.devicesFor(both[0].account.Id, 5));
        Test.stopTest();

        Assert.areEqual(2, mine[0].readings.size());
        Assert.isTrue(mine[0].liveNote.contains('403'), mine[0].liveNote);
        Assert.areEqual(new List<String>{ 'device-live' }, aws.paths);
        Assert.areEqual(PatientPortalTestData.SERIAL_A, aws.bodies[0].get('thingName'));
    }

    @IsTest
    static void aCalloutThatNeverAnsweredGivesItsReason() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        PatientDeviceService.Device device = PatientDeviceService.devicesFor(both[0].account.Id, 5)[0];
        DeviceApiClient.Result result = new DeviceApiClient.Result();
        result.statusCode = 0;
        result.body = 'You don\'t have read permissions on the User External Credential object.';

        PatientDeviceService.addLatest(device, result);

        Assert.isTrue(device.liveNote.contains('User External Credential'), device.liveNote);
        Assert.isFalse(device.readings[0].live);
    }

    @IsTest
    static void noReadingAtAwsSaysSo() {
        List<PatientPortalTestData.Patient> both = PatientPortalTestData.twoPatients();
        PatientDeviceService.Device device = PatientDeviceService.devicesFor(both[0].account.Id, 5)[0];

        PatientDeviceService.addLatest(device, awsAnswer(200, null, null));

        Assert.areEqual(2, device.readings.size());
        Assert.isTrue(device.liveNote.contains('no stored reading'), device.liveNote);
    }
}
