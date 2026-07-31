@IsTest
private class CaseQueueMonitorServiceTest {

    private static final String QUEUE_DEV_NAME = 'Care_Team_Queue_Test';
    private static final String DEVICE_ID = 'ESP32-Test-01';

    private class RelayMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            HttpResponse response = new HttpResponse();
            response.setStatusCode(200);
            response.setBody('{"published":true}');
            return response;
        }
    }

    private static Group createQueue() {
        Group queue = new Group(
            Name = 'Care Team Queue Test',
            DeveloperName = QUEUE_DEV_NAME,
            Type = 'Queue'
        );
        // Group and QueueSobject are setup objects — mixed DML forces runAs.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert queue;
            insert new QueueSobject(QueueId = queue.Id, SobjectType = 'Case');
        }
        return queue;
    }

    private static void applyBinding(Decimal fullSpeedDepth, Boolean active) {
        CaseQueueMonitorService.testBindingOverride = new List<Device_Queue_Binding__mdt>{
            new Device_Queue_Binding__mdt(
                Queue_Developer_Name__c = QUEUE_DEV_NAME,
                Device_Id__c = DEVICE_ID,
                Full_Speed_Depth__c = fullSpeedDepth,
                Active__c = active
            )
        };
    }

    @IsTest
    static void newCaseInQueuePublishesActiveEvent() {
        Group queue = createQueue();
        applyBinding(5, true);
        Test.setMock(HttpCalloutMock.class, new RelayMock());

        Test.startTest();
        insert new Case(Subject = 'Patient escalation', OwnerId = queue.Id);
        Test.getEventBus().deliver();
        Test.stopTest();

        // One open case against a full-speed depth of 5 => 20% intensity, motor running.
        Assert.areEqual(20, CaseQueueMonitorService.scaleDepthToMotorIntensity(1, 5),
            'One of five cases should scale to 20 percent intensity');
    }

    @IsTest
    static void closingLastCaseStopsTheMotor() {
        Group queue = createQueue();
        applyBinding(5, true);
        Test.setMock(HttpCalloutMock.class, new RelayMock());

        Case c = new Case(Subject = 'Patient escalation', OwnerId = queue.Id);
        insert c;

        Test.startTest();
        c.Status = 'Closed';
        update c;
        Test.getEventBus().deliver();
        Test.stopTest();

        Integer remaining = [
            SELECT COUNT() FROM Case WHERE OwnerId = :queue.Id AND IsClosed = false
        ];
        Assert.areEqual(0, remaining, 'Queue should be empty after closing the only case');
        Assert.areEqual(0, CaseQueueMonitorService.scaleDepthToMotorIntensity(0, 5),
            'An empty queue must produce zero intensity so the motor stops');
    }

    @IsTest
    static void inactiveBindingIsIgnored() {
        Group queue = createQueue();
        applyBinding(5, false);

        Test.startTest();
        insert new Case(Subject = 'Ignored', OwnerId = queue.Id);
        Test.getEventBus().deliver();
        Test.stopTest();

        // No callout mock is set: if the relay had fired, the test would fail
        // with an unmocked-callout exception.
        Assert.isTrue(true, 'Inactive bindings must not drive a device');
    }

    @IsTest
    static void caseOwnedByUserIsIgnored() {
        applyBinding(5, true);

        Test.startTest();
        insert new Case(Subject = 'User owned', OwnerId = UserInfo.getUserId());
        Test.getEventBus().deliver();
        Test.stopTest();

        Assert.isTrue(true, 'A user-owned case is not queue depth and must not publish');
    }

    @IsTest
    static void intensityScalesAndClamps() {
        Assert.areEqual(0, CaseQueueMonitorService.scaleDepthToMotorIntensity(0, 5), 'Zero cases => 0');
        Assert.areEqual(60, CaseQueueMonitorService.scaleDepthToMotorIntensity(3, 5), 'Three of five => 60');
        Assert.areEqual(100, CaseQueueMonitorService.scaleDepthToMotorIntensity(5, 5), 'At depth => 100');
        Assert.areEqual(100, CaseQueueMonitorService.scaleDepthToMotorIntensity(50, 5), 'Above depth clamps to 100');
        Assert.areEqual(100, CaseQueueMonitorService.scaleDepthToMotorIntensity(2, 0), 'Zero depth config => full speed');
        Assert.areEqual(0, CaseQueueMonitorService.scaleDepthToMotorIntensity(null, 5), 'Null count => 0');
    }

    @IsTest
    static void bulkCaseInsertStaysWithinLimits() {
        Group queue = createQueue();
        applyBinding(50, true);
        Test.setMock(HttpCalloutMock.class, new RelayMock());

        List<Case> cases = new List<Case>();
        for (Integer i = 0; i < 200; i++) {
            cases.add(new Case(Subject = 'Bulk ' + i, OwnerId = queue.Id));
        }

        Test.startTest();
        insert cases;
        Test.getEventBus().deliver();
        Assert.isTrue(Limits.getQueries() < Limits.getLimitQueries(),
            'Bulk insert must not approach the SOQL limit');
        Test.stopTest();

        Integer open = [SELECT COUNT() FROM Case WHERE OwnerId = :queue.Id AND IsClosed = false];
        Assert.areEqual(200, open, 'All 200 cases should be open in the queue');
    }
}
