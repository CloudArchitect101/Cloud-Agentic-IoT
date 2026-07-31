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
 * Demonstrates: API integration, secure credential handling, async Apex,
 * workflow automation driven from the CRM.
 */
public with sharing class DeviceProvisioningService {

    private static final Integer BUNDLE_TTL_MINUTES = 15;

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

        if (!assetIdsToProvision.isEmpty() && !System.isFuture()) {
            provisionAsync(assetIdsToProvision);
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
        if (!thingNamesToTearDown.isEmpty() && !System.isFuture()) {
            teardownAsync(thingNamesToTearDown);
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

    public class ProvisioningException extends Exception {}

    /**
     * Entry point for the Asset trigger. Runs async because it makes a callout,
     * and because a device registry write must not fail if AWS is briefly down.
     */
    @future(callout=true)
    public static void provisionAsync(Set<Id> assetIds) {
        List<Asset> assets = [
            SELECT Id, Name, SerialNumber, Thing_Group__c,
                   Wi_Fi_Network__c, Wi_Fi_Network__r.SSID__c, Wi_Fi_Network__r.Passphrase__c
            FROM Asset
            WHERE Id IN :assetIds
        ];

        List<Asset> updates = new List<Asset>();
        for (Asset device : assets) {
            Asset result = new Asset(Id = device.Id);
            try {
                Map<String, Object> response = callProvisioningApi(device);
                result.Thing_ARN__c                = (String) response.get('thingArn');
                result.Certificate_Id__c           = (String) response.get('certificateId');
                result.Provisioning_Bundle_URL__c  = (String) response.get('bundleUrl');
                result.Provisioning_Expires_At__c  = System.now().addMinutes(BUNDLE_TTL_MINUTES);
                result.Provisioning_Status__c      = 'Provisioned';
            } catch (Exception e) {
                result.Provisioning_Status__c = 'Failed';
                System.debug(LoggingLevel.ERROR,
                    'Provisioning failed for ' + device.SerialNumber + ': ' + e.getMessage());
            }
            updates.add(result);
        }

        if (!updates.isEmpty()) {
            update updates;
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
        reprovisionAsync(new Set<Id>(assetIds));
    }

    @future(callout=true)
    public static void reprovisionAsync(Set<Id> assetIds) {
        List<Asset> assets = [
            SELECT Id, SerialNumber, Wi_Fi_Network__r.SSID__c, Wi_Fi_Network__r.Passphrase__c
            FROM Asset WHERE Id IN :assetIds
        ];
        List<Asset> updates = new List<Asset>();

        for (Asset device : assets) {
            Asset result = new Asset(Id = device.Id);
            try {
                HttpRequest req = new HttpRequest();
                req.setEndpoint('callout:AWS_IoT_Relay/reprovision-device');
                req.setMethod('POST');
                req.setHeader('Content-Type', 'application/json');
                req.setTimeout(20000);
                req.setBody(JSON.serialize(new Map<String, Object>{
                    'thingName'  => device.SerialNumber,
                    'ssid'       => device.Wi_Fi_Network__r.SSID__c,
                    'passphrase' => device.Wi_Fi_Network__r.Passphrase__c,
                    'ttlMinutes' => BUNDLE_TTL_MINUTES
                }));
                HttpResponse res = new Http().send(req);
                if (res.getStatusCode() < 200 || res.getStatusCode() >= 300) {
                    throw new ProvisioningException('HTTP ' + res.getStatusCode() + ': ' + res.getBody());
                }
                Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                result.Certificate_Id__c          = (String) body.get('certificateId');
                result.Provisioning_Bundle_URL__c = (String) body.get('bundleUrl');
                result.Provisioning_Expires_At__c = System.now().addMinutes(BUNDLE_TTL_MINUTES);
                result.Provisioning_Status__c     = 'Provisioned';
            } catch (Exception e) {
                result.Provisioning_Status__c = 'Failed';
                System.debug(LoggingLevel.ERROR,
                    'Re-provisioning failed for ' + device.SerialNumber + ': ' + e.getMessage());
            }
            updates.add(result);
        }
        if (!updates.isEmpty()) {
            update updates;
        }
    }

    /**
     * Deletes a device's AWS IoT footprint so the name can be reused.
     *
     * Takes Thing names rather than record Ids on purpose: by the time this
     * runs the Asset records are gone, so nothing could be queried. @future
     * only accepts primitives, which makes this the natural shape anyway.
     *
     * Telemetry history is intentionally left alone - it is keyed on the device
     * name and is usually needed for audit long after the hardware is retired.
     */
    @future(callout=true)
    public static void teardownAsync(Set<String> thingNames) {
        if (thingNames == null || thingNames.isEmpty()) {
            return;
        }
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:AWS_IoT_Relay/teardown-device');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setTimeout(30000);
            req.setBody(JSON.serialize(new Map<String, Object>{
                'thingNames' => new List<String>(thingNames)
            }));

            HttpResponse res = new Http().send(req);
            // 207 means some succeeded and some did not; the body names which.
            if (res.getStatusCode() >= 300 && res.getStatusCode() != 207) {
                throw new ProvisioningException('HTTP ' + res.getStatusCode() + ': ' + res.getBody());
            }
            System.debug(LoggingLevel.INFO, 'Teardown result: ' + res.getBody());
        } catch (Exception e) {
            // The record is already deleted, so there is nothing left to mark
            // as failed. Log loudly: an orphaned Thing silently blocks that
            // serial number from ever being registered again.
            System.debug(LoggingLevel.ERROR,
                'AWS teardown FAILED for ' + String.join(new List<String>(thingNames), ', ')
                + ' - these Things may block re-registration: ' + e.getMessage());
        }
    }

    private static Map<String, Object> callProvisioningApi(Asset device) {
        if (String.isBlank(device.SerialNumber)) {
            throw new ProvisioningException('SerialNumber is required - it becomes the IoT Thing name.');
        }
        if (device.Wi_Fi_Network__c == null) {
            throw new ProvisioningException('A Wi-Fi Network must be set before provisioning.');
        }

        Map<String, Object> body = new Map<String, Object>{
            'thingName'  => device.SerialNumber,
            'thingGroup' => String.isBlank(device.Thing_Group__c) ? 'patient-monitors' : device.Thing_Group__c,
            'ssid'       => device.Wi_Fi_Network__r.SSID__c,
            'passphrase' => device.Wi_Fi_Network__r.Passphrase__c,
            'ttlMinutes' => BUNDLE_TTL_MINUTES
        };

        HttpRequest req = new HttpRequest();
        // Named Credential (AWS SigV4) - no keys or endpoints in Apex.
        req.setEndpoint('callout:AWS_IoT_Relay/provision-device');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(20000);
        req.setBody(JSON.serialize(body));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() < 200 || res.getStatusCode() >= 300) {
            throw new ProvisioningException('AWS returned HTTP ' + res.getStatusCode() + ': ' + res.getBody());
        }
        return (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
    }
}
