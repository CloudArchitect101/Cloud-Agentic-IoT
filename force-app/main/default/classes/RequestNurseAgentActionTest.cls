/*
 * RequestNurseAgentActionTest.cls
 *
 * A nurse request opens one Case on the patient's own account, in the care
 * team queue, attaches only the patient's own device, and is not repeated
 * while it is open. Nothing is written for an unverified chat.
 */
@IsTest
private class RequestNurseAgentActionTest {

    private static List<PatientPortalTestData.Patient> both;

    private static Id chatOfPatientA() {
        // A Case on the care team queue moves the ward board: a callout.
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        User owner = PatientPortalTestData.ownerWithRole();
        System.runAs(owner) {
            both = PatientPortalTestData.twoPatients();
        }
        User portal;
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(both[0], 'nurse-patient-a');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');
        Id session = PatientPortalTestData.fakeSessionId(1);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{
            session => PatientPortalTestData.verifiedKey(portal.Id)
        };
        return session;
    }

    private static RequestNurseAgentAction.NurseResult ask(Id session, String reason, String deviceId) {
        RequestNurseAgentAction.NurseRequest req = new RequestNurseAgentAction.NurseRequest();
        req.messagingSessionId = session;
        req.reason = reason;
        req.deviceId = deviceId;
        return RequestNurseAgentAction.requestNurse(new List<RequestNurseAgentAction.NurseRequest>{ req })[0];
    }

    @IsTest
    static void opensOneCaseOnThePatientsAccountInTheQueue() {
        Id chat = chatOfPatientA();

        Test.startTest();
        RequestNurseAgentAction.NurseResult res = ask(chat, 'My room feels very warm', PatientPortalTestData.SERIAL_A);
        Test.stopTest();

        Assert.isTrue(res.success, res.message);
        Assert.isFalse(res.alreadyOpen);
        Case opened = [SELECT AccountId, ContactId, AssetId, Asset.SerialNumber, Origin, Priority, Owner.Type, Owner.Name
                       FROM Case WHERE CaseNumber = :res.caseNumber];
        Assert.areEqual(both[0].account.Id, opened.AccountId);
        Assert.areEqual(both[0].contact.Id, opened.ContactId);
        Assert.areEqual(PatientPortalTestData.SERIAL_A, opened.Asset.SerialNumber);
        Assert.areEqual(PatientPortalSettings.get().Nurse_Request_Origin__c, opened.Origin);
        Assert.areEqual('Queue', opened.Owner.Type, 'The care team works it from the queue');
    }

    @IsTest
    static void anotherPatientsDeviceIsNeverAttached() {
        Id chat = chatOfPatientA();

        Test.startTest();
        RequestNurseAgentAction.NurseResult res = ask(chat, 'Check this device', PatientPortalTestData.SERIAL_B);
        Test.stopTest();

        Assert.isTrue(res.success, res.message);
        Case opened = [SELECT AccountId, AssetId FROM Case WHERE CaseNumber = :res.caseNumber];
        Assert.areEqual(both[0].account.Id, opened.AccountId);
        Assert.isNull(opened.AssetId, 'B\'s device is not on A\'s account');
    }

    @IsTest
    static void aSecondRequestReturnsTheOpenOne() {
        Id chat = chatOfPatientA();

        Test.startTest();
        RequestNurseAgentAction.NurseResult first = ask(chat, 'Please come', null);
        RequestNurseAgentAction.NurseResult second = ask(chat, 'Please come now', null);
        Test.stopTest();

        Assert.isTrue(second.success, second.message);
        Assert.isTrue(second.alreadyOpen);
        Assert.areEqual(first.caseNumber, second.caseNumber);
        Assert.areEqual(1, [SELECT COUNT() FROM Case WHERE AccountId = :both[0].account.Id]);
    }

    @IsTest
    static void anUnverifiedChatWritesNothing() {
        Id chat = PatientPortalTestData.fakeSessionId(5);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{ chat => 'v2/iamessage/UNAUTH/NA/uid:guest' };

        RequestNurseAgentAction.NurseResult res = ask(chat, 'Help', null);

        Assert.isFalse(res.success);
        Assert.isNull(res.caseNumber);
        Assert.areEqual(0, [SELECT COUNT() FROM Case]);
    }

    @IsTest
    static void anEmptyReasonIsAskedFor() {
        Id chat = chatOfPatientA();
        RequestNurseAgentAction.NurseResult res = ask(chat, '  ', null);
        Assert.isFalse(res.success);
        Assert.areEqual(0, [SELECT COUNT() FROM Case]);
    }
}
