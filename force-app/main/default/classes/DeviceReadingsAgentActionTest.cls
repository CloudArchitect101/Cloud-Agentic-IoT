/*
 * DeviceReadingsAgentActionTest.cls
 *
 * The agent's read action: the latest readings of one device, newest first,
 * with the Asset's connection fields, and a plain message instead of a guess
 * when there is no such device, no reading, or a duplicate serial number.
 */
@IsTest
private class DeviceReadingsAgentActionTest {

    private static Integer readingNumber = 0;

    // Usernames are unique across every org, so these carry the org's Id.
    private static String username(String who) {
        return who + '@' + UserInfo.getOrganizationId() + '.example.com';
    }

    /**
     * A care team member who talks to the agent, and one who may not read
     * device data. The action reads in user mode, and fields deployed through
     * the Metadata API give no profile any field access, the deploying
     * admin's included, so the first gets it the way a real one does: from
     * Patient_Care_Agent. That also proves the permission set is enough.
     */
    @TestSetup
    static void users() {
        User member = user('agent-reader');
        User outsider = user('agent-outsider');
        insert new List<User>{ member, outsider };
        insert new PermissionSetAssignment(
            AssigneeId      = member.Id,
            PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Patient_Care_Agent'].Id
        );
    }

    private static User user(String who) {
        return new User(
            Username          = username(who),
            Email             = who + '@example.com',
            LastName          = who,
            Alias             = who.left(8),
            ProfileId         = UserInfo.getProfileId(),
            TimeZoneSidKey    = UserInfo.getTimeZone().getID(),
            LocaleSidKey      = UserInfo.getLocale(),
            LanguageLocaleKey = UserInfo.getLanguage(),
            EmailEncodingKey  = 'UTF-8'
        );
    }

    private static User member() {
        return [SELECT Id FROM User WHERE Username = :username('agent-reader')];
    }

    private static List<DeviceReadingsAgentAction.ReadingsResult> call(
            List<DeviceReadingsAgentAction.ReadingsRequest> requests) {
        List<DeviceReadingsAgentAction.ReadingsResult> results;
        System.runAs(member()) {
            Test.startTest();
            results = DeviceReadingsAgentAction.getLatestReadings(requests);
            Test.stopTest();
        }
        return results;
    }

