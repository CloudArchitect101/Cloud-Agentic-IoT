/*
 * CaseAlertService.cls
 *
 * Keeps a device's motor turning while the device has a Case that waits for
 * the care team: a Case on its Asset (Case.AssetId) that is open and owned
 * by the care team queue. The queue is the one Device_Platform_Setting__mdt
 * names for room-temperature Cases and for escalations (both Care_Team_Queue
 * as shipped). The motor stops once no such Case is left: the last one is
 * closed, deleted, given to a person, or moved to another device.
 *
 * The board is told with a CASE_ALERT Device Command, on or off
 * (Case_Alert_On__c), sent the way every Device Command is: the Device
 * Command trigger starts DeviceCommandSendJob, which calls the device-command
 * Lambda, which publishes on the board's command topic, and the board answers
 * on its ack topic. Asset.Case_Alert_Active__c holds the state last sent, so
 * a command goes only when the state changes: a second open Case, or closing
 * one of two, sends nothing.
 *
 * A patient device only (DeviceRoles): an Internal Device follows the whole
 * queue instead (CaseQueueMonitorService), so its Case alert stays off, and
 * one that was on when the Asset became internal is turned off.
 *
 * Only an Asset with a Thing ARN gets a command: a device that was never
 * provisioned has no board in AWS. Its Case_Alert_Active__c still follows its
 * Cases, so its board is told when it first comes online.
 *
 * A board that is offline misses its command (the send job fails it, or AWS
 * IoT keeps nothing for it). So when DeviceConnectionService marks a board
 * Online, resendAfterReconnect tells it again: on when Case_Alert_Active__c
 * is checked, and off when a CASE_ALERT was sent while it was away. The
 * board keeps the state in its flash too, so a restart alone does not need
 * this.
 *
 * Without sharing: whoever saves the Case, every open Case of the queue and
 * every device must count, or the motor would stop while Cases still wait.
 * The commands are sent as the user who saved the Case, like any Device
 * Command, so that user needs the AWS_IoT_Relay_Callers permission set.
 *
 * It never throws: a Case must save whatever happens here. A failure is
 * logged with System.debug, and the next change to the device's Cases, or
 * its next reconnect, sends the state again.
 *
 * Bulk shape: 3 queries (queue, Assets, open Cases) and 2 DML statements
 * (commands, Assets) whatever the batch size, and nothing at all for a save
 * that cannot change any device's state.
 */
