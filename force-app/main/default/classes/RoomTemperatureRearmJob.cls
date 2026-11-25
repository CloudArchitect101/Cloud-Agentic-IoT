/*
 * RoomTemperatureRearmJob.cls
 *
 * The temperature alert's re-arm. AWS reports a device to Salesforce once
 * when it reaches the alert level, and while it stays there only every
 * RoomTempRealertMinutes (12 hours by default), because the open Case
 * already says it is hot. So when that Case closes, Salesforce tells AWS:
 * one callout per device to POST /device-live { thingName, mode: 'rearm' }.
 * AWS then takes the device's next hot reading as a new crossing, and
 * RoomTemperatureCaseService opens a new Case from it, as before the change.
 *
 * Why: re-reporting a hot device every 15 minutes cost one Patient_Vitals__c
 * record and part of a Salesforce API call each time, about 96 a day for a
 * device worn all day. A callout from Salesforce costs no API request and
 * stores nothing (docs/SCALING.md, "Salesforce API calls per device").
 *
 * CaseTriggerHandler starts it for Cases of the rule's origin
 * (Device_Platform_Setting__mdt.Room_Temp_Case_Origin__c) that close. It
 * runs as the user who closed them, with that user's access to the
 * AWS_IoT_Relay external credential, as the live card does. A re-arm that
 * fails is logged and not retried: the 12-hour repeat still reports a device
 * that stays hot, so nothing is lost, only delayed.
 */
public with sharing class RoomTemperatureRearmJob implements Queueable, Database.AllowsCallouts {

    @TestVisible
    private final List<String> thingNames;

    @TestVisible
    private static RoomTemperatureRearmJob lastChainedJob;

    public RoomTemperatureRearmJob(List<String> thingNames) {
        this.thingNames = thingNames == null ? new List<String>() : thingNames;
    }

    /**
     * Starts a job for the rule's Cases that this save closed. Never throws:
     * closing a Case must work whatever AWS or the settings say.
     */
    public static void startFor(List<Case> cases, Map<Id, Case> before) {
        try {
            List<String> thingNames = thingNamesToRearm(cases, before);
            if (!thingNames.isEmpty()) {
                System.enqueueJob(new RoomTemperatureRearmJob(thingNames));
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Temperature alert re-arm not started: ' + e.getMessage());
        }
    }

    /** The Thing names (Asset serial numbers) of the devices whose rule Case just closed. */
    @TestVisible
    private static List<String> thingNamesToRearm(List<Case> cases, Map<Id, Case> before) {
        Set<Id> assetIds = new Set<Id>();
        Set<Id> candidates = new Set<Id>();
        for (Case updated : cases == null ? new List<Case>() : cases) {
            Case old = before == null ? null : before.get(updated.Id);
            if (updated.AssetId != null && (old == null || old.IsClosed != true)) {
                candidates.add(updated.Id);
            }
        }
        if (candidates.isEmpty()) {
            return new List<String>();
        }
        // IsClosed comes from the Status's own setting: read it as saved.
        String origin = DevicePlatformSettings.roomTempCaseOrigin();
        for (Case saved : [SELECT AssetId FROM Case WHERE Id IN :candidates AND IsClosed = true AND Origin = :origin]) {
            assetIds.add(saved.AssetId);
        }
        List<String> thingNames = new List<String>();
        if (assetIds.isEmpty()) {
            return thingNames;
        }
        // System mode, as the Case service reads them: the closer may not see the Asset.
        for (Asset device : [SELECT SerialNumber FROM Asset WHERE Id IN :assetIds AND SerialNumber != null]) {
            thingNames.add(device.SerialNumber);
        }
        thingNames.sort();
        return thingNames;
    }

    public void execute(QueueableContext context) {
        DeviceApiClient client = new DeviceApiClient();
        List<String> notReached = new List<String>();
        for (String thingName : thingNames) {
            if (!client.canCall()) {
                notReached.add(thingName);
                continue;
            }
            DeviceApiClient.Result result = client.post('device-live',
                new Map<String, Object>{ 'thingName' => thingName, 'mode' => 'rearm' });
            if (!result.succeeded()) {
                System.debug(LoggingLevel.ERROR, 'Temperature alert re-arm failed for ' + thingName
                    + '; its 12-hour repeat still reports it: ' + result.summary());
            }
        }
        if (!notReached.isEmpty()) {
            chain(new RoomTemperatureRearmJob(notReached));
        }
    }

    private static void chain(RoomTemperatureRearmJob next) {
        if (Test.isRunningTest()) {
            lastChainedJob = next;
            return;
        }
        try {
            System.enqueueJob(next);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Temperature alert re-arm of ' + next.thingNames.size()
                + ' devices not started: ' + e.getMessage());
        }
    }
}
