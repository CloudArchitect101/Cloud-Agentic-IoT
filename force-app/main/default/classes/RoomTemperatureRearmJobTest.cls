/*
 * RoomTemperatureRearmJobTest.cls
 *
 * Covers RoomTemperatureRearmJob: closing a temperature alert Case re-arms its
 * device in AWS with one device-live callout (mode rearm); other Cases, and
 * Cases that were already closed, do not; a failed callout never fails the
 * save; and devices beyond the job's callouts go to the next job.
 */
@IsTest
private class RoomTemperatureRearmJobTest {

    private static final String ORIGIN = 'Room Temperature Rule';

    private static Asset device(String thingName) {
        Account patient = TestAccounts.patient('Rearm Patient ' + thingName);
        insert patient;
        Asset device = new Asset(
            Name = 'Device ' + thingName, SerialNumber = thingName, AccountId = patient.Id, Status = 'Installed',
            Thing_ARN__c = 'arn:aws:iot:us-east-2:111122223333:thing/' + thingName, Provisioning_Status__c = 'Provisioned'
        );
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    private static Case openCase(Asset device, String origin) {
        Case alertCase = new Case(Subject = 'High temperature', Origin = origin, AssetId = device.Id, Status = 'New');
        insert alertCase;
        return alertCase;
    }

    private static List<Map<String, Object>> rearms(DeviceApiMock aws) {
        List<Map<String, Object>> found = new List<Map<String, Object>>();
        for (Integer i = 0; i < aws.paths.size(); i++) {
            if (aws.paths[i] == 'device-live' && aws.bodies[i].get('mode') == 'rearm') {
                found.add(aws.bodies[i]);
            }
        }
        return found;
    }

    @IsTest
    static void closingATemperatureAlertCaseRearmsItsDevice() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Case alertCase = openCase(device('Test8'), ORIGIN);

        Test.startTest();
        update new Case(Id = alertCase.Id, Status = 'Closed');
        Test.stopTest();

        List<Map<String, Object>> sent = rearms(aws);
        Assert.areEqual(1, sent.size(), 'one re-arm for the closed Case');
        Assert.areEqual('Test8', sent[0].get('thingName'));
    }

    @IsTest
    static void otherCasesAndAnAlreadyClosedCaseRearmNothing() {
        DeviceTestSettings.use();
        Asset test8 = device('Test8');
        Case other = openCase(test8, 'Phone');
        Case alertCase = openCase(test8, ORIGIN);
        update new Case(Id = alertCase.Id, Status = 'Closed');

        List<Case> after = [SELECT Id, IsClosed, AssetId, Origin FROM Case WHERE Id IN :new List<Id>{ other.Id, alertCase.Id }];
        Map<Id, Case> before = new Map<Id, Case>{
            other.Id => new Case(Id = other.Id, Status = 'New'),
            alertCase.Id => [SELECT Id, IsClosed FROM Case WHERE Id = :alertCase.Id]
        };
        // The other Case is still open; the alert Case was already closed before this save.
        Assert.areEqual(0, RoomTemperatureRearmJob.thingNamesToRearm(after, before).size());
    }

    @IsTest
    static void aRefusedRearmIsLoggedAndTheCaseStillCloses() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 500;
        Test.setMock(HttpCalloutMock.class, aws);
        Case alertCase = openCase(device('Test8'), ORIGIN);

        Test.startTest();
        update new Case(Id = alertCase.Id, Status = 'Closed');
        Test.stopTest();

        Assert.isTrue([SELECT IsClosed FROM Case WHERE Id = :alertCase.Id].IsClosed);
    }

    @IsTest
    static void devicesBeyondTheJobsCalloutsGoToTheNextJob() {
        DeviceTestSettings.use();   // Callouts_Per_Job__c 50
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<String> many = new List<String>();
        for (Integer i = 0; i < 120; i++) {
            many.add('Board' + i);
        }

        Test.startTest();
        new RoomTemperatureRearmJob(many).execute(null);
        Test.stopTest();

        Integer sent = rearms(aws).size();
        Assert.areEqual(50, sent, 'one job makes at most Callouts_Per_Job__c callouts');
        Assert.isNotNull(RoomTemperatureRearmJob.lastChainedJob, 'the rest go to the next job');
        Assert.areEqual(120 - sent, RoomTemperatureRearmJob.lastChainedJob.thingNames.size());
    }
}
