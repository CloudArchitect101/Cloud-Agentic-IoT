/*
 * PortalIdentityServiceTest.cls
 *
 * Who counts as a patient: only a verified chat key, and only for an active
 * portal user with an account. An unverified chat, a malformed key, a staff
 * member's Id in a key, or a session Id of the wrong type never does.
 */
@IsTest
private class PortalIdentityServiceTest {

    @IsTest
    static void onlyAVerifiedKeyYieldsAUserId() {
        Id someone = UserInfo.getUserId();
        Assert.areEqual(someone, PortalIdentityService.verifiedUserId(PatientPortalTestData.verifiedKey(someone)));
        Assert.isNull(PortalIdentityService.verifiedUserId('v2/iamessage/UNAUTH/NA/uid:' + someone),
            'An unverified (guest) chat key never names a user');
        Assert.isNull(PortalIdentityService.verifiedUserId('v2/iamessage/AUTH/keyset/uid:not-an-id'));
        Assert.isNull(PortalIdentityService.verifiedUserId('v2/iamessage/AUTH/keyset/uid:' + UserInfo.getOrganizationId()),
            'An Id that is not a User is not a patient');
        Assert.isNull(PortalIdentityService.verifiedUserId(null));
    }

    @IsTest
    static void aSessionIdOfAnotherTypeIsRefused() {
        PortalIdentityService.Identity who = PortalIdentityService.forMessagingSession(UserInfo.getUserId());
        Assert.isFalse(who.isPatient());
        Assert.isNotNull(who.reason);
        Assert.isFalse(PortalIdentityService.forMessagingSession('nonsense').isPatient());
        Assert.isFalse(PortalIdentityService.forMessagingSession(null).isPatient());
    }

    @IsTest
    static void anUnverifiedChatIsNotAPatient() {
        Id session = PatientPortalTestData.fakeSessionId(1);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{
            session => 'v2/iamessage/UNAUTH/NA/uid:' + UserInfo.getUserId()
        };
        PortalIdentityService.Identity who = PortalIdentityService.forMessagingSession(session);
        Assert.areEqual(PortalIdentityService.Role.UNVERIFIED, who.kind);
        Assert.isTrue(who.reason.contains('not signed in'), who.reason);
    }

    @IsTest
    static void aStaffMembersIdInAVerifiedChatIsNotAPatientNorStaff() {
        Id session = PatientPortalTestData.fakeSessionId(2);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{
            session => PatientPortalTestData.verifiedKey(UserInfo.getUserId())
        };
        PortalIdentityService.Identity who = PortalIdentityService.forMessagingSession(session);
        Assert.areEqual(PortalIdentityService.Role.UNVERIFIED, who.kind,
            'A chat never becomes a staff conversation');
        Assert.isNull(who.accountId);
    }

    @IsTest
    static void theRunningStaffUserIsStaff() {
        PortalIdentityService.Identity who = PortalIdentityService.forCurrentUser();
        Assert.areEqual(PortalIdentityService.Role.STAFF, who.kind);
        Assert.isFalse(who.isPatient());
    }

    @IsTest
    static void aVerifiedPortalUserIsThePatientOfTheirOwnAccount() {
        User owner = PatientPortalTestData.ownerWithRole();
        PatientPortalTestData.Patient a;
        User portal;
        System.runAs(owner) {
            a = PatientPortalTestData.patient('Identity Patient');
        }
        // A User and the account's records in one context is mixed DML.
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(a, 'identity-patient');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');

        Id session = PatientPortalTestData.fakeSessionId(3);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{
            session => PatientPortalTestData.verifiedKey(portal.Id)
        };
        PortalIdentityService.Identity viaChat = PortalIdentityService.forMessagingSession(session);
        Assert.isTrue(viaChat.isPatient(), 'The verified chat should be the patient: ' + viaChat.reason);
        Assert.areEqual(a.account.Id, viaChat.accountId);
        Assert.areEqual(a.contact.Id, viaChat.contactId);

        PortalIdentityService.Identity signedIn;
        System.runAs(portal) {
            signedIn = PortalIdentityService.forCurrentUser();
        }
        Assert.isTrue(signedIn.isPatient(), 'The signed-in user should be the patient: ' + signedIn.reason);
        Assert.areEqual(a.account.Id, signedIn.accountId);
    }

    @IsTest
    static void aDeactivatedPortalUserIsNoLongerAPatient() {
        User owner = PatientPortalTestData.ownerWithRole();
        User portal;
        PatientPortalTestData.Patient gone;
        System.runAs(owner) {
            gone = PatientPortalTestData.patient('Gone Patient');
        }
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(gone, 'gone-patient');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');
        System.runAs(PatientPortalTestData.me()) {
            portal.IsActive = false;
            update portal;
        }
        Id session = PatientPortalTestData.fakeSessionId(4);
        PortalIdentityService.testPlatformKeys = new Map<Id, String>{
            session => PatientPortalTestData.verifiedKey(portal.Id)
        };
        Assert.isFalse(PortalIdentityService.forMessagingSession(session).isPatient(),
            'A token issued before deactivation must not keep working');
    }
}
