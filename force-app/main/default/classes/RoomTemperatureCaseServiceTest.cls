/*
 * RoomTemperatureCaseServiceTest.cls
 *
 * Covers Patient_Vitals__c insert -> PatientVitalsTrigger ->
 * PatientVitalsTriggerHandler -> RoomTemperatureCaseService: one open Case
 * per device from a flagged reading, owned by the configured queue and
 * linked to the device's Asset, and one dose per new Case within the
 * cooldown. When a reading counts (30 C, the throttle) is AWS's decision and
 * is tested in test/lambda/patient-vitals.test.js; here a reading counts
 * when Room_Temperature_Alert__c is true.
 */
@IsTest
private class RoomTemperatureCaseServiceTest {

    private static final String ARN_PREFIX = 'arn:aws:iot:us-east-2:111122223333:thing/';
    private static final String QUEUE = 'RoomTempTestQueue';
    private static final String NO_CASE_QUEUE = 'RoomTempNoCaseQueue';
    private static final String ORIGIN = 'Room Temperature Rule';
    private static Integer readingNumber = 0;

    @TestSetup
    static void queues() {
        // Group and QueueSobject are setup objects: mixed DML forces runAs.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Group caseQueue = new Group(Name = 'Room Temp Test Queue', DeveloperName = QUEUE, Type = 'Queue');
            Group noCases = new Group(Name = 'Room Temp No Case Queue', DeveloperName = NO_CASE_QUEUE, Type = 'Queue');
            insert new List<Group>{ caseQueue, noCases };
            insert new QueueSobject(QueueId = caseQueue.Id, SobjectType = 'Case');
        }
    }

    /** Every test starts here: the static override does not survive @TestSetup. */
    private static Device_Platform_Setting__mdt settings() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Room_Temp_Case_Queue__c = QUEUE;
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        return settings;
    }

    private static Id queueId(String developerName) {
        return [SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = :developerName].Id;
    }

    /** Provisioned devices whose serial number is their Thing name, saved without the Asset trigger. */
    private static List<Asset> devices(List<String> thingNames) {
        Account patient = TestAccounts.patient('Room Temp Patient');
        insert patient;
        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < thingNames.size(); i++) {
            devices.add(new Asset(
                Name = 'Device ' + thingNames[i], SerialNumber = thingNames[i], AccountId = patient.Id, Status = 'Installed',
                Thing_ARN__c = ARN_PREFIX + thingNames[i], Provisioning_Status__c = 'Provisioned'
            ));
        }
        TriggerHandler.bypass('AssetTriggerHandler');
        insert devices;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return devices;
    }

    private static Asset device(String thingName) {
        return devices(new List<String>{ thingName })[0];
    }

    private static Patient_Vitals__c reading(String deviceId, Decimal temperature, Boolean flagged) {
        readingNumber++;
        Datetime at = Datetime.newInstanceGmt(2026, 11, 6, 12, 0, 0).addSeconds(30 * readingNumber);
        return new Patient_Vitals__c(
            Device__c = deviceId,
            Device_Reading_Id__c = deviceId + '-' + readingNumber,
            Temperature__c = temperature,
            Humidity__c = 41,
            Timestamp__c = at,
            Patient_State__c = 'STABLE',
            Source_System__c = 'AWS_IoT',
            Room_Temperature_Alert__c = flagged
        );
    }

    private static Patient_Vitals__c hot(String deviceId) {
        return reading(deviceId, 30.0, true);
    }

    private static List<Case> ruleCases() {
        return [SELECT Id, Origin, Priority, AssetId, OwnerId, Subject, Description, Status
                FROM Case WHERE Origin = :ORIGIN ORDER BY CreatedDate, Id];
    }

    // Only the doses.
    private static List<Device_Command__c> doses() {
        return [SELECT Device__c, Command__c, Requested_By__c FROM Device_Command__c
                WHERE Command__c = 'DISPENSE_MEDICATION' ORDER BY CreatedDate, Id];
    }

    private static void close(Case roomCase) {
        update new Case(Id = roomCase.Id, Status = 'Closed');
    }

    @IsTest
    static void noRuleCaseYetOpensOneOwnedByTheQueueAndLinkedToTheAsset() {
        settings();
        Asset test8 = device('Test8');

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        List<Case> cases = ruleCases();
        Assert.areEqual(1, cases.size(), 'One Case');
        Assert.areEqual(ORIGIN, cases[0].Origin, 'Marked as the rule\'s own');
        Assert.areEqual('High', cases[0].Priority, 'Priority');
        Assert.areEqual(test8.Id, cases[0].AssetId, 'Linked to the device');
        Assert.areEqual(queueId(QUEUE), cases[0].OwnerId, 'Owned by the queue');
        Assert.isTrue(cases[0].Subject.contains('30.0'), cases[0].Subject);
        Assert.isTrue(cases[0].Subject.contains('Test8'), cases[0].Subject);
        Assert.isTrue(cases[0].Description.contains('not a clinical alert'), cases[0].Description);
    }

    @IsTest
    static void anOpenRuleCaseMeansNoNewOne() {
        settings();
        device('Test8');

        Test.startTest();
        insert hot('Test8');
        insert hot('Test8');
        Test.stopTest();

        Assert.areEqual(1, ruleCases().size(), 'Still one open Case');
    }

    @IsTest
    static void onlyClosedRuleCasesMeansANewOne() {
        settings();
        Asset test8 = device('Test8');
        insert new Case(Subject = 'Earlier', Origin = ORIGIN, AssetId = test8.Id, Status = 'Closed');

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        List<Case> cases = ruleCases();
        Assert.areEqual(2, cases.size(), 'The closed one and a new one');
        Assert.areNotEqual('Closed', cases[1].Status, 'The new one is open');
    }

    @IsTest
    static void anOpenCaseWithAnotherOriginDoesNotCount() {
        settings();
        Asset test8 = device('Test8');
        insert new Case(Subject = 'Escalation', Origin = 'Agentforce', AssetId = test8.Id);

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        Assert.areEqual(1, ruleCases().size(), 'A rule Case is still opened');
    }

    @IsTest
    static void twoFlaggedReadingsOfOneDeviceInOneBatchOpenOneCase() {
        settings();
        device('Test8');

        Test.startTest();
        insert new List<Patient_Vitals__c>{ hot('Test8'), reading('Test8', 31.0, true) };
        Test.stopTest();

        List<Case> cases = ruleCases();
        Assert.areEqual(1, cases.size(), 'One Case for the device');
        Assert.isTrue(cases[0].Subject.contains('30.0'), 'The first reading wins: ' + cases[0].Subject);
        Assert.areEqual(1, doses().size(), 'One dose');
    }

    @IsTest
    static void unflaggedReadingsCostNoQueryAndNoDml() {
        settings();
        device('Test8');

        Test.startTest();
        Integer queries = Limits.getQueries();
        Integer dml = Limits.getDmlStatements();
        insert new List<Patient_Vitals__c>{ reading('Test8', 36.8, false), reading('Test8', 38.7, false) };
        Integer activeQueries = Limits.getQueries() - queries;
        Integer activeDml = Limits.getDmlStatements() - dml;

        TriggerHandler.bypass('PatientVitalsTriggerHandler');
        queries = Limits.getQueries();
        dml = Limits.getDmlStatements();
        insert new List<Patient_Vitals__c>{ reading('Test8', 36.8, false), reading('Test8', 38.7, false) };
        Integer bypassedQueries = Limits.getQueries() - queries;
        Integer bypassedDml = Limits.getDmlStatements() - dml;
        TriggerHandler.clearBypass('PatientVitalsTriggerHandler');
        Test.stopTest();

        Assert.areEqual(bypassedQueries, activeQueries, 'No query for unflagged readings');
        Assert.areEqual(bypassedDml, activeDml, 'No DML for unflagged readings');
        Assert.areEqual(0, ruleCases().size(), 'Body temperatures above 30 C open nothing');
    }

    @IsTest
    static void flaggedFalseIsTheAwsSideOf29point9() {
        settings();
        device('Test8');

        Test.startTest();
        insert reading('Test8', 29.9, false);
        Assert.areEqual(0, [SELECT COUNT() FROM Case WHERE Origin = :ORIGIN], 'Not flagged: no Case');
        insert reading('Test8', 30.0, true);
        Test.stopTest();

        Assert.areEqual(1, ruleCases().size(), 'Flagged: one Case');
    }

    @IsTest
    static void flaggedWithNullTemperatureIsSkippedAndOthersStillOpen() {
        settings();
        devices(new List<String>{ 'Test8', 'Test9' });

        Test.startTest();
        insert new List<Patient_Vitals__c>{ reading('Test8', null, true), hot('Test9') };
        Test.stopTest();

        List<Case> cases = [SELECT Asset.SerialNumber FROM Case WHERE Origin = :ORIGIN];
        Assert.areEqual(1, cases.size(), 'Only the reading with a temperature');
        Assert.areEqual('Test9', cases[0].Asset.SerialNumber, 'For the other device');
    }

    @IsTest
    static void oneDispenseCommandPerNewCase() {
        settings();
        device('Test8');

        Test.startTest();
        insert hot('Test8');
        insert hot('Test8');
        Test.stopTest();

        List<Device_Command__c> commands = doses();
        Assert.areEqual(1, commands.size(), 'One dose while the Case is open');
        Assert.areEqual('DISPENSE_MEDICATION', commands[0].Command__c, 'Command');
        Assert.areEqual(ORIGIN, commands[0].Requested_By__c, 'Requested by the rule');
        Assert.areEqual('Test8', commands[0].Device__c, 'For the device');
        Assert.isTrue(ruleCases()[0].Description.contains('Dose: requested'), ruleCases()[0].Description);
    }

    @IsTest
    static void aClosedCaseInsideTheCooldownGetsANewCaseButNoDose() {
        settings();
        device('Test8');

        Test.startTest();
        insert hot('Test8');
        close(ruleCases()[0]);
        insert hot('Test8');
        Test.stopTest();

        List<Case> cases = ruleCases();
        Assert.areEqual(2, cases.size(), 'A new Case after the first was closed');
        Assert.areEqual(1, doses().size(), 'But no second dose inside the cooldown');
        Assert.isTrue(cases[1].Description.contains('not requested, a dose was requested'), cases[1].Description);
        Assert.isTrue(cases[1].Description.contains('60 minutes'), cases[1].Description);
    }

    @IsTest
    static void noCommandWhenDispenseIsOff() {
        settings().Room_Temp_Dispense__c = false;
        device('Test8');

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        Assert.areEqual(1, ruleCases().size(), 'The Case is still opened');
        Assert.areEqual(0, doses().size(), 'No dose');
        Assert.isTrue(ruleCases()[0].Description.contains('automatic dosing is switched off'), ruleCases()[0].Description);
    }

    @IsTest
    static void noAssetMeansNoCaseAndTheVitalsStillSave() {
        settings();

        Test.startTest();
        insert hot('NoSuchBoard');
        Test.stopTest();

        Assert.areEqual(1, [SELECT COUNT() FROM Patient_Vitals__c WHERE Device__c = 'NoSuchBoard'], 'The reading saved');
        Assert.areEqual(0, ruleCases().size(), 'Nothing to link a Case to');
        Assert.areEqual(0, doses().size(), 'And no dose');
    }

    @IsTest
    static void anAssetWhoseThingIsAnotherBoardIsNotMatched() {
        settings();
        // Its serial number was edited after it was provisioned as Test7.
        Asset renamed = device('Test7');
        renamed.SerialNumber = 'Test8';
        TriggerHandler.bypass('AssetTriggerHandler');
        update renamed;
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        Assert.areEqual(0, ruleCases().size(), 'Matched as Device Commands are: serial number and Thing name');
    }

    @IsTest
    static void missingQueueFallsBackToTheDefaultOwner() {
        settings().Room_Temp_Case_Queue__c = 'NoSuchQueue';
        device('Test8');

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        List<Case> cases = ruleCases();
        Assert.areEqual(1, cases.size(), 'The Case is still opened');
        Assert.areEqual(UserInfo.getUserId(), cases[0].OwnerId, 'Owned by whoever inserted the reading');
    }

    @IsTest
    static void aQueueThatDoesNotAcceptCasesFallsBackToTheDefaultOwner() {
        settings().Room_Temp_Case_Queue__c = NO_CASE_QUEUE;
        device('Test8');

        Test.startTest();
        insert hot('Test8');
        Test.stopTest();

        List<Case> cases = ruleCases();
        Assert.areEqual(1, cases.size(), 'The Case is still opened');
        Assert.areEqual(UserInfo.getUserId(), cases[0].OwnerId, 'Owned by whoever inserted the reading');
    }

    @IsTest
    static void aBlankSettingSkipsTheRuleButTheVitalsSave() {
        settings().Room_Temp_Case_Origin__c = '';
        device('Test8');

        Test.startTest();
        Database.SaveResult result = Database.insert(hot('Test8'), false);
        Test.stopTest();

        Assert.isTrue(result.isSuccess(), 'The reading saved');
        Assert.areEqual(0, [SELECT COUNT() FROM Case], 'No Case');
        Assert.areEqual(0, doses().size(), 'No dose');
    }

    @IsTest
    static void worksAsTheIntegrationUser() {
        settings();
        Asset test8 = device('Test8');
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            String who = 'room-temp-' + EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(8);
            integration = new User(
                Username          = who + '@' + UserInfo.getOrganizationId() + '.example.com',
                Email             = who + '@example.com',
                LastName          = who,
                Alias             = 'roomtmp',
                ProfileId         = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce'].Id,
                TimeZoneSidKey    = 'GMT',
                LocaleSidKey      = 'en_US',
                LanguageLocaleKey = 'en_US',
                EmailEncodingKey  = 'UTF-8'
            );
            insert integration;
            insert new PermissionSetAssignment(
                AssigneeId      = integration.Id,
                PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Device_Integration'].Id
            );
        }

        System.runAs(integration) {
            Test.startTest();
            insert hot('Test8');
            Test.stopTest();
        }

        List<Case> cases = ruleCases();
        Assert.areEqual(1, cases.size(), 'The Case is opened for the integration user');
        Assert.areEqual(queueId(QUEUE), cases[0].OwnerId, 'Owned by the queue');
        Assert.areEqual(test8.Id, cases[0].AssetId, 'Linked to the device');
        Assert.areEqual(1, [SELECT COUNT() FROM Device_Command__c
                            WHERE Device__c = 'Test8' AND Command__c = 'DISPENSE_MEDICATION'], 'And the dose requested');
        Assert.areEqual(0, [SELECT COUNT() FROM Device_Command__c WHERE Command__c = 'CASE_ALERT'],
            'No case alert: since firmware 2.5.0 the board\'s motor follows its own room');
    }

    @IsTest
    static void bulk200DevicesUseConstantQueriesAndDml() {
        settings();
        List<String> names = new List<String>();
        for (Integer i = 0; i < 201; i++) {
            names.add('Bulk-' + i);
        }
        devices(names);
        List<Patient_Vitals__c> two00 = new List<Patient_Vitals__c>();
        for (Integer i = 1; i < 201; i++) {
            two00.add(hot(names[i]));
        }
        // Measures only this service; the send path has its own bulk test.
        TriggerHandler.bypass('DeviceCommandTriggerHandler');

        Test.startTest();
        Integer queries = Limits.getQueries();
        Integer dml = Limits.getDmlStatements();
        insert hot(names[0]);
        Integer oneQueries = Limits.getQueries() - queries;
        Integer oneDml = Limits.getDmlStatements() - dml;

        queries = Limits.getQueries();
        dml = Limits.getDmlStatements();
        insert two00;
        Integer manyQueries = Limits.getQueries() - queries;
        Integer manyDml = Limits.getDmlStatements() - dml;
        Test.stopTest();

        Assert.areEqual(oneQueries, manyQueries, 'The same queries for 1 device and for 200');
        Assert.areEqual(oneDml, manyDml, 'The same DML statements for 1 device and for 200');
        Assert.areEqual(201, ruleCases().size(), 'A Case for every device');
        Assert.areEqual(201, doses().size(), 'And a dose for every Case');
    }
}