    private static Asset device(String serialNumber) {
        Account patient = new Account(Name = 'Readings Patient');
        insert patient;
        Asset device = new Asset(
            Name = 'Monitor ' + serialNumber, SerialNumber = serialNumber, AccountId = patient.Id, Status = 'Installed',
            Connection_Status__c = 'Online', Connection_Since__c = Datetime.newInstanceGmt(2026, 11, 6, 8, 0, 0),
            Last_Telemetry_At__c = Datetime.newInstanceGmt(2026, 11, 6, 12, 30, 0)
        );
        // The Asset trigger would provision the device in AWS.
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    private static Patient_Vitals__c reading(String deviceId, Integer minute, Decimal heartRate) {
        readingNumber++;
        return new Patient_Vitals__c(
            Device__c = deviceId,
            Device_Reading_Id__c = deviceId + '-' + readingNumber,
            Timestamp__c = Datetime.newInstanceGmt(2026, 11, 6, 12, minute, 0),
            Heart_Rate__c = heartRate,
            SpO2__c = 97,
            Temperature__c = 36.8,
            Patient_State__c = 'STABLE',
            Risk_Score__c = 10,
            Source_System__c = 'AWS_IoT'
        );
    }

    private static DeviceReadingsAgentAction.ReadingsRequest req(String deviceId, Integer readingCount) {
        DeviceReadingsAgentAction.ReadingsRequest r = new DeviceReadingsAgentAction.ReadingsRequest();
        r.deviceId = deviceId;
        r.readingCount = readingCount;
        return r;
    }

    private static DeviceReadingsAgentAction.ReadingsResult one(String deviceId, Integer readingCount) {
        List<DeviceReadingsAgentAction.ReadingsResult> results = call(
            new List<DeviceReadingsAgentAction.ReadingsRequest>{ req(deviceId, readingCount) });
        Assert.areEqual(1, results.size(), 'One result per request');
        return results[0];
    }

    @IsTest
    static void lastTelemetryFallsBackToTheNewestReading() {
        Asset d = device('Test8');
        d.Last_Telemetry_At__c = null;
        TriggerHandler.bypass('AssetTriggerHandler');
        update d;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        insert new List<Patient_Vitals__c>{ reading('Test8', 1, 70), reading('Test8', 4, 72) };

        DeviceReadingsAgentAction.ReadingsResult res = one('Test8', 5);

        Assert.isTrue(res.success, res.message);
        Assert.areEqual(Datetime.newInstanceGmt(2026, 11, 6, 12, 4, 0), res.lastTelemetryAt,
            'With no Last Telemetry At on the Asset, the newest reading\'s time');
    }

    @IsTest
    static void returnsTheLatestReadingsNewestFirstWithTheConnection() {
        device('Test8');
        List<Patient_Vitals__c> rows = new List<Patient_Vitals__c>();
        for (Integer minute = 0; minute < 8; minute++) {
            rows.add(reading('Test8', minute, 70 + minute));
        }
        insert rows;

        DeviceReadingsAgentAction.ReadingsResult res = one('Test8', 3);

        Assert.isTrue(res.success, res.message);
        Assert.areEqual(3, res.readingsReturned, 'Only as many as asked for');
        Assert.areEqual(77, res.latestHeartRate, 'The newest reading is the latest');
        Assert.areEqual(Datetime.newInstanceGmt(2026, 11, 6, 12, 7, 0), res.latestReadingAt, 'Newest timestamp');
        Assert.areEqual('STABLE', res.latestPatientState, 'State of the newest reading');
        Assert.areEqual('Online', res.connectionStatus, 'The Asset\'s connection status');
        Assert.areEqual('Monitor Test8', res.deviceName, 'The Asset\'s name');
        Assert.areEqual(Datetime.newInstanceGmt(2026, 11, 6, 12, 30, 0), res.lastTelemetryAt, 'Last telemetry');

        List<String> lines = res.readings.split('\n');
        Assert.areEqual(3, lines.size(), 'One line per reading');
        Assert.isTrue(lines[0].startsWith('2026-11-06 12:07:00 UTC'), lines[0]);
        Assert.isTrue(lines[2].startsWith('2026-11-06 12:05:00 UTC'), lines[2]);
        Assert.isTrue(lines[0].contains('blood pressure not measured'), 'An unmeasured value says so: ' + lines[0]);
    }

    @IsTest
    static void defaultsToFiveAndCapsAtTwenty() {
        device('Test9');
        List<Patient_Vitals__c> rows = new List<Patient_Vitals__c>();
        for (Integer minute = 0; minute < 25; minute++) {
            rows.add(reading('Test9', minute, 80));
        }
        insert rows;

        List<DeviceReadingsAgentAction.ReadingsResult> results = call(
            new List<DeviceReadingsAgentAction.ReadingsRequest>{ req('Test9', null), req('Test9', 500), req('Test9', 0) });

        Assert.areEqual(DeviceReadingsAgentAction.DEFAULT_READINGS, results[0].readingsReturned, 'Default when not given');
        Assert.areEqual(DeviceReadingsAgentAction.MAX_READINGS, results[1].readingsReturned, 'Capped');
        Assert.areEqual(DeviceReadingsAgentAction.DEFAULT_READINGS, results[2].readingsReturned, 'Zero means the default');
    }

    @IsTest
    static void onlyTheNamedDevicesReadingsComeBack() {
        device('Test8');
        insert new List<Patient_Vitals__c>{ reading('Test8', 1, 72), reading('Other', 2, 140) };

        DeviceReadingsAgentAction.ReadingsResult res = one('Test8', 10);

        Assert.areEqual(1, res.readingsReturned, 'Another device\'s reading is not this one\'s');
        Assert.areEqual(72, res.latestHeartRate, 'This device\'s reading');
    }

    @IsTest
    static void anUnknownDeviceIsSaidPlainly() {
        DeviceReadingsAgentAction.ReadingsResult res = one('No-Such-Device', 5);

        Assert.isFalse(res.success, 'Nothing to answer from');
        Assert.isTrue(res.message.contains('No device with serial number No-Such-Device'), res.message);
        Assert.isNull(res.readings, 'No readings invented');
    }

    @IsTest
    static void aDeviceWithNoReadingsSucceedsWithNone() {
        device('Test10');

        DeviceReadingsAgentAction.ReadingsResult res = one('Test10', 5);

        Assert.isTrue(res.success, 'The device exists');
        Assert.areEqual(0, res.readingsReturned, 'No readings');
        Assert.isNull(res.latestHeartRate, 'No value invented');
        Assert.isTrue(res.message.contains('no readings'), res.message);
        Assert.areEqual('Online', res.connectionStatus, 'The connection is still reported');
    }

    @IsTest
    static void aDuplicateSerialNumberIsNotGuessedBetween() {
        device('Twin');
        device('Twin');
        insert reading('Twin', 1, 72);

        DeviceReadingsAgentAction.ReadingsResult res = one('Twin', 5);

        Assert.isFalse(res.success, 'Two devices: the readings belong to neither for sure');
        Assert.isTrue(res.message.contains('2 devices share serial number Twin'), res.message);
    }

    @IsTest
    static void aSerialNumberInAnotherCaseIsNotAMatch() {
        device('test8');

        DeviceReadingsAgentAction.ReadingsResult res = one('Test8', 5);

        Assert.isFalse(res.success, 'Serial numbers are matched case-sensitively, like the rest of the device code');
    }

    @IsTest
    static void aBlankDeviceIdIsRejectedWithoutFailingTheBatch() {
        device('Test8');
        insert reading('Test8', 1, 72);

        List<DeviceReadingsAgentAction.ReadingsResult> results = call(
            new List<DeviceReadingsAgentAction.ReadingsRequest>{ req(' ', 5), req('Test8', 5) });

        Assert.isFalse(results[0].success, 'Blank device ID');
        Assert.isTrue(results[0].message.contains('required'), results[0].message);
        Assert.isTrue(results[1].success, 'A bad request must not fail its neighbour');
    }

    @IsTest
    static void tooManyDevicesInOneCallAreRefusedNotQueriedPastTheLimit() {
        List<DeviceReadingsAgentAction.ReadingsRequest> many = new List<DeviceReadingsAgentAction.ReadingsRequest>();
        for (Integer i = 0; i < DeviceReadingsAgentAction.MAX_DEVICES_PER_CALL + 5; i++) {
            many.add(req('Device-' + i, 5));
        }

        List<DeviceReadingsAgentAction.ReadingsResult> results;
        Integer queries;
        System.runAs(member()) {
            Test.startTest();
            results = DeviceReadingsAgentAction.getLatestReadings(many);
            queries = Limits.getQueries();
            Test.stopTest();
        }

        Assert.areEqual(many.size(), results.size(), 'Every request gets a result');
        Assert.isTrue(results[results.size() - 1].message.startsWith('Too many devices'), results[results.size() - 1].message);
        Assert.isTrue(queries <= DeviceReadingsAgentAction.MAX_DEVICES_PER_CALL + 1, queries + ' queries');
    }

    @IsTest
    static void anEmptyCallReturnsNothing() {
        System.runAs(member()) {
            Assert.areEqual(0, DeviceReadingsAgentAction.getLatestReadings(new List<DeviceReadingsAgentAction.ReadingsRequest>()).size(),
                'No requests, no results');
            Assert.areEqual(0, DeviceReadingsAgentAction.getLatestReadings(null).size(), 'Null is treated as empty');
        }
    }

    @IsTest
    static void someoneWithoutThePermissionSetIsToldSo() {
        device('Test8');
        insert reading('Test8', 1, 72);
        User outsider = [SELECT Id FROM User WHERE Username = :username('agent-outsider')];

        DeviceReadingsAgentAction.ReadingsResult res;
        System.runAs(outsider) {
            Test.startTest();
            res = DeviceReadingsAgentAction.getLatestReadings(
                new List<DeviceReadingsAgentAction.ReadingsRequest>{ req('Test8', 5) })[0];
            Test.stopTest();
        }

        // Same profile, no Patient_Care_Agent: the device fields are out of
        // reach, user mode stops the read, and no reading reaches the agent.
        Assert.isFalse(res.success, 'Read as the user, not the system: ' + res.message);
        Assert.isNull(res.latestHeartRate, 'No reading leaks past the user\'s access');
        Assert.isTrue(res.message.contains('with your access'), res.message);
    }
}
