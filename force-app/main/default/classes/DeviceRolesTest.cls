/*
 * DeviceRolesTest.cls
 *
 * The two device roles, Patient_Device and Internal_Device (Asset record
 * types), end to end: an Internal Device board follows the whole queue
 * (QUEUE_DEPTH, any Case on any device), gets no Case alert, no room-rule
 * Case, is sent the depth again when it comes online, and is
 * provisioned into internal-devices; a change of record type tells the board
 * its new role at once.
 *
 * The queue is one made here, never the org's Care_Team_Queue. The queue
 * relay's event trigger is switched off (Integration_Control__c) so each test
 * hands the published events to the relay itself and sees what it sends.
 */
@IsTest
private class DeviceRolesTest {

    private static final String ARN_PREFIX = 'arn:aws:iot:us-east-2:111122223333:thing/';
    private static final String QUEUE = 'DeviceRolesTestQueue';

    @TestSetup
    static void setup() {
        // Group and QueueSobject are setup objects: mixed DML forces runAs.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Group queue = new Group(Name = 'Device Roles Test Queue', DeveloperName = QUEUE, Type = 'Queue');
            insert queue;
            insert new QueueSobject(QueueId = queue.Id, SobjectType = 'Case');
        }
        insert new Integration_Control__c(
            SetupOwnerId = UserInfo.getOrganizationId(),
            Bypass_Handlers__c = 'QueueDepthChangeTriggerHandler'
        );
    }

    /** Every test starts here: the static overrides do not survive @TestSetup. */
    private static DeviceApiMock settings() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Room_Temp_Case_Queue__c = QUEUE;
        settings.Escalation_Case_Queue__c = QUEUE;
        settings.Internal_Device_Queue__c = QUEUE;
        CaseQueueMonitorService.testBindingOverride = new List<Device_Queue_Binding__mdt>();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        return aws;
    }

    private static Id queueId() {
        return [SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = :QUEUE].Id;
    }

    /** A provisioned board, saved without the Asset trigger. */
    private static Asset board(String thingName, Boolean internal, String connection) {
        Account owner = internal ? new Account(Name = 'Ward 3') : TestAccounts.patient('Patient ' + thingName);
        insert owner;
        Asset device = new Asset(
            Name = 'Device ' + thingName, SerialNumber = thingName, AccountId = owner.Id, Status = 'Installed',
            Thing_ARN__c = ARN_PREFIX + thingName, Provisioning_Status__c = 'Provisioned',
            Connection_Status__c = connection, Connection_Since__c = System.now().addHours(-1)
        );
        if (internal) {
            device.RecordTypeId = DeviceRoles.internalRecordTypeId();
        }
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    private static Case waiting(Id assetId) {
        return new Case(Subject = 'Waiting', AssetId = assetId, OwnerId = queueId());
    }

    /** Every QUEUE_DEPTH the device API was asked to publish. */
    private static List<Map<String, Object>> queueDepthSent(DeviceApiMock aws) {
        List<Map<String, Object>> sent = new List<Map<String, Object>>();
        for (Integer i = 0; i < aws.paths.size(); i++) {
            if (aws.paths[i] == 'queue-depth') {
                for (Object command : (List<Object>) aws.bodies[i].get('commands')) {
                    sent.add((Map<String, Object>) command);
                }
            }
        }
        return sent;
    }

    /** No board is sent a case alert: a patient board follows its own sensor. */
    private static Integer alerts() {
        return [SELECT COUNT() FROM Device_Command__c WHERE Command__c = 'CASE_ALERT'];
    }

    @IsTest
    static void bothRecordTypesShipAndNoRecordTypeIsAPatientDevice() {
        Id internal = DeviceRoles.internalRecordTypeId();
        Id patient = DeviceRoles.patientRecordTypeId();
        Assert.isNotNull(internal, 'Asset.Internal_Device ships');
        Assert.isNotNull(patient, 'Asset.Patient_Device ships');
        Assert.isNull(DeviceRoles.recordTypeId('No_Such_Type'), 'An unknown name has no Id');

        Assert.isTrue(DeviceRoles.isInternal(new Asset(RecordTypeId = internal)), 'Internal');
        Assert.isFalse(DeviceRoles.isInternal(new Asset(RecordTypeId = patient)), 'Patient');
        Assert.isFalse(DeviceRoles.isInternal(new Asset()), 'An Asset from before the record types');
        Assert.isFalse(DeviceRoles.isInternal(null), 'No Asset');
    }

    @IsTest
    static void theInternalBoardsThatFollowAreProvisionedAndNotKnownOffline() {
        settings();
        board('IN-B', true, 'Online');
        board('IN-A', true, null);
        board('IN-OFF', true, 'Offline');
        board('PM-1', false, 'Online');
        Asset unprovisioned = board('IN-NEW', true, 'Online');
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = unprovisioned.Id, Thing_ARN__c = null, Provisioning_Status__c = 'Not Provisioned');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Assert.areEqual(new List<String>{ 'IN-A', 'IN-B' }, DeviceRoles.followingThingNames(),
            'Internal, provisioned, online or never recorded; sorted');
    }

    @IsTest
    static void aCaseOnAnyDeviceTurnsEveryInternalBoard() {
        DeviceApiMock aws = settings();
        board('IN-1', true, 'Online');
        Asset pm1 = board('PM-1', false, 'Online');

        Test.startTest();
        insert waiting(pm1.Id);
        List<Queue_Depth_Change__e> events = CaseQueueMonitorService.lastPublished;
        QueueDepthRelayQueueable.relayToDevices(events);
        Test.stopTest();

        Assert.areEqual(1, events.size(), 'One event for the queue');
        Assert.areEqual(QUEUE, events[0].Queue_Developer_Name__c, 'The Internal Device Queue');
        Assert.isNull(events[0].Device_Id__c, 'No binding names a board');
        Assert.areEqual(1, events[0].Open_Case_Count__c.intValue(), 'One open Case');
        Assert.areEqual(20, events[0].Intensity__c.intValue(), '1 of the default full-speed depth of 5');

        List<Map<String, Object>> sent = queueDepthSent(aws);
        Assert.areEqual(1, sent.size(), 'One QUEUE_DEPTH: the internal board only, ' + sent);
        Assert.areEqual('IN-1', sent[0].get('deviceId'), 'To the internal board');
        Assert.areEqual(20, sent[0].get('intensity'), 'Its intensity');
        Assert.areEqual(1, sent[0].get('openCaseCount'), 'Its count');
        Assert.areEqual('ACTIVE', sent[0].get('motorState'), 'Running');

        Assert.areEqual(0, alerts(), 'The monitoring device is sent nothing: its motor follows its own sensor');
    }

    @IsTest
    static void closingTheLastCaseStopsTheInternalBoards() {
        DeviceApiMock aws = settings();
        board('IN-1', true, 'Online');
        Case waitingCase = new Case(Subject = 'On no device', OwnerId = queueId());
        insert waitingCase;

        Test.startTest();
        update new Case(Id = waitingCase.Id, Status = 'Closed');
        QueueDepthRelayQueueable.relayToDevices(CaseQueueMonitorService.lastPublished);
        Test.stopTest();

        List<Map<String, Object>> sent = queueDepthSent(aws);
        Assert.areEqual(1, sent.size(), 'One QUEUE_DEPTH');
        Assert.areEqual('IN-1', sent[0].get('deviceId'), 'To the internal board');
        Assert.areEqual(0, sent[0].get('intensity'), 'Stopped');
        Assert.areEqual('IDLE', sent[0].get('motorState'), 'Idle');
    }

    @IsTest
    static void aBindingSetsTheDepthAndMayAddOneBoard() {
        DeviceApiMock aws = settings();
        CaseQueueMonitorService.testBindingOverride = new List<Device_Queue_Binding__mdt>{
            new Device_Queue_Binding__mdt(Queue_Developer_Name__c = QUEUE.toLowerCase(), Device_Id__c = 'EXTRA-1',
                                          Full_Speed_Depth__c = 10, Active__c = true)
        };
        board('IN-1', true, 'Online');

        Test.startTest();
        insert new Case(Subject = 'Waiting', OwnerId = queueId());
        List<Queue_Depth_Change__e> events = CaseQueueMonitorService.lastPublished;
        // Two older events of the same queue in one batch: only the newest counts.
        List<Queue_Depth_Change__e> batch = new List<Queue_Depth_Change__e>{
            new Queue_Depth_Change__e(Queue_Developer_Name__c = QUEUE, Device_Id__c = 'EXTRA-1',
                                      Open_Case_Count__c = 4, Intensity__c = 40, Motor_State__c = 'ACTIVE'),
            new Queue_Depth_Change__e(Queue_Developer_Name__c = 'Other_Queue', Device_Id__c = 'OTHER-1',
                                      Open_Case_Count__c = 2, Intensity__c = 50, Motor_State__c = 'ACTIVE')
        };
        batch.addAll(events);
        QueueDepthRelayQueueable.relayToDevices(batch);
        Test.stopTest();

        Assert.areEqual('EXTRA-1', events[0].Device_Id__c, 'The bound board');
        Assert.areEqual(10, events[0].Intensity__c.intValue(), '1 of 10');

        Map<String, Map<String, Object>> byDevice = new Map<String, Map<String, Object>>();
        for (Map<String, Object> command : queueDepthSent(aws)) {
            byDevice.put((String) command.get('deviceId'), command);
        }
        Assert.areEqual(new Set<String>{ 'EXTRA-1', 'IN-1', 'OTHER-1' }, byDevice.keySet(), 'Each board once');
        Assert.areEqual(10, byDevice.get('IN-1').get('intensity'), 'The newest depth of the queue');
        Assert.areEqual(10, byDevice.get('EXTRA-1').get('intensity'), 'The newest depth of the queue');
        Assert.areEqual(50, byDevice.get('OTHER-1').get('intensity'), 'Another queue\'s board, as before');
    }

    @IsTest
    static void noBoardGetsACaseAlertForItsOwnCases() {
        settings();
        Asset in1 = board('IN-1', true, 'Online');
        Asset pm1 = board('PM-1', false, 'Online');

        Test.startTest();
        insert new List<Case>{ waiting(in1.Id), waiting(pm1.Id) };
        Test.stopTest();

        Assert.areEqual(0, alerts(), 'No CASE_ALERT: a patient board follows its own room');
    }

    @IsTest
    static void becomingInternalFollowsTheQueue() {
        DeviceApiMock aws = settings();
        Asset pm1 = board('PM-1', false, 'Online');
        insert waiting(pm1.Id);

        Test.startTest();
        update new Asset(Id = pm1.Id, RecordTypeId = DeviceRoles.internalRecordTypeId());
        Test.stopTest();

        Assert.areEqual(0, alerts(), 'No CASE_ALERT either way');

        List<Map<String, Object>> sent = queueDepthSent(aws);
        Assert.areEqual(1, sent.size(), 'Sent the queue at once');
        Assert.areEqual('PM-1', sent[0].get('deviceId'), 'To the board');
        Assert.areEqual(1, sent[0].get('openCaseCount'), 'The queue\'s open Cases');
        Assert.areEqual(20, sent[0].get('intensity'), 'Its intensity');
    }

    @IsTest
    static void becomingAPatientDeviceStopsTheQueueMotor() {
        DeviceApiMock aws = settings();
        Asset in1 = board('IN-1', true, 'Online');
        insert waiting(in1.Id);
        // A Patient Device belongs to a patient, so it moves to one as it changes role.
        Account patient = TestAccounts.patient('Patient IN-1');
        insert patient;

        Test.startTest();
        update new Asset(Id = in1.Id, RecordTypeId = DeviceRoles.patientRecordTypeId(), AccountId = patient.Id);
        Test.stopTest();

        List<Map<String, Object>> sent = queueDepthSent(aws);
        Assert.areEqual(1, sent.size(), 'One QUEUE_DEPTH');
        Assert.areEqual(0, sent[0].get('intensity'), 'Its queue motor stops');
        Assert.areEqual(0, alerts(), 'And no case alert: its motor follows its room');
    }

    @IsTest
    static void anotherEditSendsNothing() {
        DeviceApiMock aws = settings();
        Asset in1 = board('IN-1', true, 'Online');

        Test.startTest();
        update new Asset(Id = in1.Id, Name = 'Nurse station 3');
        Test.stopTest();

        Assert.areEqual(0, queueDepthSent(aws).size(), 'The role did not change');
    }

    @IsTest
    static void anInternalBoardThatComesOnlineIsSentTheDepth() {
        DeviceApiMock aws = settings();
        board('IN-1', true, 'Offline');
        board('PM-1', false, 'Offline');
        insert new List<Case>{
            new Case(Subject = 'One', OwnerId = queueId()),
            new Case(Subject = 'Two', OwnerId = queueId())
        };

        List<DeviceConnectionService.Change> changes = new List<DeviceConnectionService.Change>();
        for (String thingName : new List<String>{ 'IN-1', 'PM-1' }) {
            DeviceConnectionService.Change change = new DeviceConnectionService.Change();
            change.thingArn = ARN_PREFIX + thingName;
            change.status = 'Online';
            change.changedAtMillis = System.now().getTime();
            changes.add(change);
        }

        Test.startTest();
        DeviceConnectionService.record(changes);
        Test.stopTest();

        List<Map<String, Object>> sent = queueDepthSent(aws);
        Assert.areEqual(1, sent.size(), 'The internal board only: ' + sent);
        Assert.areEqual('IN-1', sent[0].get('deviceId'), 'To the board that came back');
        Assert.areEqual(2, sent[0].get('openCaseCount'), 'The queue now');
        Assert.areEqual(40, sent[0].get('intensity'), '2 of 5');
    }

    @IsTest
    static void aQueueThatDoesNotExistShowsNoCases() {
        DeviceApiMock aws = settings();
        DevicePlatformSettings.testOverride.Internal_Device_Queue__c = 'No_Such_Queue';
        Asset in1 = board('IN-1', true, 'Online');

        Test.startTest();
        CaseQueueMonitorService.resyncAfterReconnect(new List<Asset>{
            [SELECT Id, RecordTypeId, Thing_ARN__c FROM Asset WHERE Id = :in1.Id]
        });
        Test.stopTest();

        List<Map<String, Object>> sent = queueDepthSent(aws);
        Assert.areEqual(1, sent.size(), 'Still told');
        Assert.areEqual(0, sent[0].get('intensity'), 'Nothing waits in a queue that does not exist');
    }

    @IsTest
    static void unreadableSettingsMonitorNothingAndSaveTheCase() {
        settings();
        DevicePlatformSettings.testOverride.Internal_Device_Queue__c = null;
        DevicePlatformSettings.testOverride.Escalation_Case_Queue__c = null;
        board('IN-1', true, 'Online');

        Test.startTest();
        insert new Case(Subject = 'Waiting', OwnerId = queueId());
        Test.stopTest();

        Assert.isNull(CaseQueueMonitorService.internalDeviceQueue(), 'No queue to follow');
        Assert.isNull(CaseQueueMonitorService.lastPublished, 'No queue is monitored, so nothing is published');
        Assert.areEqual(1, [SELECT COUNT() FROM Case], 'The Case saved');
    }

    @IsTest
    static void anInternalBoardOpensNoRoomTemperatureCase() {
        settings();
        board('IN-1', true, 'Online');

        Test.startTest();
        insert new Patient_Vitals__c(
            Device__c = 'IN-1', Device_Reading_Id__c = 'IN-1-1', Temperature__c = 31.0, Humidity__c = 41,
            Timestamp__c = System.now(), Patient_State__c = 'STABLE', Source_System__c = 'AWS_IoT',
            Room_Temperature_Alert__c = true
        );
        Test.stopTest();

        Assert.areEqual(0, [SELECT COUNT() FROM Case], 'No room-rule Case for a ward board');
    }

    @IsTest
    static void provisioningPicksTheGroupByRole() {
        DeviceApiMock aws = settings();
        Wi_Fi_Network__c net = new Wi_Fi_Network__c(Name = 'Ward', SSID__c = 'ward-wifi');
        insert net;
        Account ward = new Account(Name = 'Ward 3');
        insert ward;
        List<Asset> devices = new List<Asset>{
            new Asset(Name = 'IN-P', SerialNumber = 'IN-P', AccountId = ward.Id, Wi_Fi_Network__c = net.Id,
                      RecordTypeId = DeviceRoles.internalRecordTypeId()),
            new Asset(Name = 'PM-P', SerialNumber = 'PM-P', AccountId = ward.Id, Wi_Fi_Network__c = net.Id),
            new Asset(Name = 'IN-C', SerialNumber = 'IN-C', AccountId = ward.Id, Wi_Fi_Network__c = net.Id,
                      RecordTypeId = DeviceRoles.internalRecordTypeId(), Thing_Group__c = 'canary-patient-monitor')
        };

        Test.startTest();
        insert devices;
        Test.stopTest();

        Map<String, String> groupByThing = new Map<String, String>();
        for (Map<String, Object> body : aws.bodies) {
            for (Map<String, Object> device : DeviceApiMock.devicesIn(body)) {
                groupByThing.put((String) device.get('thingName'), (String) device.get('thingGroup'));
            }
        }
        Assert.areEqual('internal-devices', groupByThing.get('IN-P'), 'An internal board, inside the fleet');
        Assert.areEqual('fleet-patient-monitor', groupByThing.get('PM-P'), 'A patient device');
        Assert.areEqual('canary-patient-monitor', groupByThing.get('IN-C'), 'A group the Asset names wins');
        Assert.areEqual('internal-devices',
            [SELECT Thing_Group__c FROM Asset WHERE Id = :devices[0].Id].Thing_Group__c, 'Shown on the Asset');
    }
}
