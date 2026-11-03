/*
 * WiFiCredentialPushJob.cls
 *
 * Sends a Wi-Fi network's new SSID and passphrase to every provisioned device
 * on it, as a WIFI_UPDATE command on each device's own command topic.
 *
 * The previous @future version queried every device on the network at once
 * and made one callout per device. Past 100 devices the callout limit threw,
 * and past 50,000 the query itself did, and either way no device was told.
 * This job reads the devices a page at a time, in Id order, sends
 * Commands_Per_Callout__c of them per request, and when its callouts run out
 * it starts the next job from the last device it reached. Nothing about the
 * credentials is kept in the job between pages: each page reads them again.
 */
public with sharing class WiFiCredentialPushJob implements Queueable, Database.AllowsCallouts {

    @TestVisible
    private final Set<Id> networkIds;
    // The last device already sent; the next page starts after it.
    @TestVisible
    private final Id afterAssetId;

    @TestVisible
    private static WiFiCredentialPushJob lastChainedJob;
    @TestVisible
    private static Integer devicesSent = 0;

    public WiFiCredentialPushJob(Set<Id> networkIds) {
        this(networkIds, null);
    }

    @TestVisible
    private WiFiCredentialPushJob(Set<Id> networkIds, Id afterAssetId) {
        this.networkIds = networkIds;
        this.afterAssetId = afterAssetId;
    }

    public void execute(QueueableContext context) {
        Map<Id, Wi_Fi_Network__c> networks = new Map<Id, Wi_Fi_Network__c>([
            SELECT Id, SSID__c, Passphrase__c FROM Wi_Fi_Network__c WHERE Id IN :networkIds
        ]);
        Integer perCallout = DevicePlatformSettings.commandsPerCallout();
        Integer pageSize = Math.min(
            perCallout * DevicePlatformSettings.calloutsPerJob(),
            Limits.getLimitQueryRows() - Limits.getQueryRows());
        List<Asset> page = loadPage(pageSize);

        DeviceApiClient api = new DeviceApiClient();
        Id lastReached = afterAssetId;
        Integer index = 0;
        Boolean ranOutOfCallouts = false;

        while (index < page.size()) {
            if (!api.canCall()) {
                ranOutOfCallouts = true;
                break;
            }
            // One request carries devices of one network, in Id order, so
            // "everything up to lastReached was sent" stays true.
            Id networkId = page[index].Wi_Fi_Network__c;
            List<String> thingNames = new List<String>();
            while (index < page.size() && thingNames.size() < perCallout
                   && page[index].Wi_Fi_Network__c == networkId) {
                thingNames.add(page[index].SerialNumber);
                lastReached = page[index].Id;
                index++;
            }
            send(api, networks.get(networkId), thingNames);
        }

        // A full page, or a page cut short, may have more devices after it.
        if (ranOutOfCallouts || page.size() == pageSize) {
            chain(new WiFiCredentialPushJob(networkIds, lastReached));
        }
    }

    // Only provisioned devices can receive an MQTT command. Devices still
    // awaiting provisioning pick the new credentials up in their bundle.
    private List<Asset> loadPage(Integer pageSize) {
        if (afterAssetId == null) {
            return [
                SELECT Id, SerialNumber, Wi_Fi_Network__c FROM Asset
                WHERE Wi_Fi_Network__c IN :networkIds
                  AND Provisioning_Status__c = 'Provisioned'
                  AND SerialNumber != null
                ORDER BY Id
                LIMIT :pageSize
            ];
        }
        return [
            SELECT Id, SerialNumber, Wi_Fi_Network__c FROM Asset
            WHERE Wi_Fi_Network__c IN :networkIds
              AND Provisioning_Status__c = 'Provisioned'
              AND SerialNumber != null
              AND Id > :afterAssetId
            ORDER BY Id
            LIMIT :pageSize
        ];
    }

    private static void send(DeviceApiClient api, Wi_Fi_Network__c network, List<String> thingNames) {
        if (network == null || thingNames.isEmpty()) {
            return;
        }
        DeviceApiClient.Result result = api.post('device-command', new Map<String, Object>{
            'thingNames' => thingNames,
            'operation'  => 'WIFI_UPDATE',
            'ssid'       => network.SSID__c,
            'passphrase' => network.Passphrase__c
        });
        devicesSent += thingNames.size();
        // A device that is offline simply misses the message: it keeps its
        // other saved networks and recovers over serial if it has to, so a
        // failed push is logged, never fatal. The body names which devices
        // failed (HTTP 207); it never carries the passphrase.
        if (!result.succeeded() || result.statusCode == 207) {
            System.debug(LoggingLevel.ERROR, 'Wi-Fi push to ' + thingNames.size()
                + ' device(s) on ' + network.Id + ' was not fully delivered: ' + result.summary());
        }
    }

    private static void chain(WiFiCredentialPushJob next) {
        if (Test.isRunningTest()) {
            lastChainedJob = next;
            return;
        }
        try {
            System.enqueueJob(next);
        } catch (AsyncException e) {
            // Developer Edition and trial orgs stop a chain at five jobs.
            System.debug(LoggingLevel.ERROR, 'Wi-Fi push stopped after device ' + next.afterAssetId
                + ' (' + e.getMessage() + '). Save the network again to send it to the rest.');
        }
    }
}
