/*
 * DeviceHistoryAgentActionTest.cls
 *
 * Get Device History over a fake Data Cloud: the numbers a week of history
 * adds up to, the last 24 hours, the newest reading, and a plain message
 * instead of a guess when the device is unknown, the serial number is not
 * one, or Data Cloud cannot answer. No query is sent before the Asset is
 * found with the user's own access.
 */
@IsTest
private class DeviceHistoryAgentActionTest {

    private static final Datetime NOW = Datetime.newInstanceGmt(2026, 11, 27, 18, 0, 0);

    /** Answers each source's query from a list, or fails for some of them. */
    private class FakeQuerier implements DataCloudValueController.Querier {
        Map<String, List<Map<String, Object>>> answers = new Map<String, List<Map<String, Object>>>();
        Set<String> failFor = new Set<String>();
        List<String> asked = new List<String>();

        public List<Map<String, Object>> query(String sql) {
            asked.add(sql);
            for (String source : new List<String>{
                    DeviceHistoryAgentAction.DAILY, DeviceHistoryAgentAction.RAW, DeviceHistoryAgentAction.SILENCE }) {
                if (sql.contains(' FROM ' + source + ' ')) {
                    if (failFor.contains(source)) {
                        throw new CalloutException('Data Cloud is not set up in this org');
                    }
                    return answers.containsKey(source) ? answers.get(source) : new List<Map<String, Object>>();
                }
            }
            return new List<Map<String, Object>>();
        }
    }

    private static String username(String who) {
        return who + '@' + UserInfo.getOrganizationId() + '.example.com';
    }

