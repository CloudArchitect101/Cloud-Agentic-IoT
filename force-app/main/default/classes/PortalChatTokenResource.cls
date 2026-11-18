/*
 * PortalChatTokenResource.cls
 *
 * POST /services/apexrest/portal/chat-token
 *
 * The patient portal calls this as the signed-in patient, right before it
 * starts Enhanced Chat. It returns what the chat needs to start (org Id,
 * deployment, site and SCRT URLs) and a short-lived token that proves to
 * Messaging who the patient is: an RS256 JWT, signed with the org's
 * Patient_Portal_Chat certificate, whose sub is the patient's User Id. The
 * site passes it to embeddedservice_bootstrap.userVerificationAPI
 * .setIdentityToken; Messaging checks it against the keyset that holds the
 * certificate's public key, and the conversation becomes a verified one
 * (PortalIdentityService.forMessagingSession reads it back).
 *
 * Only a patient gets a token. The private key never leaves Salesforce, and
 * the token carries no name, email or account Id.
 */
@RestResource(urlMapping='/portal/chat-token')
global with sharing class PortalChatTokenResource {

    /** Tests cannot sign with a certificate that is not in the test org. */
    @TestVisible
    private static Boolean fakeSignature = false;

    @TestVisible
    private class ChatStart {
        public Boolean enabled;
        public String message;
        public String orgId;
        public String deploymentName;
        public String siteUrl;
        public String scrtUrl;
        public String token;
        public Long expiresAt;
    }

    @HttpPost
    global static void issue() {
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.addHeader('Cache-Control', 'no-store');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(start(), true));
    }

    @TestVisible
    private static ChatStart start() {
        ChatStart chat = new ChatStart();
        chat.enabled = false;
        PortalIdentityService.Identity who = PortalIdentityService.forCurrentUser();
        if (!who.isPatient()) {
            if (RestContext.response != null) {
                RestContext.response.statusCode = 403;
            }
            chat.message = who.reason;
            return chat;
        }
        Patient_Portal_Setting__mdt setting = PatientPortalSettings.get();
        if (String.isBlank(setting.Chat_Site_Url__c)) {
            // The patient sees plain words; the setup detail goes to the debug log.
            System.debug(LoggingLevel.WARN, 'Chat off: Patient_Portal_Setting__mdt.Default.Chat_Site_Url__c is blank (docs/PATIENT-PORTAL.md, step 8).');
            chat.message = 'The care assistant is not available yet. If you need help, press the call button by your bed.';
            return chat;
        }
        // Enhanced Chat wants the 15-character org Id, as in the deployment's
        // code snippet. Its access token carries 15 characters, and with the
        // 18-character Id every call after the first reply fails with 400.
        chat.orgId = String.valueOf(UserInfo.getOrganizationId()).left(15);
        chat.deploymentName = setting.Deployment_Name__c;
        chat.siteUrl = setting.Chat_Site_Url__c.removeEnd('/');
        chat.scrtUrl = PatientPortalSettings.scrtUrl();
        Long now = Datetime.now().getTime() / 1000;
        chat.expiresAt = now + PatientPortalSettings.tokenMinutes() * 60;
        try {
            chat.token = jwt(setting, who.userId, now, chat.expiresAt);
        } catch (Exception e) {
            // Most often the certificate named in the setting does not exist.
            System.debug(LoggingLevel.ERROR, 'Chat token signing failed: ' + e.getMessage());
            chat.message = 'The chat could not sign you in. Ask the care team; the setup guide covers the chat certificate.';
            return chat;
        }
        chat.enabled = true;
        return chat;
    }

    @TestVisible
    private static String jwt(Patient_Portal_Setting__mdt setting, Id userId, Long issuedAt, Long expiresAt) {
        Map<String, Object> header = new Map<String, Object>{
            'alg' => 'RS256', 'typ' => 'JWT', 'kid' => setting.Key_Id__c
        };
        Map<String, Object> claims = new Map<String, Object>{
            'iss' => setting.Issuer__c,
            'sub' => String.valueOf(userId),
            'iat' => issuedAt,
            'exp' => expiresAt
        };
        String signingInput = base64Url(Blob.valueOf(JSON.serialize(header)))
            + '.' + base64Url(Blob.valueOf(JSON.serialize(claims)));
        Blob signature = fakeSignature
            ? Blob.valueOf('test-signature')
            : Crypto.signWithCertificate('RSA-SHA256', Blob.valueOf(signingInput), setting.Certificate_Name__c);
        return signingInput + '.' + base64Url(signature);
    }

    @TestVisible
    private static String base64Url(Blob data) {
        return EncodingUtil.base64Encode(data).replace('+', '-').replace('/', '_').remove('=');
    }
}
