/*
 * DeviceProvisioningBatch.cls
 *
 * Provisions every device that is ready and still waiting: it has a Serial
 * Number and a Wi-Fi Network, no Thing ARN, and is Not Provisioned.
 *
 * This is how a large fleet is onboarded. Load the Assets as a user whose
 * Integration Control custom setting has Bypass All Triggers checked, so the
 * load itself starts no callouts, then run
 *
 *     DeviceProvisioningBatch.run();
 *
 * Each batch execution provisions as many devices as fit in one transaction's
 * callouts (Devices_Per_Callout__c x Callouts_Per_Job__c). A device AWS is too
 * busy for stays Not Provisioned and is picked up on the next run, so the job
 * can simply run again, or be scheduled as a safety net for any device whose
 * trigger job never got to start:
 *
 *     System.schedule('Provision waiting devices', '0 15 * * * ?', new DeviceProvisioningBatch());
 *
 * The pace is set by AWS, not Salesforce: AWS IoT creates certificates at 10 a
 * second per account by default, so a million devices take about 28 hours
 * unless that quota is raised (docs/SCALING.md).
 */
public with sharing class DeviceProvisioningBatch
        implements Database.Batchable<SObject>, Database.AllowsCallouts, Schedulable {

    public static Id run() {
        return Database.executeBatch(new DeviceProvisioningBatch(), scopeSize());
    }

    /** As many devices as one execution's callouts can carry; a batch scope is at most 2,000 records. */
    @TestVisible
    private static Integer scopeSize() {
        return Math.min(2000, DevicePlatformSettings.devicesPerCallout() * DevicePlatformSettings.calloutsPerJob());
    }

    public Database.QueryLocator start(Database.BatchableContext context) {
        // A device edited in the last few minutes belongs to the job its own
        // trigger started; provisioning it here as well would give it a second
        // certificate.
        Datetime settledBefore = System.now().addMinutes(-DevicePlatformSettings.sweepDelayMinutes());
        return Database.getQueryLocator([
            SELECT Id
            FROM Asset
            WHERE Thing_ARN__c = null
              AND SerialNumber != null
              AND Wi_Fi_Network__c != null
              AND (Provisioning_Status__c = 'Not Provisioned' OR Provisioning_Status__c = null)
              AND LastModifiedDate <= :settledBefore
            ORDER BY CreatedDate
        ]);
    }

    public void execute(Database.BatchableContext context, List<Asset> scope) {
        List<String> assetIds = new List<String>();
        for (Asset device : scope) {
            assetIds.add(String.valueOf(device.Id));
        }
        // Devices this execution had no callout left for, or that AWS was
        // busy for, are not marked at all: they stay Not Provisioned, which is
        // exactly what the next run looks for.
        DeviceProvisioningJob.process(DeviceProvisioningJob.Action.PROVISION, assetIds).save();
    }

    public void finish(Database.BatchableContext context) {
        System.debug(LoggingLevel.INFO, 'DeviceProvisioningBatch finished: ' + context.getJobId());
    }

    public void execute(SchedulableContext context) {
        run();
    }
}
