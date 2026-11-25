/*
 * PatientVitalsRetentionJobTest.cls
 *
 * Covers PatientVitalsRetentionJob: records older than
 * Vitals_Retention_Days__c are deleted, newer ones kept, and a blank setting
 * keeps everything.
 */
@IsTest
private class PatientVitalsRetentionJobTest {

    private static Patient_Vitals__c reading(String key, Integer daysOld) {
        Patient_Vitals__c vital = new Patient_Vitals__c(
            Device__c = 'Test8', Device_Reading_Id__c = 'Test8-' + key, Temperature__c = 22.5,
            Timestamp__c = Datetime.now().addDays(-daysOld), Patient_State__c = 'STABLE'
        );
        TriggerHandler.bypass('PatientVitalsTriggerHandler');
        insert vital;
        TriggerHandler.clearBypass('PatientVitalsTriggerHandler');
        Test.setCreatedDate(vital.Id, Datetime.now().addDays(-daysOld));
        return vital;
    }

    @IsTest
    static void recordsOlderThanTheRetentionAreDeletedAndNewerOnesKept() {
        DeviceTestSettings.use();   // 90 days
        Patient_Vitals__c old = reading('old', 120);
        Patient_Vitals__c recent = reading('recent', 10);

        Test.startTest();
        Database.executeBatch(new PatientVitalsRetentionJob(), 2000);
        Test.stopTest();

        Assert.areEqual(0, [SELECT COUNT() FROM Patient_Vitals__c WHERE Id = :old.Id]);
        Assert.areEqual(1, [SELECT COUNT() FROM Patient_Vitals__c WHERE Id = :recent.Id]);
    }

    @IsTest
    static void aBlankRetentionKeepsEverything() {
        DeviceTestSettings.use().Vitals_Retention_Days__c = null;
        Patient_Vitals__c old = reading('old', 400);

        Test.startTest();
        Database.executeBatch(new PatientVitalsRetentionJob(), 2000);
        Test.stopTest();

        Assert.areEqual(1, [SELECT COUNT() FROM Patient_Vitals__c WHERE Id = :old.Id]);
    }

    @IsTest
    static void theScheduleStartsTheBatch() {
        DeviceTestSettings.use();
        Test.startTest();
        String jobId = System.schedule('Patient vitals retention test', '0 0 2 * * ?', new PatientVitalsRetentionJob());
        Test.stopTest();
        Assert.isNotNull(jobId);
    }
}