public without sharing class CaseAlertService {

    public static final String CASE_ALERT_COMMAND = 'CASE_ALERT';

    // A command sent shortly before AWS IoT saw a board disconnect can be
    // lost too: the board may already have been gone. So a CASE_ALERT sent
    // up to this many minutes before the disconnect counts as sent while away.
    @TestVisible
    private static final Integer MINUTES_BEFORE_DISCONNECT = 2;

    private static final String ASSET_HANDLER = 'AssetTriggerHandler';

    /* ------------------------------------------------------ Case trigger */

    /** After insert and after undelete. */
    public static void casesAdded(List<Case> cases) {
        Set<Id> assetIds = new Set<Id>();
        for (Case added : cases) {
            if (mayCount(added)) {
                assetIds.add(added.AssetId);
            }
        }
        syncSafely(assetIds);
    }

    /**
     * Counts these devices again, whatever their Cases did: DeviceRoles, when
     * an Asset's record type changes. Never throws.
     */
    public static void refresh(Set<Id> assetIds) {
        syncSafely(assetIds == null ? new Set<Id>() : new Set<Id>(assetIds));
    }

    /** After delete. */
    public static void casesRemoved(List<Case> cases) {
        casesAdded(cases);
    }

    /**
     * After update. Only a change to Status, IsClosed, OwnerId or AssetId can
     * change whether a Case counts, and both the device it was on and the
     * one it is on now may be affected.
     */
    public static void casesChanged(List<Case> cases, Map<Id, Case> oldCases) {
        Set<Id> assetIds = new Set<Id>();
        for (Case updated : cases) {
            Case previous = oldCases == null ? null : oldCases.get(updated.Id);
            if (previous == null) {
                continue;
            }
            Boolean relevant = updated.IsClosed != previous.IsClosed
                || updated.Status != previous.Status
                || updated.OwnerId != previous.OwnerId
                || updated.AssetId != previous.AssetId;
            if (!relevant) {
                continue;
            }
            if (mayCount(updated)) {
                assetIds.add(updated.AssetId);
            }
            if (mayCount(previous)) {
                assetIds.add(previous.AssetId);
            }
        }
        syncSafely(assetIds);
    }

    /**
     * Whether a Case could be one that turns its device's motor: on a device,
     * open, and owned by a queue (a Group). Which queue is checked later, in
     * one query, so a save of Cases that are all closed, on no device or
     * owned by people costs no query at all.
     */
    private static Boolean mayCount(Case record) {
        return record != null
            && record.AssetId != null
            && record.IsClosed != true
            && record.OwnerId != null
            && record.OwnerId.getSobjectType() == Group.SObjectType;
    }

    private static void syncSafely(Set<Id> assetIds) {
        assetIds.remove(null);
        if (assetIds.isEmpty()) {
            return;
        }
        // The Case must save whatever happens here.
        try {
            sync(assetIds);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Case alert not updated for ' + assetIds.size()
                + ' device(s): ' + e.getMessage());
        }
    }

    /**
     * Counts each device's open Cases in the care team queue and, where that
     * turns its motor on or off, sends CASE_ALERT and saves the new state.
     */
    private static void sync(Set<Id> assetIds) {
        Set<String> queueNames = new Set<String>{
            DevicePlatformSettings.roomTempCaseQueue(),
            DevicePlatformSettings.escalationCaseQueue()
        };
        Set<Id> queueIds = new Map<Id, Group>([
            SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName IN :queueNames
        ]).keySet();
        if (queueIds.isEmpty()) {
            System.debug(LoggingLevel.WARN, 'No queue named ' + String.join(new List<String>(queueNames), ' or ')
                + ', so no Case counts and every motor is stopped');
        }

        // Locked first, then counted: two saves that close the last two Cases
        // of one device at once then count one after the other, and the
        // second sees the first's Case closed.
        List<Asset> devices = [
            SELECT Id, RecordTypeId, Thing_ARN__c, Case_Alert_Active__c
            FROM Asset
            WHERE Id IN :assetIds
            FOR UPDATE
        ];

        Set<Id> alerting = new Set<Id>();
        if (!queueIds.isEmpty()) {
            for (AggregateResult row : [
                SELECT AssetId assetId
                FROM Case
                WHERE AssetId IN :assetIds AND IsClosed = false AND OwnerId IN :queueIds
                GROUP BY AssetId
            ]) {
                alerting.add((Id) row.get('assetId'));
            }
        }

        List<Asset> changed = new List<Asset>();
        for (Asset device : devices) {
            // An internal board follows the whole queue, not its own Cases.
            Boolean alert = alerting.contains(device.Id) && !DeviceRoles.isInternal(device);
            if (alert != (device.Case_Alert_Active__c == true)) {
                device.Case_Alert_Active__c = alert;
                changed.add(device);
            }
        }
        if (changed.isEmpty()) {
            return;
        }

        // The commands first: should saving the state fail, the next change
        // sends it again, which the board takes as a repeat.
        Map<String, Boolean> alertByThingName = new Map<String, Boolean>();
        for (Asset device : changed) {
            String thingName = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
            if (thingName != null && !alertByThingName.containsKey(thingName)) {
                alertByThingName.put(thingName, device.Case_Alert_Active__c);
            }
        }
        sendCommands(alertByThingName);
        saveStates(changed);
    }

    /* ---------------------------------------------------------- reconnect */

    /**
     * DeviceConnectionService, once it has saved these Assets Online. Each
     * board is told its state again when it may have missed it: on when its
     * Asset's Case_Alert_Active__c is checked, and off when a CASE_ALERT was
     * created for it since it went offline (offlineSinceById, for the Assets
     * that showed Offline before). One query and one insert for the batch.
     * Never throws: the connection must save whatever happens here.
     */
    public static void resendAfterReconnect(List<Asset> onlineDevices, Map<Id, Datetime> offlineSinceById) {
        if (onlineDevices == null || onlineDevices.isEmpty()) {
            return;
        }
        try {
            resend(onlineDevices, offlineSinceById == null ? new Map<Id, Datetime>() : offlineSinceById);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Case alert not sent again after reconnect: ' + e.getMessage());
        }
    }

    private static void resend(List<Asset> onlineDevices, Map<Id, Datetime> offlineSinceById) {
        Map<String, Boolean> alertByThingName = new Map<String, Boolean>();
        // From when a CASE_ALERT counts as sent while the board was away.
        Map<String, Datetime> awayFromByThingName = new Map<String, Datetime>();
        Datetime earliest = null;
        for (Asset device : onlineDevices) {
            String thingName = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
            if (thingName == null) {
                continue;
            }
            if (device.Case_Alert_Active__c == true) {
                alertByThingName.put(thingName, true);
                continue;
            }
            Datetime offlineSince = offlineSinceById.get(device.Id);
            if (offlineSince == null) {
                continue;
            }
            Datetime awayFrom = offlineSince.addMinutes(-MINUTES_BEFORE_DISCONNECT);
            Datetime known = awayFromByThingName.get(thingName);
            if (known == null || awayFrom < known) {
                awayFromByThingName.put(thingName, awayFrom);
            }
            if (earliest == null || awayFrom < earliest) {
                earliest = awayFrom;
            }
        }

        for (String thingName : alertByThingName.keySet()) {
            awayFromByThingName.remove(thingName);
        }
        if (!awayFromByThingName.isEmpty()) {
            Set<String> thingNames = awayFromByThingName.keySet();
            for (Device_Command__c sent : [
                SELECT Device__c, CreatedDate
                FROM Device_Command__c
                WHERE Command__c = :CASE_ALERT_COMMAND
                  AND Device__c IN :thingNames
                  AND CreatedDate >= :earliest
            ]) {
                // SOQL matched the name regardless of case; the Map does not,
                // and Thing names are case-sensitive.
                Datetime awayFrom = awayFromByThingName.get(sent.Device__c);
                if (awayFrom != null && sent.CreatedDate >= awayFrom) {
                    alertByThingName.put(sent.Device__c, false);
                }
            }
        }
        sendCommands(alertByThingName);
    }

    /* ------------------------------------------------------------- shared */

    /**
     * One CASE_ALERT per board. Device ID is the Thing name and Asset__c is
     * left empty: DeviceCommandService.prepare links the Asset when it can,
     * and a command that names a board is sent whether or not the user who
     * saved the Case can see its Asset.
     */
    private static void sendCommands(Map<String, Boolean> alertByThingName) {
        if (alertByThingName.isEmpty()) {
            return;
        }
        List<Device_Command__c> commands = new List<Device_Command__c>();
        for (String thingName : alertByThingName.keySet()) {
            commands.add(new Device_Command__c(
                Device__c        = thingName,
                Command__c       = CASE_ALERT_COMMAND,
                Case_Alert_On__c = alertByThingName.get(thingName)
            ));
        }
        Database.SaveResult[] results = Database.insert(commands, false);
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'CASE_ALERT ' + (commands[i].Case_Alert_On__c ? 'on' : 'off')
                    + ' for ' + commands[i].Device__c + ' not created: ' + results[i].getErrors()[0].getMessage());
            }
        }
    }

    /**
     * Saves Case_Alert_Active__c alone, with the Asset trigger bypassed: the
     * state has nothing to do with provisioning.
     */
    private static void saveStates(List<Asset> devices) {
        List<Asset> rows = new List<Asset>();
        for (Asset device : devices) {
            rows.add(new Asset(Id = device.Id, Case_Alert_Active__c = device.Case_Alert_Active__c));
        }
        // A caller, or the Integration_Control__c setting, may have bypassed
        // the handler already; that is left as it was found.
        Boolean bypassHere = !TriggerHandler.isBypassed(ASSET_HANDLER);
        if (bypassHere) {
            TriggerHandler.bypass(ASSET_HANDLER);
        }
        Database.SaveResult[] results;
        try {
            results = Database.update(rows, false);
        } finally {
            if (bypassHere) {
                TriggerHandler.clearBypass(ASSET_HANDLER);
            }
        }
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Case alert state of Asset ' + rows[i].Id + ' not saved: '
                    + results[i].getErrors()[0].getMessage());
            }
        }
    }
}
