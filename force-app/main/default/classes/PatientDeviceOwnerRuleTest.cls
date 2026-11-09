/*
 * PatientDeviceOwnerRuleTest.cls
 *
 * The validation rule Asset.Patient_Device_Needs_Person_Account: a Patient
 * Device saves on a Person Account and is refused on a business account; an
 * Internal Device may sit on a business account. (An existing device on a
 * business account still takes status updates: the rule checks only new
 * devices and a change of Account or record type.)
 */
@IsTest
private class PatientDeviceOwnerRuleTest {

    private static Asset device(Id accountId, String serial, Id recordTypeId) {
        return new Asset(Name = 'Monitor ' + serial, SerialNumber = serial, AccountId = accountId,
                         Status = 'Installed', RecordTypeId = recordTypeId);
    }

    private static Boolean saves(SObject record, Boolean isInsert) {
        // The Asset trigger would provision the device in AWS.
        TriggerHandler.bypass('AssetTriggerHandler');
        Database.SaveResult result = isInsert ? Database.insert(record, false) : Database.update(record, false);
        TriggerHandler.clearBypass('AssetTriggerHandler');
        if (!result.isSuccess()) {
            Assert.isTrue(result.getErrors()[0].getMessage().contains('Person Account'),
                'Refused for another reason: ' + result.getErrors()[0].getMessage());
        }
        return result.isSuccess();
    }

    @IsTest
    static void aPatientDeviceSavesOnAPersonAccountOnly() {
        if (TestAccounts.personRecordTypeId() == null) {
            return;   // no Person Accounts, so the rule cannot exist in this org
        }
        Account patient = TestAccounts.patient('Rule Patient');
        Account ward = new Account(Name = 'Rule Ward');
        insert new List<Account>{ patient, ward };

        Assert.isTrue(saves(device(patient.Id, 'RULE-P', DeviceRoles.patientRecordTypeId()), true), 'On a Person Account');
        Assert.isFalse(saves(device(ward.Id, 'RULE-W', DeviceRoles.patientRecordTypeId()), true), 'On a business account');
        Assert.isTrue(saves(device(ward.Id, 'RULE-I', DeviceRoles.internalRecordTypeId()), true), 'An Internal Device on a ward');
    }

    @IsTest
    static void becomingAPatientDeviceOnAWardIsRefused() {
        if (TestAccounts.personRecordTypeId() == null) {
            return;   // no Person Accounts, so the rule cannot exist in this org
        }
        Account ward = new Account(Name = 'Rule Ward');
        insert ward;
        Asset board = device(ward.Id, 'RULE-I2', DeviceRoles.internalRecordTypeId());
        Assert.isTrue(saves(board, true));

        Assert.isFalse(saves(new Asset(Id = board.Id, RecordTypeId = DeviceRoles.patientRecordTypeId()), false),
            'Switching to Patient Device on a business account');
    }
}
