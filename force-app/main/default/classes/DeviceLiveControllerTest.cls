@IsTest
private class DeviceLiveControllerTest {

    private static final String THING_ARN = 'arn:aws:iot:us-east-2:111122223333:thing/PM-LIVE';

    // Whole seconds: a Datetime field keeps no milliseconds.
    private static final Datetime SINCE = Datetime.newInstanceGmt(2026, 11, 6, 5, 0, 0);

    // Usernames are unique across every org, so this one carries the org's Id.
    private static String viewerUsername() {
        return 'live-card-viewer@' + UserInfo.getOrganizationId() + '.example.com';
    }

    /**
     * Someone the card is for, and a device they own. The controller reads the
     * Asset in user mode, and fields deployed through the Metadata API give no
     * profile any field access, the deploying admin's included, so the viewer
     * gets it the way a real one does: from Device_Platform_Admin.
     */
    @TestSetup
    static void setup() {
        User viewer = new User(
            Username          = viewerUsername(),
            Email             = 'live-card-viewer@example.com',
            LastName          = 'Viewer',
            Alias             = 'lcviewer',
            ProfileId         = UserInfo.getProfileId(),
            TimeZoneSidKey    = UserInfo.getTimeZone().getID(),
            LocaleSidKey      = UserInfo.getLocale(),
            LanguageLocaleKey = UserInfo.getLanguage(),
            EmailEncodingKey  = 'UTF-8'
        );
        insert viewer;
        insert new PermissionSetAssignment(
            AssigneeId      = viewer.Id,
            PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Device_Platform_Admin'].Id
        );

        System.runAs(viewer) {
            Account patient = TestAccounts.patient('Live Patient');
            insert patient;
            TriggerHandler.bypass('AssetTriggerHandler');
            insert new Asset(
                Name = 'PM-LIVE', SerialNumber = 'PM-LIVE', AccountId = patient.Id, Status = 'Installed',
                Thing_ARN__c = THING_ARN, Provisioning_Status__c = 'Provisioned',
                Connection_Status__c = 'Online', Connection_Since__c = SINCE,
                Last_Disconnect_Reason__c = 'CONNECTION_LOST'
            );
            TriggerHandler.clearBypass('AssetTriggerHandler');
        }
    }

    private static User viewer() {
        return [SELECT Id FROM User WHERE Username = :viewerUsername()];
    }

    private static Asset liveDevice() {
        return [SELECT Id FROM Asset WHERE SerialNumber = 'PM-LIVE'];
    }

    private static String refusalFor(Id assetId) {
        try {
            DeviceLiveController.start(assetId);
        } catch (AuraHandledException e) {
            return e.getMessage();
        }
        return null;
    }

