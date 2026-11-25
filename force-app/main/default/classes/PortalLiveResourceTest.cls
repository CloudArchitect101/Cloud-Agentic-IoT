/*
 * PortalLiveResourceTest.cls
 *
 * The portal's live view: a patient gets a live link for their own device and
 * for no one else's, staff get a 403, and an AWS failure is a 502 that holds
 * no link.
 */
@IsTest
private class PortalLiveResourceTest {

    private static User patientB() {
        User owner = PatientPortalTestData.ownerWithRole();
        List<PatientPortalTestData.Patient> both;
        System.runAs(owner) {
            both = PatientPortalTestData.twoPatients();
        }
        User portal;
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(both[1], 'live-patient-b');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');
        return portal;
    }

    private static String ask(String serial) {
        return JSON.serialize(new Map<String, Object>{ 'serialNumber' => serial });
    }

    @IsTest
    static void thePatientGetsALiveLinkForTheirOwnDevice() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        User portal = patientB();

        PortalLiveResource.Answer answer;
        System.runAs(portal) {
            answer = PortalLiveResource.start(ask(PatientPortalTestData.SERIAL_B));
        }

        Assert.areEqual(200, answer.status, String.valueOf(answer.body));
        Map<String, Object> live = (Map<String, Object>) answer.body.get('live');
        Assert.isTrue(((String) live.get('url')).startsWith('wss://'));
        Assert.areEqual('device/' + PatientPortalTestData.SERIAL_B + '/live', live.get('topic'));
        Assert.areEqual(new List<String>{ 'device-live' }, aws.paths);
        Assert.areEqual('start', aws.bodies[0].get('mode'));
    }

    @IsTest
    static void anotherPatientsDeviceIsNotFoundAndCostsNoCallout() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        User portal = patientB();

        PortalLiveResource.Answer answer;
        System.runAs(portal) {
            answer = PortalLiveResource.start(ask(PatientPortalTestData.SERIAL_A));
        }

        Assert.areEqual(404, answer.status);
        Assert.isNull(answer.body.get('live'));
        Assert.isTrue(aws.paths.isEmpty());
    }

    @IsTest
    static void aRequestWithoutASerialIsRefused() {
        DeviceTestSettings.use();
        User portal = patientB();
        System.runAs(portal) {
            Assert.areEqual(400, PortalLiveResource.start(null).status);
            Assert.areEqual(400, PortalLiveResource.start('{"serialNumber":""}').status);
            Assert.areEqual(400, PortalLiveResource.start('not json').status);
        }
    }

    @IsTest
    static void anAwsFailureIsA502WithoutALink() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 500;
        Test.setMock(HttpCalloutMock.class, aws);
        User portal = patientB();

        PortalLiveResource.Answer answer;
        System.runAs(portal) {
            answer = PortalLiveResource.start(ask(PatientPortalTestData.SERIAL_B));
        }

        Assert.areEqual(502, answer.status);
        Assert.isNull(answer.body.get('live'));
    }

    @IsTest
    static void staffGetA403() {
        PatientPortalTestData.twoPatients();
        PortalLiveResource.Answer answer = PortalLiveResource.start(ask(PatientPortalTestData.SERIAL_B));
        Assert.areEqual(403, answer.status);
    }

    @IsTest
    static void theEndpointWritesJson() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();
        PortalLiveResource.post();
        Assert.areEqual(403, RestContext.response.statusCode);
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(RestContext.response.responseBody.toString());
        Assert.isNotNull(body.get('message'));
    }
}
