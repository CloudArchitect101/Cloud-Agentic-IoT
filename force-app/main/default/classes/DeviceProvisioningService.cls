/*
 * DeviceProvisioningService.cls
 *
 * Creating an Asset with a Wi-Fi Network and no Thing ARN provisions it in AWS:
 * an IoT Thing, a unique certificate, the least-privilege policy, and Thing
 * Group membership for OTA targeting.
 *
 * What comes back is deliberately NOT the private key. AWS returns a device
 * private key exactly once and never again; routing it through Salesforce would
 * put it in every backup, export and report. Instead the Lambda writes the
 * bundle to S3 and returns a short-lived pre-signed URL, so Salesforce stores a
 * link that expires and a certificate id for audit.
 *
 * The callouts themselves run in DeviceProvisioningJob, batched and inside
 * Salesforce's limits, so a save of 200 devices (or a load of a million, with
 * DeviceProvisioningBatch) behaves the same as a save of one.
 *
 * Demonstrates: API integration, secure credential handling, async Apex,
 * workflow automation driven from the CRM.
 */
public with sharing class DeviceProvisioningService {

    /* ------------------------------------------------------- trigger entry */

    /**
     * Provisions any device that has just become ready. Eligibility lives here
     * rather than in the trigger so it can be unit tested by passing plain
     * lists, with no DML and no trigger context required.
     *
     * A device is eligible when it has a serial number (which becomes the AWS
     * IoT Thing name) and a Wi-Fi network, and has not already been provisioned.
     *
     * @param assetRecords        Trigger.new
     * @param assetRecordsBeforeUpdate Trigger.oldMap, or null on insert
     */
    public static void provisionEligibleDevices(
        List<Asset> assetRecords,
        Map<Id, Asset> assetRecordsBeforeUpdate
    ) {
        Set<Id> assetIdsToProvision = new Set<Id>();

        for (Asset device : assetRecords) {
            Boolean hasEverythingNeeded = String.isNotBlank(device.SerialNumber)
                                       && device.Wi_Fi_Network__c != null;
            Boolean isAlreadyProvisioned = String.isNotBlank(device.Thing_ARN__c);
            if (!hasEverythingNeeded || isAlreadyProvisioned) {
                continue;
            }

            if (assetRecordsBeforeUpdate != null) {
                // On update, act only when something relevant actually changed.
                // Without this check every later edit to the record - a status
                // tweak, a note - fires another provisioning callout.
                Asset deviceBeforeUpdate = assetRecordsBeforeUpdate.get(device.Id);
                Boolean becameEligible =
                       deviceBeforeUpdate.SerialNumber    != device.SerialNumber
                    || deviceBeforeUpdate.Wi_Fi_Network__c != device.Wi_Fi_Network__c
                    || deviceBeforeUpdate.Thing_ARN__c     != device.Thing_ARN__c;
                if (!becameEligible) {
                    continue;
                }
            }
            assetIdsToProvision.add(device.Id);
        }

        if (!assetIdsToProvision.isEmpty()) {
            DeviceProvisioningJob.start(DeviceProvisioningJob.Action.PROVISION, idsAsStrings(assetIdsToProvision));
        }
    }

    /**
     * Deletes the AWS footprint of devices being deleted, so their serial
     * numbers can be reused. Only devices that were actually provisioned have
     * anything in AWS to remove.
     */
    public static void tearDownAwsResourcesFor(List<Asset> deletedAssetRecords) {
        Set<String> thingNamesToTearDown = new Set<String>();
        for (Asset device : deletedAssetRecords) {
            if (String.isNotBlank(device.Thing_ARN__c) && String.isNotBlank(device.SerialNumber)) {
                thingNamesToTearDown.add(device.SerialNumber);
            }
        }
        // One job for the whole delete, however many devices: it batches the
        // Thing names into as few callouts as Device_Platform_Setting__mdt allows.
        if (!thingNamesToTearDown.isEmpty()) {
            DeviceProvisioningJob.start(DeviceProvisioningJob.Action.TEARDOWN, new List<String>(thingNamesToTearDown));
        }
    }

    /**
     * Clears stale AWS identifiers on restored records. The AWS resources were
     * deleted when the record was, so leaving the old Thing ARN in place would
     * make the record look provisioned while pointing at nothing.
     */
    public static void resetRestoredDevicesForReprovisioning(List<Asset> restoredAssetRecords) {
        List<Asset> assetsNeedingReset = new List<Asset>();
        for (Asset device : restoredAssetRecords) {
            if (String.isNotBlank(device.Thing_ARN__c)) {
                assetsNeedingReset.add(new Asset(
                    Id                         = device.Id,
                    Thing_ARN__c               = null,
                    Certificate_Id__c          = null,
                    Provisioning_Bundle_URL__c = null,
                    Provisioning_Expires_At__c = null,
                    Provisioning_Error__c      = null,
                    Provisioning_Status__c     = 'Not Provisioned'
                ));
            }
        }
        if (!assetsNeedingReset.isEmpty()) {
            // Fires after update, where provisionEligibleDevices sees the
            // cleared Thing ARN as a change and re-provisions cleanly.
            update assetsNeedingReset;
        }
    }

    /**
     * Rotates a device's certificate after its NVS was erased.
     *
     * Invocable so it can sit behind a "Re-provision" button on the Asset. The
     * AWS Thing is preserved, so every row of history keyed on the device name
     * - DynamoDB, Patient_Vitals__c, Data Cloud - survives untouched. Only the
     * credential changes.
     */
    @InvocableMethod(label='Re-provision Device'
                     description='Revokes the current certificate and issues a new one, keeping the Thing and all history.')
    public static void reprovision(List<Id> assetIds) {
        if (assetIds == null || assetIds.isEmpty()) {
            return;
        }
        DeviceProvisioningJob.start(DeviceProvisioningJob.Action.REPROVISION, idsAsStrings(new Set<Id>(assetIds)));
    }

    private static List<String> idsAsStrings(Set<Id> ids) {
        List<String> keys = new List<String>();
        for (Id recordId : ids) {
            keys.add(String.valueOf(recordId));
        }
        return keys;
    }
}