    /** A gateway page, or anything else that is not the device API's JSON. */
    private class UnreadableApi implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            HttpResponse response = new HttpResponse();
            response.setStatusCode(200);
            response.setBody('<html>Service Unavailable</html>');
            return response;
        }
    }

    @IsTest
    static void startAsksForALiveSessionAndAddsTheConnection() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = liveDevice();

        Map<String, Object> answer;
        System.runAs(viewer()) {
            Test.startTest();
            answer = DeviceLiveController.start(device.Id);
            Test.stopTest();
        }

        Assert.areEqual(new List<String>{ 'device-live' }, aws.paths, 'One call, to POST /device-live');
        Assert.areEqual('PM-LIVE', aws.bodies[0].get('thingName'), 'The Thing its Thing ARN names');
        Assert.areEqual('start', aws.bodies[0].get('mode'), 'mode start');

        Map<String, Object> live = (Map<String, Object>) answer.get('live');
        Assert.areEqual('device/PM-LIVE/live', live.get('topic'), 'The live session, as AWS answered it');
        Assert.areEqual('live-PM-LIVE-1a2b3c4d', live.get('clientId'), 'Its client id');
        Assert.isNotNull(answer.get('latest'), 'The newest stored reading');
        Assert.isNotNull(answer.get('state'), 'The patient state');

        Map<String, Object> connection = (Map<String, Object>) answer.get('connection');
        Assert.areEqual('Online', connection.get('status'), 'Connection from the Asset');
        Assert.areEqual(SINCE, connection.get('since'), 'Since when');
        Assert.areEqual('CONNECTION_LOST', connection.get('lastDisconnectReason'), 'Why it was last away');
    }

    @IsTest
    static void latestAsksForStoredReadingsOnly() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = liveDevice();

        Map<String, Object> answer;
        System.runAs(viewer()) {
            Test.startTest();
            answer = DeviceLiveController.latest(device.Id);
            Test.stopTest();
        }

        Assert.areEqual('latest', aws.bodies[0].get('mode'), 'mode latest');
        Assert.isFalse(answer.containsKey('live'), 'No live session');
        Map<String, Object> latest = (Map<String, Object>) answer.get('latest');
        Assert.areEqual(22.5, latest.get('temperature'), 'The stored reading');
        Assert.isNotNull(answer.get('connection'), 'And the connection');
    }

    @IsTest
    static void aDeviceWithoutAThingIsRefusedWithoutACallout() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = liveDevice();
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = device.Id, Thing_ARN__c = null, Provisioning_Status__c = 'Not Provisioned');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        String refusal;
        System.runAs(viewer()) {
            refusal = refusalFor(device.Id);
        }

        Assert.areEqual('This device has no AWS IoT Thing yet. Provision it first.', refusal, 'Refused');
        Assert.areEqual(0, aws.bodies.size(), 'No callout');
    }

    @IsTest
    static void aFailedCallIsRefusedWithTheReason() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 502;   // e.g. AWS refused to assume the viewer role
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = liveDevice();

        String refusal;
        System.runAs(viewer()) {
            Test.startTest();
            refusal = refusalFor(device.Id);
            Test.stopTest();
        }

        Assert.isNotNull(refusal, 'Refused');
        Assert.isTrue(refusal.startsWith('Live status is unavailable.'), refusal);
        Assert.isTrue(refusal.contains('HTTP 502'), 'The API\'s own answer: ' + refusal);
    }

    @IsTest
    static void eachKindOfFailureSaysWhatToDo() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = liveDevice();
        Map<Integer, String> adviceByStatus = new Map<Integer, String>{
            404 => 'deploy the current queue-relay stack',
            403 => 'AWS_IoT_Relay credential',
            400 => 'refused the request'
        };

        Map<Integer, String> refusalByStatus = new Map<Integer, String>();
        System.runAs(viewer()) {
            Test.startTest();
            for (Integer status : adviceByStatus.keySet()) {
                aws.statusCode = status;
                refusalByStatus.put(status, refusalFor(device.Id));
            }
            Test.stopTest();
        }

        for (Integer status : adviceByStatus.keySet()) {
            String refusal = refusalByStatus.get(status);
            Assert.isTrue(refusal.contains(adviceByStatus.get(status)), 'HTTP ' + status + ': ' + refusal);
            Assert.isTrue(refusal.contains('HTTP ' + status), 'With the API\'s answer: ' + refusal);
        }
    }

    @IsTest
    static void anUnreadableAnswerIsRefused() {
        DeviceTestSettings.use();
        Test.setMock(HttpCalloutMock.class, new UnreadableApi());
        Asset device = liveDevice();

        String refusal;
        System.runAs(viewer()) {
            Test.startTest();
            refusal = refusalFor(device.Id);
            Test.stopTest();
        }

        Assert.isNotNull(refusal, 'Refused');
        Assert.isTrue(refusal.contains('cannot read'), refusal);
        Assert.isFalse(refusal.contains('html'), 'The answer itself is not quoted: ' + refusal);
    }

    @IsTest
    static void aDeletedDeviceIsRefused() {
        DeviceTestSettings.use();
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Asset device = liveDevice();
        TriggerHandler.bypass('AssetTriggerHandler');
        delete device;
        TriggerHandler.clearBypass('AssetTriggerHandler');

        String refusal;
        System.runAs(viewer()) {
            refusal = refusalFor(device.Id);
        }

        Assert.isNotNull(refusal, 'Refused');
        Assert.isTrue(refusal.contains('no longer exists'), refusal);
    }
}