    @TestSetup
    static void users() {
        User member = new User(
            Username = username('history-reader'), Email = 'history-reader@example.com', LastName = 'history-reader',
            Alias = 'histread', ProfileId = UserInfo.getProfileId(), TimeZoneSidKey = UserInfo.getTimeZone().getID(),
            LocaleSidKey = UserInfo.getLocale(), LanguageLocaleKey = UserInfo.getLanguage(), EmailEncodingKey = 'UTF-8');
        insert member;
        insert new PermissionSetAssignment(
            AssigneeId = member.Id,
            PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Patient_Care_Agent'].Id);
    }

    private static void device(String serialNumber) {
        Account patient = TestAccounts.patient('History Patient');
        insert patient;
        // The Asset trigger would provision the device in AWS.
        TriggerHandler.bypass('AssetTriggerHandler');
        insert new Asset(Name = 'Monitor ' + serialNumber, SerialNumber = serialNumber, AccountId = patient.Id, Status = 'Installed');
        TriggerHandler.clearBypass('AssetTriggerHandler');
    }

    private static FakeQuerier weekOfHistory() {
        FakeQuerier fake = new FakeQuerier();
        fake.answers.put(DeviceHistoryAgentAction.DAILY, new List<Map<String, Object>>{
            new Map<String, Object>{ 'reading_day__c' => '2026-11-27T00:00:00.000Z', 'readings_out_of_range__c' => 20,
                'minutes_out_of_range__c' => 10.0, 'max_temperature_c__c' => 31.2 },
            // Upper case and a Datetime on purpose: still read.
            new Map<String, Object>{ 'READING_DAY__C' => Datetime.newInstanceGmt(2026, 11, 25), 'readings_out_of_range__c' => 70,
                'minutes_out_of_range__c' => 35.0, 'max_temperature_c__c' => 33.04 }
        });
        fake.answers.put(DeviceHistoryAgentAction.RAW, new List<Map<String, Object>>{
            new Map<String, Object>{ 'readings__c' => 2880, 'readings_out_of_range__c' => 20,
                'max_temperature_c__c' => 31.2, 'last_reading_ts__c' => '2026-11-27 17:30:00' }
        });
        fake.answers.put(DeviceHistoryAgentAction.SILENCE, new List<Map<String, Object>>{
            new Map<String, Object>{ 'last_reading_ts__c' => '2026-11-27T17:00:00.000Z' }
        });
        return fake;
    }

    private static DeviceHistoryAgentAction.HistoryResult one(String deviceId, Integer days, FakeQuerier fake) {
        DeviceHistoryAgentAction.querier = fake;
        DeviceHistoryAgentAction.now = NOW;
        DeviceHistoryAgentAction.HistoryRequest req = new DeviceHistoryAgentAction.HistoryRequest();
        req.deviceId = deviceId;
        req.days = days;
        List<DeviceHistoryAgentAction.HistoryResult> results;
        User reader = [SELECT Id FROM User WHERE Username = :username('history-reader')];
        System.runAs(reader) {
            Test.startTest();
            results = DeviceHistoryAgentAction.getHistory(new List<DeviceHistoryAgentAction.HistoryRequest>{ req });
            Test.stopTest();
        }
        Assert.areEqual(1, results.size(), 'one result per request');
        return results[0];
    }

    @IsTest
    static void aWeekAddsUpFromTheInsightsAndTheRawReadings() {
        device('Test8');
        FakeQuerier fake = weekOfHistory();

        DeviceHistoryAgentAction.HistoryResult res = one('Test8', null, fake);

        Assert.isTrue(res.success, res.message);
        Assert.areEqual(3, fake.asked.size(), 'three queries, one per source');
        Assert.areEqual(7, res.days, '7 days when the agent does not say');
        Assert.areEqual(2, res.daysWithAlerts);
        Assert.areEqual(45, res.minutesAtOrAbove.intValue());
        Assert.areEqual(33.04, res.highestTemperature);
        Assert.areEqual(2880, res.last24hReadings);
        Assert.areEqual(10, res.last24hMinutesAtOrAbove.intValue(), '20 readings at one every 30 seconds');
        Assert.areEqual(31.2, res.last24hHighest);
        Assert.areEqual(Datetime.newInstanceGmt(2026, 11, 27, 17, 30, 0), res.lastReadingAt, 'the fresher of the two sources');
        Assert.areEqual(30, res.lastReadingAgeMinutes);
        Assert.areEqual(30.0, res.thresholdCelsius);
        Assert.areEqual('2026-11-27: about 10 minutes at or above 30.0 C (20 readings), highest 31.2 C\n'
            + '2026-11-25: about 35 minutes at or above 30.0 C (70 readings), highest 33.0 C', res.dailyLines);
        Assert.areEqual('Test8, last 7 days: at or above 30.0 C on 2 days, about 45 minutes in all, highest 33.0 C. '
            + 'Last 24 hours: 2880 readings, about 10 minutes at or above 30.0 C, highest 31.2 C. '
            + 'Newest reading in Data Cloud: 2026-11-27 17:30 UTC (30 minutes ago).', res.summary);
        Assert.areEqual(DeviceHistoryAgentAction.NOTICE, res.notice);
    }

    @IsTest
    static void theSqlNamesOnlyTheDeviceAndStartTimesApexWrote() {
        device('Test8');
        FakeQuerier fake = weekOfHistory();

        one('Test8', 3, fake);

        String daily = fake.asked[0];
        Assert.isTrue(daily.contains(' FROM Room_Out_Of_Range_Daily__cio '), daily);
        Assert.isTrue(daily.contains('device_id__c = \'Test8\''), daily);
        Assert.isTrue(daily.contains('reading_day__c >= TIMESTAMP \'2026-11-25 00:00:00\''), '3 days counting today: ' + daily);
        String raw = fake.asked[1];
        Assert.isTrue(raw.contains(' FROM Room_Readings__dlm '), raw);
        Assert.isTrue(raw.contains('temperature_c__c >= 30.0 THEN 1'), raw);
        Assert.isTrue(raw.contains('reading_ts__c >= TIMESTAMP \'2026-11-26 18:00:00\''), '24 hours back: ' + raw);
        Assert.isTrue(fake.asked[2].contains(' FROM Room_Device_Silence__cio '), fake.asked[2]);
        for (String sql : fake.asked) {
            Assert.isFalse(sql.contains(';'), 'one statement only: ' + sql);
        }
    }

    @IsTest
    static void aQuietWeekSaysSo() {
        device('Test8');
        FakeQuerier fake = new FakeQuerier();
        fake.answers.put(DeviceHistoryAgentAction.SILENCE, new List<Map<String, Object>>{
            new Map<String, Object>{ 'last_reading_ts__c' => '2026-11-25T18:00:00.000Z' }
        });

        DeviceHistoryAgentAction.HistoryResult res = one('Test8', 7, fake);

        Assert.isTrue(res.success, res.message);
        Assert.areEqual(0, res.daysWithAlerts);
        Assert.areEqual(2880, res.lastReadingAgeMinutes, 'two days quiet');
        Assert.areEqual('Test8, last 7 days: no reading at or above 30.0 C. No readings in the last 24 hours. '
            + 'Newest reading in Data Cloud: 2026-11-25 18:00 UTC (2880 minutes ago).', res.summary);
    }

    @IsTest
    static void onePartFailingLeavesTheOthersAndSaysWhichIsMissing() {
        device('Test8');
        FakeQuerier fake = weekOfHistory();
        fake.failFor.add(DeviceHistoryAgentAction.DAILY);

        DeviceHistoryAgentAction.HistoryResult res = one('Test8', 7, fake);

        Assert.isTrue(res.success, res.message);
        Assert.isTrue(res.message.contains('without its daily totals'), res.message);
        Assert.isFalse(res.summary.contains('last 7 days'), 'no claim about days it could not read: ' + res.summary);
        Assert.areEqual(2880, res.last24hReadings);
    }

    @IsTest
    static void dataCloudDownIsAFailureNotAnEmptyHistory() {
        device('Test8');
        FakeQuerier fake = weekOfHistory();
        fake.failFor.addAll(new List<String>{
            DeviceHistoryAgentAction.DAILY, DeviceHistoryAgentAction.RAW, DeviceHistoryAgentAction.SILENCE });

        DeviceHistoryAgentAction.HistoryResult res = one('Test8', 7, fake);

        Assert.isFalse(res.success);
        Assert.isTrue(res.message.contains('Data Cloud could not be queried'), res.message);
        Assert.isNull(res.summary, 'no summary to quote');
    }

    @IsTest
    static void anUnknownDeviceSendsNoQuery() {
        FakeQuerier fake = weekOfHistory();

        DeviceHistoryAgentAction.HistoryResult res = one('Test9', 7, fake);

        Assert.isFalse(res.success);
        Assert.areEqual('No device with serial number Test9 that you have access to.', res.message);
        Assert.areEqual(0, fake.asked.size(), 'Data Cloud is never asked about a device the user cannot see');
    }

    @IsTest
    static void somethingThatIsNotASerialNumberNeverReachesTheSql() {
        FakeQuerier fake = weekOfHistory();

        DeviceHistoryAgentAction.HistoryResult res = one('Test8\' OR 1=1 --', 7, fake);

        Assert.isFalse(res.success);
        Assert.isTrue(res.message.startsWith('That is not a device serial number'), res.message);
        Assert.isFalse(res.message.contains('OR 1=1'), 'the input is not echoed');
        Assert.areEqual(0, fake.asked.size());
    }

    @IsTest
    static void daysAreKeptBetweenOneAndThirty() {
        Assert.areEqual(7, DeviceHistoryAgentAction.clampDays(null));
        Assert.areEqual(7, DeviceHistoryAgentAction.clampDays(0));
        Assert.areEqual(1, DeviceHistoryAgentAction.clampDays(1));
        Assert.areEqual(30, DeviceHistoryAgentAction.clampDays(365));
    }

    @IsTest
    static void timesAreReadInTheShapesDataCloudSends() {
        Datetime expected = Datetime.newInstanceGmt(2026, 11, 19, 20, 5, 0);
        Assert.areEqual(expected, DeviceHistoryAgentAction.toDatetime('2026-11-19T20:05:00.000Z'));
        Assert.areEqual(expected, DeviceHistoryAgentAction.toDatetime('2026-11-19 20:05:00'));
        Assert.areEqual(Datetime.newInstanceGmt(2026, 11, 19), DeviceHistoryAgentAction.toDatetime('2026-11-19'));
        Assert.isNull(DeviceHistoryAgentAction.toDatetime('not a time'));
        Assert.areEqual(31.5, DeviceHistoryAgentAction.toDecimal('31.5'));
        Assert.isNull(DeviceHistoryAgentAction.toDecimal('warm'));
    }

    @IsTest
    static void anEmptyRequestIsAnsweredPlainly() {
        DeviceHistoryAgentAction.querier = new FakeQuerier();
        List<DeviceHistoryAgentAction.HistoryResult> results = DeviceHistoryAgentAction.getHistory(
            new List<DeviceHistoryAgentAction.HistoryRequest>{ new DeviceHistoryAgentAction.HistoryRequest() });
        Assert.isFalse(results[0].success);
        Assert.areEqual('A device ID (the device serial number) is required.', results[0].message);
        Assert.areEqual(0, DeviceHistoryAgentAction.getHistory(null).size());
    }
}
