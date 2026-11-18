@IsTest
private class ValueSnapshotServiceTest {

    private static Value_Assumption__mdt assumption(String phase) {
        return new Value_Assumption__mdt(
            DeveloperName = 'Default', Phase__c = phase, Window_Days__c = 7,
            Manual_Check_Minutes__c = 3, Manual_Checks_Per_Device_Day__c = 12,
            Baseline_Minutes_To_Respond__c = 60, Nurse_Minutes_Per_Request__c = 5,
            Staff_Hourly_Rate__c = 60, Agent_Actions_Per_Chat__c = 3, Cost_Per_Agent_Action__c = 0.10);
    }

    private static ValueSnapshotService.Inputs inputs() {
        ValueSnapshotService.Inputs i = new ValueSnapshotService.Inputs();
        i.windowDays = 7;
        i.activeDevices = 2;
        i.onlineDevices = 1;
        i.alertsOpened = 4;
        i.alertsClosed = 3;
        i.avgMinutesToClose = 15;
        i.chats = 10;
        i.nurseRequests = 2;
        i.staffEscalations = 1;
        i.awsMonthToDate = 3.00;
        i.dayOfMonth = 10;
        i.daysInMonth = 30;
        return i;
    }

    @IsTest
    static void valuesTimeAndMoneyFromTheMeasurements() {
        Value_Snapshot__c s = ValueSnapshotService.compute(inputs(), assumption('After'), Date.newInstance(2026, 11, 10));

        Assert.areEqual('2026-11-10', s.Snapshot_Key__c);
        Assert.areEqual('After', s.Phase__c);
        Assert.areEqual(50.0, s.Devices_Online_Pct__c);
        Assert.areEqual(75.0, s.Response_Improvement_Pct__c, '15 min against a 60 min baseline');
        Assert.areEqual(8, s.Chats_Agent_Handled__c);
        Assert.areEqual(80.0, s.Deflection_Rate_Pct__c);
        // 3 actions x 0.10 = 0.30 per chat; a nurse visit is 5 min at 60/h = 5.00.
        Assert.areEqual(6.0, s.Break_Even_Deflection_Pct__c);
        // 2 devices x 12 checks x 7 days x 3 min = 504 min.
        Assert.areEqual(8.4, s.Manual_Check_Hours_Avoided__c);
        Assert.areEqual(0.7, s.Nurse_Hours_Avoided__c, '8 chats x 5 min');
        Assert.areEqual(544.00, s.Staff_Time_Value__c, '(504 + 40) min at 60/h');
        Assert.areEqual(3.30, s.Agentforce_Cost__c, '(10 chats + 1 escalation) x 3 x 0.10');
        Assert.areEqual(2.10, s.Aws_Cost__c, '0.30 a day x 7');
        Assert.areEqual(4.50, s.Aws_Cost_Per_Device_Month__c, '0.30 x 30 / 2');
        Assert.areEqual(538.60, s.Net_Value__c);
        Assert.isTrue(s.Assumptions__c.contains('illustrative'));
    }

    @IsTest
    static void baselinePhaseAvoidsNothingYet() {
        Value_Snapshot__c s = ValueSnapshotService.compute(inputs(), assumption('Baseline'), Date.today());
        Assert.areEqual('Baseline', s.Phase__c);
        Assert.areEqual(0, s.Manual_Check_Hours_Avoided__c);
        Assert.areEqual(0, s.Staff_Time_Value__c);
    }

    @IsTest
    static void emptyOrgGivesBlanksNotDivisionErrors() {
        ValueSnapshotService.Inputs i = new ValueSnapshotService.Inputs();
        i.windowDays = 7;
        i.dayOfMonth = 1;
        i.daysInMonth = 30;
        Value_Snapshot__c s = ValueSnapshotService.compute(i, assumption('After'), Date.today());
        Assert.isNull(s.Devices_Online_Pct__c);
        Assert.isNull(s.Deflection_Rate_Pct__c);
        Assert.isNull(s.Response_Improvement_Pct__c);
        Assert.isNull(s.Aws_Cost__c);
        Assert.areEqual(0, s.Net_Value__c);
    }

    @IsTest
    static void oneSnapshotPerDayFromTheOrgsRecords() {
        ValueSnapshotService.testAssumption = assumption('After');
        ValueSnapshotService.testChats = 5;
        ValueSnapshotService.testToday = Date.today();

        Account patient = TestAccounts.patient('Value Patient');
        insert patient;
        Asset device = new Asset(Name = 'Value Device', SerialNumber = 'ValueTest1', AccountId = patient.Id,
            Status = 'Installed', Provisioning_Status__c = 'Provisioned', Connection_Status__c = 'Online');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        Value_Snapshot__c first = ValueSnapshotService.takeSnapshot();
        List<Id> again = ValueSnapshotJob.takeNow(new List<String>{ null });
        Test.stopTest();

        Assert.areEqual(first.Id, again[0], 'a second run the same day updates the day\'s record');
        Value_Snapshot__c saved = [
            SELECT Active_Devices__c, Devices_Online_Pct__c, Portal_Chats__c, Snapshot_Date__c
            FROM Value_Snapshot__c
        ];
        Assert.areEqual(1, saved.Active_Devices__c);
        Assert.areEqual(100.0, saved.Devices_Online_Pct__c);
        Assert.areEqual(5, saved.Portal_Chats__c);
        Assert.areEqual(Date.today(), saved.Snapshot_Date__c);
    }

    @IsTest
    static void theScheduledJobTakesASnapshot() {
        ValueSnapshotService.testAssumption = assumption('After');
        ValueSnapshotService.testChats = 0;
        Test.startTest();
        System.schedule('Business Value snapshot test', '0 0 1 * * ?', new ValueSnapshotJob());
        new ValueSnapshotJob().execute(null);
        Test.stopTest();
        Assert.areEqual(1, [SELECT COUNT() FROM Value_Snapshot__c]);
    }

    @IsTest
    static void onlyTheNewestSnapshotIsLatest() {
        ValueSnapshotService.testAssumption = assumption('After');
        ValueSnapshotService.testChats = 0;
        ValueSnapshotService.testToday = Date.today().addDays(-1);
        Id yesterday = ValueSnapshotService.takeSnapshot().Id;
        ValueSnapshotService.testToday = Date.today();
        Id today = ValueSnapshotService.takeSnapshot().Id;
        Assert.areEqual(today, [SELECT Id FROM Value_Snapshot__c WHERE Is_Latest__c = true].Id);
        Assert.isFalse([SELECT Is_Latest__c FROM Value_Snapshot__c WHERE Id = :yesterday].Is_Latest__c);
    }
}
