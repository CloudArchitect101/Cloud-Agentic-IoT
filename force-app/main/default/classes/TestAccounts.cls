/*
 * TestAccounts.cls
 *
 * The account a test's patient device belongs to. A Patient Device must
 * belong to a Person Account (validation rule
 * Asset.Patient_Device_Needs_Person_Account), so every test that saves one
 * makes its patient here.
 *
 * Dynamic on purpose: the person-account fields (LastName on Account,
 * PersonContactId, RecordType.IsPersonType) exist only in an org with Person
 * Accounts on, and this class must compile in any org.
 */
@IsTest
public class TestAccounts {

    private static Id personRecordTypeId;
    private static Boolean looked = false;

    /** The Person Account record type, or null when the org has no Person Accounts. */
    public static Id personRecordTypeId() {
        if (!looked) {
            looked = true;
            if (Schema.SObjectType.Account.fields.getMap().containsKey('ispersonaccount')) {
                List<SObject> rows = Database.query(
                    'SELECT Id FROM RecordType WHERE SobjectType = \'Account\' AND IsPersonType = true AND IsActive = true LIMIT 1');
                personRecordTypeId = rows.isEmpty() ? null : (Id) rows[0].get('Id');
            }
        }
        return personRecordTypeId;
    }

    /** An unsaved patient: a Person Account named name (a business account where the org has none). */
    public static Account patient(String name) {
        Id personType = personRecordTypeId();
        if (personType == null) {
            return new Account(Name = name);
        }
        Account patient = new Account(RecordTypeId = personType);
        patient.put('LastName', name);
        return patient;
    }

    /** The Contact Salesforce keeps behind a saved Person Account, or null for a business account. */
    public static Id personContactId(Id accountId) {
        if (personRecordTypeId() == null) {
            return null;
        }
        List<SObject> rows = Database.query('SELECT PersonContactId FROM Account WHERE Id = :accountId');
        return rows.isEmpty() ? null : (Id) rows[0].get('PersonContactId');
    }
}
