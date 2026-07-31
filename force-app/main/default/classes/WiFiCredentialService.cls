/*
 * WiFiCredentialService.cls
 *
 * Pushes changed Wi-Fi credentials to every provisioned device on that network.
 *
 * Notably this does NOT rebuild firmware and does NOT touch the device
 * certificate. Credentials live in their own NVS namespace on the device, so a
 * password change is a message, not a reflash and not a re-provision.
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

        if (!networkIdsWithChangedCredentials.isEmpty() && !System.isFuture()) {
            pushAsync(networkIdsWithChangedCredentials);
        }
    }

    @future(callout=true)
    public static void pushAsync(Set<Id> networkIds) {
        List<Wi_Fi_Network__c> networks = [
            SELECT Id, SSID__c, Passphrase__c FROM Wi_Fi_Network__c WHERE Id IN :networkIds
        ];
        Map<Id, Wi_Fi_Network__c> byId = new Map<Id, Wi_Fi_Network__c>(networks);

        // Only provisioned devices can receive an MQTT command. Devices still
        // awaiting provisioning will pick the new credentials up in their
        // bundle, so pushing to them would fail for no reason.
        List<Asset> devices = [
            SELECT Id, SerialNumber, Wi_Fi_Network__c
            FROM Asset
            WHERE Wi_Fi_Network__c IN :networkIds
              AND Provisioning_Status__c = 'Provisioned'
              AND SerialNumber != null
        ];

        for (Asset device : devices) {
            Wi_Fi_Network__c network = byId.get(device.Wi_Fi_Network__c);
            if (network == null) {
                continue;
            }
            try {
                send(device.SerialNumber, network);
            } catch (Exception e) {
                // A device that is currently offline simply misses the message.
                // It recovers via the serial path in the firmware, so this must
                // not fail the whole batch.
                System.debug(LoggingLevel.ERROR,
                    'Wi-Fi push failed for ' + device.SerialNumber + ': ' + e.getMessage());
            }
        }
    }

    private static void send(String thingName, Wi_Fi_Network__c network) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:AWS_IoT_Relay/device-command');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(15000);
        req.setBody(JSON.serialize(new Map<String, Object>{
            'thingName'  => thingName,
            'operation'  => 'WIFI_UPDATE',
            'ssid'       => network.SSID__c,
            'passphrase' => network.Passphrase__c
        }));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() < 200 || res.getStatusCode() >= 300) {
            throw new CalloutException('HTTP ' + res.getStatusCode() + ': ' + res.getBody());
        }
    }
}
