/*
 * PatientPortalTestData.cls
 *
 * Two patients for the patient portal's tests, so every test can prove the
 * one thing that matters: patient A never sees patient B's device.
 *
 *  A: account "Portal Patient A", Patient Device PORTAL-A1 (2 readings) and
 *     an Internal Device PORTAL-A-INT, which a patient must not see either.
 *  B: account "Portal Patient B", Patient Device PORTAL-B1 (1 reading).
 *
 * Business accounts with a contact: the scoping is by AccountId, which works
 * the same for a Person Account, so the tests run whether or not the org has
 * Person Accounts turned on.
 */
@IsTest
public class PatientPortalTestData {

    public static final String SERIAL_A = 'PORTAL-A1';
    public static final String SERIAL_A_INTERNAL = 'PORTAL-A-INT';
    public static final String SERIAL_B = 'PORTAL-B1';

    private static Integer readingNumber = 0;

    public class Patient {
        public Account account;
        public Contact contact;
    }

    public static Patient patient(String name) {
        Patient p = new Patient();
        p.account = new Account(Name = name);
        insert p.account;
        p.contact = new Contact(LastName = name, AccountId = p.account.Id);
        insert p.contact;
        return p;
    }

    public static Asset device(Id accountId, String serial, Id recordTypeId) {
        Asset device = new Asset(
            Name = 'Monitor ' + serial, SerialNumber = serial, AccountId = accountId, Status = 'Installed',
            RecordTypeId = recordTypeId, Connection_Status__c = 'Online',
            Connection_Since__c = Datetime.newInstanceGmt(2026, 11, 9, 8, 0, 0)
        );
        // The Asset trigger would provision the device in AWS.
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    public static Patient_Vitals__c reading(String serial, Integer minute, Decimal temperature) {
        readingNumber++;
        return new Patient_Vitals__c(
            Device__c = serial,
            Device_Reading_Id__c = serial + '-' + readingNumber,
            Timestamp__c = Datetime.newInstanceGmt(2026, 11, 9, 12, minute, 0),
            Temperature__c = temperature,
            Humidity__c = 40,
            Source_System__c = 'AWS_IoT'
        );
    }

    /** Both patients, their devices and readings. Returns [A, B]. */
    public static List<Patient> twoPatients() {
        Patient a = patient('Portal Patient A');
        Patient b = patient('Portal Patient B');
        device(a.account.Id, SERIAL_A, DeviceRoles.patientRecordTypeId());
        device(a.account.Id, SERIAL_A_INTERNAL, DeviceRoles.internalRecordTypeId());
        device(b.account.Id, SERIAL_B, DeviceRoles.patientRecordTypeId());
        insert new List<Patient_Vitals__c>{
            reading(SERIAL_A, 1, 22.5), reading(SERIAL_A, 2, 23.0),
            reading(SERIAL_A_INTERNAL, 1, 21.0),
            reading(SERIAL_B, 1, 24.0)
        };
        return new List<Patient>{ a, b };
    }

    /** A MessagingSession Id that does not exist in the org; tests key a platform key to it. */
    public static Id fakeSessionId(Integer n) {
        String prefix = Schema.getGlobalDescribe().containsKey('MessagingSession')
            ? Schema.getGlobalDescribe().get('MessagingSession').getDescribe().getKeyPrefix()
            : '0Mw';
        return Id.valueOf(prefix + '000000000000'.left(12 - String.valueOf(n).length()) + n);
    }

    /** A verified chat for this user, as Messaging keys it. */
    public static String verifiedKey(Id userId) {
        return 'v2/iamessage/AUTH/Patient_Portal_Keyset/uid:' + userId;
    }

    /**
     * An active Experience Cloud user for the patient's contact, or null when
     * the org has no Experience Cloud user licence. Account owners must have
     * a role before their accounts can have portal users, so the accounts are
     * handed to a user with one first.
     */
    public static User portalUser(Patient p, String who) {
        List<Profile> profiles = [
            SELECT Id FROM Profile
            WHERE UserType IN ('CspLitePortal', 'PowerCustomerSuccess', 'CustomerSuccess')
            ORDER BY UserType
            LIMIT 1
        ];
        if (profiles.isEmpty()) {
            return null;
        }
        User portal = user(who, profiles[0].Id);
        portal.ContactId = p.contact.Id;
        insert portal;
        return portal;
    }

    /** The running user, for a runAs that separates setup DML from record DML. */
    public static User me() {
        return new User(Id = UserInfo.getUserId());
    }

    /** An admin with a role, to own the patient accounts. Call before creating patients. */
    public static User ownerWithRole() {
        UserRole role = new UserRole(Name = 'Portal Test Owner', DeveloperName = 'Portal_Test_Owner_' + Crypto.getRandomInteger().format().remove(',').remove('-'));
        insert role;
        User owner = user('portal-owner', UserInfo.getProfileId());
        owner.UserRoleId = role.Id;
        insert owner;
        return owner;
    }

    public static User user(String who, Id profileId) {
        return new User(
            Username          = who + '@' + UserInfo.getOrganizationId() + '.example.com',
            Email             = who + '@example.com',
            LastName          = who,
            Alias             = who.left(8),
            ProfileId         = profileId,
            TimeZoneSidKey    = 'GMT',
            LocaleSidKey      = 'en_US',
            LanguageLocaleKey = 'en_US',
            EmailEncodingKey  = 'UTF-8'
        );
    }
}
