/*
 * MyDevicesAgentActionTest.cls
 *
 * The patient agent's read action answers from the verified chat's patient
 * only. The headline test: in patient A's chat, asking for patient B's
 * device by its serial number gets "not linked to your account".
 */
@IsTest
private class MyDevicesAgentActionTest {

    private static Id chatOf(Id portalUserId, Integer n) {
        Id session = PatientPortalTestData.fakeSessionId(n);
        if (PortalIdentityService.testPlatformKeys == null) {
            PortalIdentityService.testPlatformKeys = new Map<Id, String>();
        }
        PortalIdentityService.testPlatformKeys.put(session, PatientPortalTestData.verifiedKey(portalUserId));
        return session;
    }

    private static MyDevicesAgentAction.MyDevicesResult ask(Id session, String deviceId) {
        MyDevicesAgentAction.MyDevicesRequest req = new MyDevicesAgentAction.MyDevicesRequest();
        req.messagingSessionId = session;
        req.deviceId = deviceId;
        req.readingCount = 5;
        return MyDevicesAgentAction.getMyDevices(new List<MyDevicesAgentAction.MyDevicesRequest>{ req })[0];
    }

    /** Patient A's portal user, with both patients' data in place. */
    private static User patientA() {
        User owner = PatientPortalTestData.ownerWithRole();
        List<PatientPortalTestData.Patient> both;
        System.runAs(owner) {
            both = PatientPortalTestData.twoPatients();
        }
        User portal;
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(both[0], 'devices-patient-a');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');
        return portal;
    }

    @IsTest
    static void patientAGetsTheirOwnDeviceAndReadings() {
        Id chat = chatOf(patientA().Id, 1);

        MyDevicesAgentAction.MyDevicesResult res = ask(chat, null);

        Assert.isTrue(res.success, res.message);
        Assert.isTrue(res.patientVerified);
        Assert.areEqual(1, res.deviceCount);
        Assert.isTrue(res.devices.contains(PatientPortalTestData.SERIAL_A), res.devices);
        Assert.isTrue(res.devices.contains('temperature 23.0 C'), res.devices);
        Assert.isFalse(res.devices.contains(PatientPortalTestData.SERIAL_B), 'Never B\'s device');
        Assert.isFalse(res.devices.contains(PatientPortalTestData.SERIAL_A_INTERNAL), 'Never an internal board');
    }

    @IsTest
    static void patientACannotReadPatientBsDeviceByNamingIt() {
        Id chat = chatOf(patientA().Id, 2);

        MyDevicesAgentAction.MyDevicesResult res = ask(chat, PatientPortalTestData.SERIAL_B);

        Assert.areEqual(0, res.deviceCount);
        Assert.areEqual('', res.devices);
        Assert.areEqual('No device ' + PatientPortalTestData.SERIAL_B + ' is linked to your account.', res.message,
            'The same answer as for a device that does not exist');
    }

    @IsTest
    static void anUnverifiedChatGetsNoData() {
        PatientPortalTestData.twoPatients();
        Id chat = PatientPortalTestData.fakeSessionId(3);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{ chat => 'v2/iamessage/UNAUTH/NA/uid:guest' };

        MyDevicesAgentAction.MyDevicesResult res = ask(chat, PatientPortalTestData.SERIAL_A);

        Assert.isFalse(res.success);
        Assert.isFalse(res.patientVerified);
        Assert.areEqual('', res.devices);
        Assert.isTrue(res.message.contains('not signed in'), res.message);
    }

    @IsTest
    static void aMadeUpSessionIdGetsNoData() {
        PatientPortalTestData.twoPatients();
        PortalIdentityService.testPlatformKeys = new Map<Id, String>();

        MyDevicesAgentAction.MyDevicesResult res = ask(PatientPortalTestData.fakeSessionId(9), null);

        Assert.isFalse(res.patientVerified);
        Assert.areEqual('', res.devices);
    }
}
