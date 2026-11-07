/*
 * CaseAlertServiceTest.cls
 *
 * Covers Case insert, update, delete and undelete -> CaseTrigger ->
 * CaseTriggerHandler -> CaseAlertService: a device's motor is turned on (one
 * CASE_ALERT Device Command, on) when its first Case in the care team queue
 * opens, and off when the last one leaves, and nothing is sent while the
 * state stays the same. The reconnect half is in DeviceConnectionServiceTest.
 *
 * The queue is one made here, never the org's Care_Team_Queue.
 */
@IsTest
private class CaseAlertServiceTest {

    private static final String ARN_PREFIX = 'arn:aws:iot:us-east-2:111122223333:thing/';
    private static final String QUEUE = 'CaseAlertTestQueue';
    private static final String OTHER_QUEUE = 'CaseAlertOtherQueue';

    @TestSetup
    static void queues() {
        // Group and QueueSobject are setup objects: mixed DML forces runAs.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Group careTeam = new Group(Name = 'Case Alert Test Queue', DeveloperName = QUEUE, Type = 'Queue');
            Group other = new Group(Name = 'Case Alert Other Queue', DeveloperName = OTHER_QUEUE, Type = 'Queue');
            insert new List<Group>{ careTeam, other };
            insert new List<QueueSobject>{
                new QueueSobject(QueueId = careTeam.Id, SobjectType = 'Case'),
                new QueueSobject(QueueId = other.Id, SobjectType = 'Case')
            };
        }
    }

    /** Every test starts here: the static override does not survive @TestSetup. */
    private static DeviceApiMock settings() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Room_Temp_Case_Queue__c = QUEUE;
        settings.Escalation_Case_Queue__c = QUEUE;
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        return aws;
    }

    private static Id queueId(String developerName) {
        return [SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = :developerName].Id;
    }

    /** Provisioned, online devices whose serial number is their Thing name, saved without the Asset trigger. */
    private static List<Asset> devices(List<String> thingNames) {
        Account patient = new Account(Name = 'Case Alert Patient');
        insert patient;
        List<Asset> devices = new List<Asset>();
        for (String thingName : thingNames) {
            devices.add(new Asset(
                Name = 'Device ' + thingName, SerialNumber = thingName, AccountId = patient.Id, Status = 'Installed',
                Thing_ARN__c = ARN_PREFIX + thingName, Provisioning_Status__c = 'Provisioned',
                Connection_Status__c = 'Online', Connection_Since__c = System.now().addHours(-1)
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

    private static Case waiting(Asset device) {
        return new Case(Subject = 'Waiting on ' + device.Name, AssetId = device.Id, OwnerId = queueId(QUEUE));
    }

    private static List<Device_Command__c> alerts() {
        return [SELECT Device__c, Command__c, Case_Alert_On__c, Asset__c, Status__c
                FROM Device_Command__c WHERE Command__c = 'CASE_ALERT' ORDER BY CreatedDate, Id];
    }

    private static Boolean alertShown(Id assetId) {
        return [SELECT Case_Alert_Active__c FROM Asset WHERE Id = :assetId].Case_Alert_Active__c;
    }

    @IsTest
    static void theFirstCaseInTheQueueTurnsTheMotorOn() {
        settings();
        Asset pm1 = device('PM-1');

        Test.startTest();
        insert waiting(pm1);
        Test.stopTest();

        List<Device_Command__c> alerts = alerts();
        Assert.areEqual(1, alerts.size(), 'One CASE_ALERT');
        Assert.areEqual('PM-1', alerts[0].Device__c, 'To the board of the Case\'s device');
        Assert.isTrue(alerts[0].Case_Alert_On__c, 'On');
        Assert.areEqual(pm1.Id, alerts[0].Asset__c, 'Linked to the device by the command trigger');
        Assert.isTrue(alertShown(pm1.Id), 'The device shows its case alert on');
    }

    @IsTest
    static void theSendJobTellsTheBoardOnOrOff() {
        DeviceApiMock aws = settings();
        Asset pm1 = device('PM-1');

        Test.startTest();
        insert waiting(pm1);
        Test.stopTest();

        Assert.areEqual(1, aws.bodies.size(), 'One call');
        Map<String, Object> body = aws.bodies[0];
        Assert.areEqual('PM-1', body.get('thingName'), 'To its board');
        Assert.areEqual('CASE_ALERT', body.get('operation'), 'The command');
        Assert.areEqual(true, body.get('active'), 'On');
        Assert.areEqual('Sent', alerts()[0].Status__c, 'Sent, and waiting for the board to answer');
    }

    @IsTest
    static void aSecondCaseSendsNothingMore() {
        settings();
        Asset pm1 = device('PM-1');
        insert waiting(pm1);

        Test.startTest();
        insert waiting(pm1);
        Test.stopTest();

        Assert.areEqual(1, alerts().size(), 'Still the one CASE_ALERT');
    }

    @IsTest
    static void closingTheLastCaseTurnsTheMotorOff() {
        settings();
        Asset pm1 = device('PM-1');
        Case firstCase = waiting(pm1);
        Case secondCase = waiting(pm1);
        insert new List<Case>{ firstCase, secondCase };

        Test.startTest();
        update new Case(Id = firstCase.Id, Status = 'Closed');
        Assert.areEqual(1, alerts().size(), 'One Case still waits, so nothing is sent');
        update new Case(Id = secondCase.Id, Status = 'Closed');
        Test.stopTest();

        List<Device_Command__c> alerts = alerts();
        Assert.areEqual(2, alerts.size(), 'On, then off');
        Assert.isFalse(alerts[1].Case_Alert_On__c, 'Off');
        Assert.isFalse(alertShown(pm1.Id), 'The device shows its case alert off');
    }

    @IsTest
    static void reopeningACaseTurnsTheMotorOnAgain() {
        settings();
        Asset pm1 = device('PM-1');
        Case theCase = waiting(pm1);
        insert theCase;
        update new Case(Id = theCase.Id, Status = 'Closed');

        Test.startTest();
        update new Case(Id = theCase.Id, Status = 'New');
        Test.stopTest();

        List<Device_Command__c> alerts = alerts();
        Assert.areEqual(3, alerts.size(), 'On, off, on');
        Assert.isTrue(alerts[2].Case_Alert_On__c, 'On again');
        Assert.isTrue(alertShown(pm1.Id), 'Shown on');
    }

    @IsTest
    static void givingTheCaseToAPersonTurnsTheMotorOff() {
        settings();
        Asset pm1 = device('PM-1');
        Case theCase = waiting(pm1);
        insert theCase;

        Test.startTest();
        update new Case(Id = theCase.Id, OwnerId = UserInfo.getUserId());
        Test.stopTest();

        List<Device_Command__c> alerts = alerts();
        Assert.areEqual(2, alerts.size(), 'On, then off');
        Assert.isFalse(alerts[1].Case_Alert_On__c, 'Off: someone has taken the Case');
        Assert.isFalse(alertShown(pm1.Id), 'Shown off');
    }

    @IsTest
    static void movingTheCaseToAnotherDeviceMovesTheAlert() {
        settings();
        List<Asset> boards = devices(new List<String>{ 'PM-1', 'PM-2' });
        Case theCase = waiting(boards[0]);
        insert theCase;

        Test.startTest();
        update new Case(Id = theCase.Id, AssetId = boards[1].Id);
        Test.stopTest();

        Map<String, Boolean> lastByBoard = new Map<String, Boolean>();
        for (Device_Command__c alert : alerts()) {
            lastByBoard.put(alert.Device__c, alert.Case_Alert_On__c);
        }
        Assert.areEqual(false, lastByBoard.get('PM-1'), 'The device it left is off');
        Assert.areEqual(true, lastByBoard.get('PM-2'), 'The device it is on now is on');
        Assert.isFalse(alertShown(boards[0].Id), 'PM-1 shown off');
        Assert.isTrue(alertShown(boards[1].Id), 'PM-2 shown on');
    }

    @IsTest
    static void deletingTheCaseTurnsTheMotorOffAndUndeletingTurnsItOn() {
        settings();
        Asset pm1 = device('PM-1');
        Case theCase = waiting(pm1);
        insert theCase;

        Test.startTest();
        delete theCase;
        Assert.isFalse(alertShown(pm1.Id), 'Off once the Case is deleted');
        undelete theCase;
        Test.stopTest();

        // The rule counts the restored Case only while the queue still owns
        // it, and Salesforce may hand an undeleted Case to whoever restored
        // it. So the expected state follows the owner the Case came back with.
        Case restored = [SELECT OwnerId, IsClosed FROM Case WHERE Id = :theCase.Id];
        Boolean inQueue = restored.OwnerId == queueId(QUEUE) && !restored.IsClosed;

        List<Device_Command__c> alerts = alerts();
        Assert.isFalse(alerts[1].Case_Alert_On__c, 'Off when deleted');
        if (inQueue) {
            Assert.areEqual(3, alerts.size(), 'On, off, on: ' + alerts);
            Assert.isTrue(alerts[2].Case_Alert_On__c, 'On when restored to the queue');
        } else {
            Assert.areEqual(2, alerts.size(), 'On, off, and nothing for a Case restored to a person: ' + alerts);
        }
        Assert.areEqual(inQueue, alertShown(pm1.Id), 'Shown on only when restored to the queue');
    }

    @IsTest
    static void casesThatDoNotWaitForTheCareTeamSendNothing() {
        settings();
        Asset pm1 = device('PM-1');

        Test.startTest();
        insert new List<Case>{
            new Case(Subject = 'Another queue', AssetId = pm1.Id, OwnerId = queueId(OTHER_QUEUE)),
            new Case(Subject = 'A person', AssetId = pm1.Id, OwnerId = UserInfo.getUserId()),
            new Case(Subject = 'Closed', AssetId = pm1.Id, OwnerId = queueId(QUEUE), Status = 'Closed'),
            new Case(Subject = 'No device', OwnerId = queueId(QUEUE))
        };
        Test.stopTest();

        Assert.areEqual(0, alerts().size(), 'No CASE_ALERT');
        Assert.isFalse(alertShown(pm1.Id), 'Shown off');
    }

    @IsTest
    static void anEditThatCannotChangeTheStateIsNotCounted() {
        settings();
        Asset pm1 = device('PM-1');
        Case theCase = waiting(pm1);
        insert theCase;
        // Shown off by hand, so a recount would turn it on again.
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = pm1.Id, Case_Alert_Active__c = false);
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        update new Case(Id = theCase.Id, Subject = 'Only the subject changed', Priority = 'High');
        Test.stopTest();

        Assert.areEqual(1, alerts().size(), 'Nothing sent');
        Assert.isFalse(alertShown(pm1.Id), 'Not counted again');
    }

    @IsTest
    static void aDeviceNotProvisionedYetIsShownOnButNoCommandIsSent() {
        settings();
        Account patient = new Account(Name = 'Case Alert Patient');
        insert patient;
        Asset unprovisioned = new Asset(Name = 'New device', SerialNumber = 'PM-NEW', AccountId = patient.Id,
                                        Status = 'Installed');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert unprovisioned;
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        insert waiting(unprovisioned);
        Test.stopTest();

        Assert.areEqual(0, alerts().size(), 'No board in AWS to send to');
        Assert.isTrue(alertShown(unprovisioned.Id), 'Shown on, so its board is told once it is online');
    }

    @IsTest
    static void aFailureNeverStopsTheCaseFromSaving() {
        settings();
        DevicePlatformSettings.get().Room_Temp_Case_Queue__c = '';
        Asset pm1 = device('PM-1');

        Test.startTest();
        Database.SaveResult result = Database.insert(waiting(pm1), false);
        Test.stopTest();

        Assert.isTrue(result.isSuccess(), 'The Case saved');
        Assert.areEqual(0, alerts().size(), 'Nothing sent');
        Assert.isFalse(alertShown(pm1.Id), 'Nothing changed');
    }

    @IsTest
    static void aMissingQueueCountsNoCase() {
        settings();
        DevicePlatformSettings.get().Room_Temp_Case_Queue__c = 'NoSuchQueue';
        DevicePlatformSettings.get().Escalation_Case_Queue__c = 'NoSuchQueue';
        Asset pm1 = device('PM-1');

        Test.startTest();
        insert waiting(pm1);
        Test.stopTest();

        Assert.areEqual(0, alerts().size(), 'The Case is in no care team queue, so nothing is sent');
        Assert.areEqual(1, [SELECT COUNT() FROM Case], 'The Case saved');
    }

    @IsTest
    static void bulk200DevicesUseConstantQueriesAndDml() {
        settings();
        List<String> names = new List<String>();
        for (Integer i = 0; i < 201; i++) {
            names.add('PM-' + i);
        }
        List<Asset> boards = devices(names);
        Id careTeamQueueId = queueId(QUEUE);
        List<Case> two00 = new List<Case>();
        for (Integer i = 1; i < 201; i++) {
            two00.add(new Case(Subject = 'Bulk ' + i, AssetId = boards[i].Id, OwnerId = careTeamQueueId));
        }
        // Measures only this service and the queue indicator; the send path
        // has its own bulk test.
        TriggerHandler.bypass('DeviceCommandTriggerHandler');

        Test.startTest();
        Integer queries = Limits.getQueries();
        Integer dml = Limits.getDmlStatements();
        insert new Case(Subject = 'One', AssetId = boards[0].Id, OwnerId = careTeamQueueId);
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
        Assert.areEqual(201, alerts().size(), 'A CASE_ALERT for every device');
        Assert.areEqual(201, [SELECT COUNT() FROM Asset WHERE Case_Alert_Active__c = true], 'Every device shown on');
    }
}
