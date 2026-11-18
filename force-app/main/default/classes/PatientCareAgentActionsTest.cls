@IsTest
private class PatientCareAgentActionsTest {

    // Test-only queues, so no test depends on the org's Care_Team_Queue or
    // moves the real indicator: no Device_Queue_Binding names them.
    private static final String QUEUE = 'AgentEscalationTestQueue';
    private static final String NO_CASE_QUEUE = 'AgentEscalationNoCaseQueue';

    @TestSetup
    static void queues() {
        // Group and QueueSobject are setup objects: mixed DML forces runAs.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Group caseQueue = new Group(Name = 'Agent Escalation Test Queue', DeveloperName = QUEUE, Type = 'Queue');
            Group noCases = new Group(Name = 'Agent Escalation No Case Queue', DeveloperName = NO_CASE_QUEUE, Type = 'Queue');
            insert new List<Group>{ caseQueue, noCases };
            insert new QueueSobject(QueueId = caseQueue.Id, SobjectType = 'Case');
        }
    }

    /** Every test starts here: the static override does not survive @TestSetup. */
    private static Device_Platform_Setting__mdt settings() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Escalation_Case_Queue__c = QUEUE;
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        return settings;
    }

    private static Id queueId(String developerName) {
        return [SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = :developerName].Id;
    }

    private static PatientCareAgentActions.EscalationRequest req(String device, String reason, String sev) {
        PatientCareAgentActions.EscalationRequest r = new PatientCareAgentActions.EscalationRequest();
        r.deviceId = device; r.reason = reason; r.severity = sev;
        return r;
    }

    @IsTest
    static void createsCaseAndReturnsCaseNumber() {
        settings();
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('ESP32-01', 'Temperature above threshold for 15 minutes', 'HIGH')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success, 'Escalation should succeed');
        Assert.isNotNull(results[0].caseNumber, 'CaseNumber must be read back after insert');

        Case c = [SELECT Priority, Origin, Description FROM Case LIMIT 1];
        Assert.areEqual('High', c.Priority, 'HIGH severity maps to High priority');
        Assert.areEqual('Agentforce', c.Origin, 'Origin identifies agent-created cases for audit');
    }

    @IsTest
    static void rejectsIncompleteRequestWithoutFailingTheBatch() {
        settings();
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req(null, 'missing device', 'HIGH'),
                req('ESP32-02', 'valid request', 'LOW')
            });
        Test.stopTest();

        Assert.isFalse(results[0].success, 'Invalid row is rejected');
        Assert.isTrue(results[1].success, 'A bad row must not fail its neighbours');
        Assert.areEqual(1, [SELECT COUNT() FROM Case], 'Only the valid row creates a Case');
    }

    @IsTest
    static void severityDefaultsToMediumWhenAbsentOrUnknown() {
        settings();
        Test.startTest();
        PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
            req('ESP32-03', 'no severity given', null),
            req('ESP32-04', 'nonsense severity', 'BANANA')
        });
        Test.stopTest();

        for (Case c : [SELECT Priority FROM Case]) {
            Assert.areEqual('Medium', c.Priority, 'Unrecognised severity falls back to Medium');
        }
    }

    @IsTest
    static void bulkInvocationStaysWithinLimits() {
        settings();
        List<PatientCareAgentActions.EscalationRequest> many =
            new List<PatientCareAgentActions.EscalationRequest>();
        for (Integer i = 0; i < 200; i++) {
            many.add(req('ESP32-' + i, 'Bulk escalation ' + i, 'MEDIUM'));
        }

        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results = PatientCareAgentActions.escalate(many);
        Assert.isTrue(Limits.getDmlStatements() < Limits.getLimitDmlStatements(),
            'Bulk invocation must not approach the DML limit');
        Test.stopTest();

        Assert.areEqual(200, results.size(), 'Every request gets a result');
        Assert.areEqual(200, [SELECT COUNT() FROM Case], 'All 200 cases created');
    }

    @IsTest
    static void theCaseGoesToTheConfiguredQueue() {
        settings();
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('ESP32-05', 'SpO2 below threshold', 'HIGH')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success, 'Escalation should succeed');
        Case c = [SELECT OwnerId, CaseNumber FROM Case LIMIT 1];
        Assert.areEqual(queueId(QUEUE), c.OwnerId, 'The care team queue owns the Case, so the indicator counts it');
        Assert.areEqual(c.CaseNumber, results[0].caseNumber, 'The agent reports the Case number');
        Assert.isTrue(results[0].message.contains('queue'), results[0].message);
    }

    @IsTest
    static void bulkEscalationsAllGoToTheQueueWithOneLookup() {
        settings();
        List<PatientCareAgentActions.EscalationRequest> many =
            new List<PatientCareAgentActions.EscalationRequest>();
        for (Integer i = 0; i < 50; i++) {
            many.add(req('ESP32-Q' + i, 'Bulk escalation ' + i, 'LOW'));
        }

        Test.startTest();
        PatientCareAgentActions.escalate(many);
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Assert.areEqual(50, [SELECT COUNT() FROM Case WHERE OwnerId = :queueId(QUEUE)], 'Every Case is owned by the queue');
        Assert.isTrue(queries <= 5, 'The queue is looked up once, not per Case: ' + queries + ' queries');
    }

    @IsTest
    static void aMissingQueueLeavesTheCaseWithTheRunningUser() {
        settings().Escalation_Case_Queue__c = 'No_Such_Queue';
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('ESP32-06', 'Heart rate above threshold', 'MEDIUM')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success, 'A setup mistake must not lose the escalation');
        Assert.isNotNull(results[0].caseNumber, 'Still reports the Case number');
        Assert.areEqual(UserInfo.getUserId(), [SELECT OwnerId FROM Case LIMIT 1].OwnerId, 'Default owner');
    }

    @IsTest
    static void aQueueThatDoesNotAcceptCasesIsNotUsed() {
        settings().Escalation_Case_Queue__c = NO_CASE_QUEUE;
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('ESP32-07', 'Temperature above threshold', 'HIGH')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success, 'The Case is still created');
        Assert.areEqual(UserInfo.getUserId(), [SELECT OwnerId FROM Case LIMIT 1].OwnerId,
            'A queue without Case support cannot own one');
    }

    private static Asset device(String serial) {
        Account owner = new Account(Name = 'Escalation Patient ' + serial);
        insert owner;
        Asset a = new Asset(Name = 'Monitor ' + serial, SerialNumber = serial, AccountId = owner.Id, Status = 'Installed');
        // The Asset trigger would provision the device in AWS.
        TriggerHandler.bypass('AssetTriggerHandler');
        insert a;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return a;
    }

    @IsTest
    static void theCaseIsLinkedToTheDevicesAsset() {
        settings();
        Asset test8 = device('Test8');
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('Test8', 'Room at 30 C', 'MEDIUM')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success, results[0].message);
        Assert.areEqual(test8.Id, [SELECT AssetId FROM Case LIMIT 1].AssetId,
            'An agent escalation is the device\'s own Case');
    }

    @IsTest
    static void anUnknownOrDuplicatedSerialLeavesTheCaseUnlinked() {
        settings();
        device('Twin');
        device('Twin');
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('Twin', 'Room at 30 C', 'MEDIUM'), req('Nobody', 'Room at 30 C', 'MEDIUM')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success && results[1].success, 'Both Cases are still created');
        for (Case c : [SELECT AssetId FROM Case]) {
            Assert.isNull(c.AssetId, 'Never tied to the wrong device');
        }
    }
}
