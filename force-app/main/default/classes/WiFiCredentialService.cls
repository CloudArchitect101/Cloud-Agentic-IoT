/*
 * WiFiCredentialService.cls
 *
 * Pushes changed Wi-Fi credentials to every provisioned device on that network.
 *
 * Notably this does NOT rebuild firmware and does NOT touch the device
 * certificate. Credentials live in their own NVS namespace on the device, so a
 * password change is a message, not a reflash and not a re-provision.
 *
 * The push itself runs in WiFiCredentialPushJob, which pages through the
 * devices on the network and sends them in batches, so a network shared by a
 * million devices works the same as one shared by three.
 *
 * Demonstrates: workflow automation from business records, secure
 * credential handling, async integration.
 */
public with sharing class WiFiCredentialService {

    /**
     * Pushes credentials to devices when a network's SSID or passphrase
     * changes. The change detection lives here, not in the trigger, so it can
     * be unit tested by passing plain lists.
     *
     * Note: the running user needs "View Encrypted Data" for Passphrase__c to
     * be readable. Without it both old and new values read as asterisks and no
     * change is ever detected - the push silently never happens.
     */
    public static void pushChangedCredentialsToDevices(
        List<Wi_Fi_Network__c> networkRecords,
        Map<Id, Wi_Fi_Network__c> networkRecordsBeforeUpdate
    ) {
        Set<Id> networkIdsWithChangedCredentials = new Set<Id>();

        for (Wi_Fi_Network__c network : networkRecords) {
            Wi_Fi_Network__c networkBeforeUpdate = networkRecordsBeforeUpdate.get(network.Id);
            Boolean credentialsChanged =
                   networkBeforeUpdate.SSID__c       != network.SSID__c
                || networkBeforeUpdate.Passphrase__c != network.Passphrase__c;
            if (credentialsChanged) {
                networkIdsWithChangedCredentials.add(network.Id);
            }
        }

        if (networkIdsWithChangedCredentials.isEmpty()) {
            return;
        }
        if (Limits.getQueueableJobs() >= Limits.getLimitQueueableJobs()) {
            System.debug(LoggingLevel.ERROR, 'No background job left in this transaction to push Wi-Fi credentials for '
                + networkIdsWithChangedCredentials);
            return;
        }
        System.enqueueJob(new WiFiCredentialPushJob(networkIdsWithChangedCredentials));
    }
}
