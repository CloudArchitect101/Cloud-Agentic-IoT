/*
 * DeviceReprovisionController.cls
 *
 * Server side of the Re-provision button on a device's record page
 * (lwc/reprovisionDevice, quick action Asset.Reprovision_Device).
 *
 * The work itself is DeviceProvisioningService.reprovision, the same entry
 * point a Flow could call. What this adds is the checks a person needs at the
 * moment they press the button: a device that was never provisioned has no
 * certificate to replace, and someone who may not edit the device may not
 * rotate its credentials either. Without them the button would always say
 * "started", and the refusal would surface a minute later as a Failed status.
 */
public with sharing class DeviceReprovisionController {

    @AuraEnabled
    public static void reprovision(Id assetId) {
        // with sharing: a device this user cannot see is not found at all.
        List<Asset> devices = [
            SELECT Id, SerialNumber, Thing_ARN__c
            FROM Asset
            WHERE Id = :assetId
            LIMIT 1
        ];
        if (devices.isEmpty()) {
            throw refusal('This device no longer exists, or you do not have access to it.');
        }
        Asset device = devices[0];

        List<UserRecordAccess> access = [
            SELECT RecordId, HasEditAccess
            FROM UserRecordAccess
            WHERE UserId = :UserInfo.getUserId() AND RecordId = :device.Id
        ];
        if (access.isEmpty() || !access[0].HasEditAccess) {
            throw refusal('You need edit access to this device to re-provision it.');
        }
        if (String.isBlank(device.SerialNumber)) {
            throw refusal('Serial Number is empty. It is the AWS IoT Thing name, so set it first.');
        }
        if (String.isBlank(device.Thing_ARN__c)) {
            throw refusal('This device was never provisioned, so it has no certificate to replace. '
                + 'Set its Wi-Fi Network and save, and it is provisioned automatically.');
        }

        DeviceProvisioningService.reprovision(new List<Id>{ device.Id });
    }

    private static AuraHandledException refusal(String message) {
        AuraHandledException e = new AuraHandledException(message);
        // Without this, getMessage() says "Script-thrown exception" in tests and logs.
        e.setMessage(message);
        return e;
    }
}
