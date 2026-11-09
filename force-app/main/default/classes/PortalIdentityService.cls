/*
 * PortalIdentityService.cls
 *
 * Who is asking: a patient, a staff member, or someone not proven to be
 * either. Everything the patient portal shows a patient is scoped by the
 * AccountId this class returns (the patient's Person Account), never by a
 * value from the browser or from the agent's prompt.
 *
 * Two ways in:
 *  - forCurrentUser(): the React site calls Apex REST as the signed-in
 *    Experience Cloud user, so the running user IS the patient.
 *  - forMessagingSession(): the patient agent runs as its own agent user, not
 *    as the patient, so "with sharing" proves nothing there. The chat proves
 *    the patient instead: the site hands Enhanced Chat a token that
 *    PortalChatTokenResource signed for the signed-in user (sub = User Id),
 *    through embeddedservice_bootstrap.userVerificationAPI.setIdentityToken.
 *    Messaging verifies it against the keyset and keys the conversation's
 *    MessagingEndUser as v2/iamessage/AUTH/<keyset>/uid:<sub>. Only a key of
 *    that shape counts; an unverified chat's key never does.
 *
 * without sharing: the agent user must be able to read the session, its end
 * user and the patient's User row. What it may return is decided here.
 */
public without sharing class PortalIdentityService {

    public enum Kind { PATIENT, STAFF, UNVERIFIED }

    public class Identity {
        public Kind kind = Kind.UNVERIFIED;
        public Id userId;
        public Id accountId;
        public Id contactId;
        /** Why this is not a patient, in words the agent can repeat. */
        public String reason;

        public Boolean isPatient() {
            return kind == Kind.PATIENT && accountId != null;
        }
    }

    /** Experience Cloud user types: Customer Community, Customer Community Plus, the older portal type. */
    @TestVisible
    private static final Set<String> PATIENT_USER_TYPES = new Set<String>{
        'CspLitePortal', 'PowerCustomerSuccess', 'CustomerSuccess'
    };

    /** How Messaging keys an end user whose token it verified. */
    @TestVisible
    private static final String VERIFIED_KEY_PREFIX = 'v2/iamessage/AUTH/';

    @TestVisible
    private static final String UID_MARKER = 'uid:';

    /**
     * Tests cannot insert a MessagingSession (it needs a live channel), so they
     * put the end user's platform key here, by session Id, instead.
     */
    @TestVisible
    private static Map<Id, String> testPlatformKeys;

    public static Identity forCurrentUser() {
        return forUser(UserInfo.getUserId(), true);
    }

    public static Identity forMessagingSession(String messagingSessionId) {
        Identity none = new Identity();
        Id sessionId = asId(messagingSessionId);
        if (sessionId == null || !isMessagingSession(sessionId)) {
            none.reason = 'This conversation could not be identified, so no patient data can be shown.';
            return none;
        }
        String platformKey = platformKeyOf(sessionId);
        if (platformKey == null) {
            none.reason = 'This conversation could not be identified, so no patient data can be shown.';
            return none;
        }
        Id userId = verifiedUserId(platformKey);
        if (userId == null) {
            none.reason = 'You are not signed in to the patient portal, so I cannot show any patient data. Sign in and open the chat again.';
            return none;
        }
        // A token only ever names a patient; a staff member's User Id in one
        // does not turn a patient chat into a staff one.
        return forUser(userId, false);
    }

    /** The User Id a verified Messaging end user key carries, or null. */
    @TestVisible
    private static Id verifiedUserId(String platformKey) {
        if (String.isBlank(platformKey) || !platformKey.startsWith(VERIFIED_KEY_PREFIX)
                || !platformKey.contains(UID_MARKER)) {
            return null;
        }
        Id userId = asId(platformKey.substringAfterLast(UID_MARKER));
        try {
            return userId != null && userId.getSobjectType() == User.SObjectType ? userId : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static Identity forUser(Id userId, Boolean staffAllowed) {
        Identity who = new Identity();
        who.userId = userId;
        List<User> rows = [
            SELECT Id, UserType, IsActive, AccountId, ContactId
            FROM User
            WHERE Id = :userId
            LIMIT 1
        ];
        if (rows.isEmpty() || !rows[0].IsActive) {
            who.reason = 'This patient portal user is not active.';
            return who;
        }
        User row = rows[0];
        if (PATIENT_USER_TYPES.contains(row.UserType)) {
            if (row.AccountId == null) {
                who.reason = 'This portal user is not linked to a patient account.';
                return who;
            }
            who.kind = Kind.PATIENT;
            who.accountId = row.AccountId;
            who.contactId = row.ContactId;
            return who;
        }
        if (staffAllowed && row.UserType == 'Standard') {
            who.kind = Kind.STAFF;
            who.reason = 'Staff use the Patient Care Agent in Salesforce, not the patient portal.';
            return who;
        }
        who.reason = 'Only a signed-in patient can see patient data here.';
        return who;
    }

    private static String platformKeyOf(Id sessionId) {
        if (Test.isRunningTest() && testPlatformKeys != null) {
            return testPlatformKeys.get(sessionId);
        }
        // Dynamic, so this class compiles in an org where Messaging is not
        // turned on yet; there it simply finds no session.
        try {
            List<SObject> rows = Database.queryWithBinds(
                'SELECT MessagingEndUser.MessagingPlatformKey FROM MessagingSession WHERE Id = :sessionId LIMIT 1',
                new Map<String, Object>{ 'sessionId' => sessionId },
                AccessLevel.SYSTEM_MODE);
            if (rows.isEmpty()) {
                return null;
            }
            SObject endUser = rows[0].getSObject('MessagingEndUser');
            return endUser == null ? null : (String) endUser.get('MessagingPlatformKey');
        } catch (QueryException e) {
            System.debug(LoggingLevel.ERROR, 'MessagingSession lookup failed: ' + e.getMessage());
            return null;
        }
    }

    private static Boolean isMessagingSession(Id candidate) {
        try {
            return candidate.getSobjectType().getDescribe().getName() == 'MessagingSession';
        } catch (Exception e) {
            return false;   // a key prefix this org does not know
        }
    }

    private static Id asId(String value) {
        if (String.isBlank(value)) {
            return null;
        }
        try {
            return Id.valueOf(value.trim());
        } catch (StringException e) {
            return null;
        }
    }
}
