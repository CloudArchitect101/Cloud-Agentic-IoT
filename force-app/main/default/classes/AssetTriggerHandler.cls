/*
 * AssetTriggerHandler.cls
 *
 * Routes Asset trigger contexts to the device provisioning service. Holds no
 * business logic: deciding which devices are eligible to provision, and what
 * "provisioned" means, belongs in the service where it can be tested without
 * performing DML.
 */
public with sharing class AssetTriggerHandler extends TriggerHandler {

    protected override void handleAfterInsert() {
        DeviceProvisioningService.provisionEligibleDevices(
            (List<Asset>) Trigger.new, null
        );
    }

    protected override void handleAfterUpdate() {
        DeviceProvisioningService.provisionEligibleDevices(
            (List<Asset>) Trigger.new, (Map<Id, Asset>) Trigger.oldMap
        );
    }

    protected override void handleAfterDelete() {
        DeviceProvisioningService.tearDownAwsResourcesFor((List<Asset>) Trigger.old);
    }

    protected override void handleAfterUndelete() {
        // Restoring from the Recycle Bin restores the record but not the AWS
        // resources, which were deleted on the way in.
        DeviceProvisioningService.resetRestoredDevicesForReprovisioning((List<Asset>) Trigger.new);
    }
}
