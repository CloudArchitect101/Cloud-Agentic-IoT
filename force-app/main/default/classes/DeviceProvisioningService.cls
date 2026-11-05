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
     * numbers can be reused.
     *
     * A provisioned device loses its certificates and the Thing its Thing ARN
     * names, which is the Thing it was provisioned as even if its serial
     * number was edited since. A device whose provisioning failed, or had not
     * finished, has no Thing ARN but may have left a Thing named after its
     * serial number: AWS deletes that Thing only while it has no certificate
     * and is in no Thing Group, which is what a failed attempt leaves, and
     * keeps any other, since that may be an identity this record never got,
     * or another device's with the same serial number. A device that never
     * had a Wi-Fi Network never reached AWS, so it makes no callout. Either
     * way, a Thing that a remaining Asset still uses, as its serial number or
     * in its Thing ARN, is kept: the job checks before it calls AWS.
     */
    public static void tearDownAwsResourcesFor(List<Asset> deletedAssetRecords) {
        Set<String> thingNamesToTearDown = new Set<String>();
        Set<String> leftoverThingNames = new Set<String>();
        for (Asset device : deletedAssetRecords) {
            String provisionedAs = thingNameIn(device.Thing_ARN__c);
            if (provisionedAs != null) {
                thingNamesToTearDown.add(provisionedAs);
            } else if (String.isNotBlank(device.SerialNumber) && mayHaveReachedAws(device)) {
                leftoverThingNames.add(device.SerialNumber);
            }
        }
        // The full teardown of a Thing removes whatever a leftover would.
        leftoverThingNames.removeAll(thingNamesToTearDown);

        // One job for each kind, however many devices: each batches its Thing
        // names into as few callouts as Device_Platform_Setting__mdt allows.
        if (!thingNamesToTearDown.isEmpty()) {
            DeviceProvisioningJob.start(DeviceProvisioningJob.Action.TEARDOWN, new List<String>(thingNamesToTearDown));
        }
        if (!leftoverThingNames.isEmpty()) {
            DeviceProvisioningJob.start(DeviceProvisioningJob.Action.TEARDOWN_LEFTOVER, new List<String>(leftoverThingNames));
        }
    }

    /**
     * The Thing a Thing ARN names: arn:aws:iot:<region>:<account>:thing/<name>,
     * or null for anything else. Teardown, Re-provision and the check that no
     * other device still uses a Thing all read the name from here.
     */
    public static String thingNameIn(String thingArn) {
        String name = String.isBlank(thingArn) ? null : thingArn.substringAfter(':thing/');
        return String.isBlank(name) ? null : name;
    }

    // Provisioning starts once a device has a Wi-Fi Network, and leaves it
    // Provisioned or Failed: either way a Thing may have been made for it.
    private static Boolean mayHaveReachedAws(Asset device) {
        return device.Wi_Fi_Network__c != null
            || (String.isNotBlank(device.Provisioning_Status__c) && device.Provisioning_Status__c != 'Not Provisioned');
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
                    Id                          = device.Id,
                    Thing_ARN__c                = null,
                    Certificate_Id__c           = null,
                    Provisioning_Bundle_Link__c = null,
                    Provisioning_Expires_At__c  = null,
                    Provisioning_Error__c       = null,
                    Provisioning_Status__c      = 'Not Provisioned'
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
