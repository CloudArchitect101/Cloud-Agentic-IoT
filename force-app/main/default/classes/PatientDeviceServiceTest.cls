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
}
