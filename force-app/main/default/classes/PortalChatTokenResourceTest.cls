/*
 * PortalChatTokenResourceTest.cls
 *
 * Only a signed-in patient gets a chat token, and the token says exactly who
 * they are (sub = their User Id), for a short time, with the keyset's kid and
 * issuer, and nothing else about them.
 */
@IsTest
private class PortalChatTokenResourceTest {

    private static Patient_Portal_Setting__mdt setting(String siteUrl) {
        return new Patient_Portal_Setting__mdt(
            DeveloperName = 'Default', Certificate_Name__c = 'Patient_Portal_Chat', Key_Id__c = 'kid-1',
            Issuer__c = 'test-issuer', Deployment_Name__c = 'Patient_Portal_Chat', Chat_Site_Url__c = siteUrl,
            Scrt_Url__c = 'https://example.my.salesforce-scrt.com', Token_Minutes__c = 5,
            Nurse_Request_Origin__c = 'Patient Portal', Nurse_Request_Queue__c = 'Care_Team_Queue');
    }

    private static Map<String, Object> claims(String token) {
        String payload = token.split('\\.')[1].replace('-', '+').replace('_', '/');
        while (Math.mod(payload.length(), 4) != 0) {
            payload += '=';
        }
        return (Map<String, Object>) JSON.deserializeUntyped(EncodingUtil.base64Decode(payload).toString());
    }

    private static User portalPatient() {
        User owner = PatientPortalTestData.ownerWithRole();
        PatientPortalTestData.Patient p;
        System.runAs(owner) {
            p = PatientPortalTestData.patient('Token Patient');
        }
        User portal;
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(p, 'token-patient');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');
        return portal;
    }

    @IsTest
    static void aPatientGetsATokenThatNamesOnlyThem() {
        PatientPortalSettings.testOverride = setting('https://example.my.site.com/ESWPatientPortalChat1');
        PortalChatTokenResource.fakeSignature = true;
        User portal = portalPatient();

        PortalChatTokenResource.ChatStart chat;
        System.runAs(portal) {
            chat = PortalChatTokenResource.start();
        }

        Assert.isTrue(chat.enabled, chat.message);
        Assert.areEqual('Patient_Portal_Chat', chat.deploymentName);
        Assert.areEqual('https://example.my.salesforce-scrt.com', chat.scrtUrl);
        Map<String, Object> c = claims(chat.token);
        Assert.areEqual(String.valueOf(portal.Id), c.get('sub'));
        Assert.areEqual('test-issuer', c.get('iss'));
        Assert.areEqual(4, c.size(), 'iss, sub, iat and exp: no name, email or account');
        // JSON numbers this size come back as Integer, so read them as text.
        Long lifetime = Long.valueOf(String.valueOf(c.get('exp'))) - Long.valueOf(String.valueOf(c.get('iat')));
        Assert.areEqual(300, lifetime, 'Five minutes');
    }

    @IsTest
    static void staffGetNoToken() {
        PatientPortalSettings.testOverride = setting('https://example.my.site.com/ESWPatientPortalChat1');
        PortalChatTokenResource.fakeSignature = true;
        PortalChatTokenResource.ChatStart chat = PortalChatTokenResource.start();
        Assert.isFalse(chat.enabled);
        Assert.isNull(chat.token);
    }

    @IsTest
    static void noChatSiteMeansTheChatStaysOff() {
        PatientPortalSettings.testOverride = setting(null);
        User portal = portalPatient();
        PortalChatTokenResource.ChatStart chat;
        System.runAs(portal) {
            chat = PortalChatTokenResource.start();
        }
        Assert.isFalse(chat.enabled);
        Assert.isNull(chat.token);
        Assert.isTrue(chat.message.contains('Chat_Site_Url__c'), chat.message);
    }

    @IsTest
    static void aMissingCertificateIsReportedNotThrown() {
        PatientPortalSettings.testOverride = setting('https://example.my.site.com/ESWPatientPortalChat1');
        PatientPortalSettings.testOverride.Certificate_Name__c = 'No_Such_Certificate';
        User portal = portalPatient();
        PortalChatTokenResource.ChatStart chat;
        System.runAs(portal) {
            chat = PortalChatTokenResource.start();
        }
        Assert.isFalse(chat.enabled);
        Assert.isNull(chat.token);
    }

    @IsTest
    static void base64UrlHasNoPaddingOrUnsafeCharacters() {
        String encoded = PortalChatTokenResource.base64Url(Blob.valueOf('??>>~~'));
        Assert.isFalse(encoded.contains('+') || encoded.contains('/') || encoded.contains('='), encoded);
    }

    @IsTest
    static void theScrtHostFollowsTheOrgDomain() {
        Assert.areEqual('https://acme-dev-ed.develop.my.salesforce-scrt.com',
            PatientPortalSettings.scrtUrlFor('https://acme-dev-ed.develop.my.salesforce.com/'));
    }
}
