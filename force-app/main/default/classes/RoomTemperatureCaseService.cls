/*
 * RoomTemperatureCaseService.cls
 *
 * The room-temperature demo rule, Salesforce half. Not a clinical alert: the
 * patient monitor's DHT11 measures room air.
 *
 * AWS decides when, Salesforce decides what. AWS patient-vitals sets
 * Room_Temperature_Alert__c on a reading at or above its threshold (30 C by
 * default, config/<env>.json), on the first crossing and then at most once
 * per re-alert interval while the device stays there. So the flag already
 * holds the threshold and the throttle. This class never compares
 * Temperature__c with a number: that field also carries body temperature,
 * and every clinical reading is above 30 C.
 *
 * For each flagged reading it opens a Case on the device's Asset, owned by
 * the queue Device_Platform_Setting__mdt names, unless a Case from this rule
 * (Origin = Room_Temp_Case_Origin__c) is already open for that Asset. A
 * closed one does not count, which is how a device that is hot again after
 * its Case was closed gets a new one. Each new Case also requests one
 * DISPENSE_MEDICATION Device Command, when Room_Temp_Dispense__c is on and
 * no rule dose went to the device within the cooldown.
 *
 * Without sharing: the Cases are owned by a queue and the Assets may be
 * invisible to the integration user that inserts the vitals. A dedupe that
 * cannot see the open Case would open a duplicate.
 *
 * It never throws. The vitals must save whatever happens here: a throw would
 * fail the whole 200-record upsert from AWS and send it to the dead-letter
 * queue. A failure is logged, and the next AWS report retries.
 *
 * Bulk shape: up to 4 queries (Assets, open Cases, queue, dose cooldown) and
 * 2 DML calls (Cases, commands) whatever the batch size. A batch with no
 * flagged reading costs no query and no DML.
 *
 * Salesforce may run it a second time on the rows that saved (a partial save
 * with allOrNone false). It keeps no static state: the open-Case query is
 * what makes a re-run create nothing.
 *
 * A dose that fails after its Case exists is not retried automatically: the
 * next report finds the open Case and stops, and an automatic retry would
 * itself be a dose nobody asked for. The failure is logged with the Case Id,
 * and the Case Description tells the nurse how to check and send it by hand.
 */
public without sharing class RoomTemperatureCaseService {

    public static final String DISPENSE_COMMAND = 'DISPENSE_MEDICATION';

    @TestVisible
    private static final String DOSE_REQUESTED = 'requested. If no DISPENSE_MEDICATION Device Command for this device '
        + 'appears within a minute, the request failed: send it from the Asset.';
    @TestVisible
    private static final String DOSE_COOLDOWN = 'not requested, a dose was requested for this device in the last {0} minutes.';
    @TestVisible
    private static final String DOSE_OFF = 'not requested, automatic dosing is switched off.';

    public static void openCasesFor(List<Patient_Vitals__c> readings) {
        // Within-batch dedupe, with no query and nothing that can throw: the
        // first flagged reading of each device wins.
        Map<String, Patient_Vitals__c> firstByDevice = new Map<String, Patient_Vitals__c>();
        for (Patient_Vitals__c reading : readings == null ? new List<Patient_Vitals__c>() : readings) {
            if (reading != null && reading.Room_Temperature_Alert__c == true
                    && String.isNotBlank(reading.Device__c) && reading.Temperature__c != null
                    && !firstByDevice.containsKey(reading.Device__c)) {
                firstByDevice.put(reading.Device__c, reading);
            }
        }
        if (firstByDevice.isEmpty()) {
            return;
        }

        // The vitals must save whatever happens here; the next AWS report retries.
        try {
            open(firstByDevice);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Room-temperature rule skipped this batch: ' + e.getMessage());
        }
    }

    private static void open(Map<String, Patient_Vitals__c> firstByDevice) {
        // Read first, so a blank setting is caught like any other failure.
        String origin = DevicePlatformSettings.roomTempCaseOrigin();
        String queueName = DevicePlatformSettings.roomTempCaseQueue();
        Boolean dispense = DevicePlatformSettings.roomTempDispense();
        Integer cooldownMinutes = dispense ? DevicePlatformSettings.roomTempDispenseCooldownMinutes() : null;

        Map<String, Asset> assetByDevice = assetsFor(firstByDevice.keySet());
        if (assetByDevice == null) {
            return;
        }

        // Closed Cases are ignored on purpose: a closed one leads to a new one.
        Set<Id> assetIds = new Set<Id>();
        for (Asset device : assetByDevice.values()) {
            assetIds.add(device.Id);
        }
        Set<Id> assetsWithOpenCase = new Set<Id>();
        for (Case existing : [
            SELECT AssetId FROM Case
            WHERE AssetId IN :assetIds AND IsClosed = false AND Origin = :origin
        ]) {
            assetsWithOpenCase.add(existing.AssetId);
        }
        for (String deviceId : new List<String>(assetByDevice.keySet())) {
            if (assetsWithOpenCase.contains(assetByDevice.get(deviceId).Id)) {
                assetByDevice.remove(deviceId);
            }
        }
        if (assetByDevice.isEmpty()) {
            return;
        }

        Id queueId = null;
        for (QueueSobject row : [
            SELECT QueueId FROM QueueSobject
            WHERE SobjectType = 'Case' AND Queue.DeveloperName = :queueName
            LIMIT 1
        ]) {
            queueId = row.QueueId;
        }
        if (queueId == null) {
            System.debug(LoggingLevel.ERROR, 'Queue ' + queueName
                + ' is missing or does not accept Cases; Case left with the default owner');
        }

        Set<String> dosedRecently = new Set<String>();
        if (dispense) {
            Datetime since = System.now().addMinutes(-cooldownMinutes);
            Set<String> devices = assetByDevice.keySet();
            for (Device_Command__c recent : [
                SELECT Device__c FROM Device_Command__c
                WHERE Device__c IN :devices AND Command__c = :DISPENSE_COMMAND
                  AND Requested_By__c = :origin AND CreatedDate >= :since
            ]) {
                dosedRecently.add(recent.Device__c);
            }
        }

        List<String> deviceIds = new List<String>(assetByDevice.keySet());
        List<Case> cases = new List<Case>();
        List<Boolean> doses = new List<Boolean>();
        for (String deviceId : deviceIds) {
            Patient_Vitals__c reading = firstByDevice.get(deviceId);
            Boolean dose = dispense && !dosedRecently.contains(deviceId);
            String doseText = dose ? DOSE_REQUESTED
                : dispense ? String.format(DOSE_COOLDOWN, new List<Object>{ String.valueOf(cooldownMinutes) })
                : DOSE_OFF;
            Case roomCase = new Case(
                AssetId = assetByDevice.get(deviceId).Id,
                Origin = origin,
                Priority = 'High',
                Subject = ('Room temperature ' + reading.Temperature__c.setScale(1) + ' C on ' + deviceId).left(255),
                Description = describe(deviceId, reading, doseText).left(32000)
            );
            if (queueId != null) {
                roomCase.OwnerId = queueId;
            }
            cases.add(roomCase);
            doses.add(dose);
        }

        List<Device_Command__c> commands = new List<Device_Command__c>();
        List<Id> commandCaseIds = new List<Id>();
        Database.SaveResult[] caseResults = Database.insert(cases, false);
        for (Integer i = 0; i < caseResults.size(); i++) {
            if (!caseResults[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Room-temperature Case for ' + deviceIds[i]
                    + ' not created: ' + errorsOf(caseResults[i]));
                continue;
            }
            if (doses[i]) {
                // Asset__c is left empty: DeviceCommandService.prepare links
                // it, and Status__c takes its default, Pending.
                commands.add(new Device_Command__c(
                    Device__c = deviceIds[i], Command__c = DISPENSE_COMMAND, Requested_By__c = origin
                ));
                commandCaseIds.add(caseResults[i].getId());
            }
        }
        if (commands.isEmpty()) {
            return;
        }
        Database.SaveResult[] commandResults = Database.insert(commands, false);
        for (Integer i = 0; i < commandResults.size(); i++) {
            if (!commandResults[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Room-temperature dose for ' + commands[i].Device__c
                    + ' (Case ' + commandCaseIds[i] + ') not requested and not retried: ' + errorsOf(commandResults[i]));
            }
        }
    }

    /**
     * The one Asset of each device, locked so two syncs of the same device
     * cannot both open a Case. Matched as DeviceCommandService.prepare does:
     * exactly one Asset with that serial number, compared case-sensitively,
     * whose Thing is the device. Null when the Assets cannot be read now.
     */
    private static Map<String, Asset> assetsFor(Set<String> keys) {
        List<Asset> found;
        try {
            found = [SELECT Id, SerialNumber, Thing_ARN__c FROM Asset WHERE SerialNumber IN :keys FOR UPDATE];
        } catch (QueryException e) {
            System.debug(LoggingLevel.WARN, 'Room-temperature rule could not read the Assets now: ' + e.getMessage());
            return null;
        }
        Map<String, List<Asset>> bySerialNumber = new Map<String, List<Asset>>();
        for (Asset device : found) {
            if (String.isBlank(device.SerialNumber) || !keys.contains(device.SerialNumber)) {
                continue;   // the same serial number in another case
            }
            if (!bySerialNumber.containsKey(device.SerialNumber)) {
                bySerialNumber.put(device.SerialNumber, new List<Asset>());
            }
            bySerialNumber.get(device.SerialNumber).add(device);
        }
        Map<String, Asset> byDevice = new Map<String, Asset>();
        for (String deviceId : keys) {
            List<Asset> matches = bySerialNumber.get(deviceId);
            if (matches != null && matches.size() == 1
                    && deviceId.equals(DeviceProvisioningService.thingNameIn(matches[0].Thing_ARN__c))) {
                byDevice.put(deviceId, matches[0]);
            } else {
                System.debug(LoggingLevel.WARN, 'No Asset for ' + deviceId + ', no room-temperature Case');
            }
        }
        return byDevice;
    }

    private static String describe(String deviceId, Patient_Vitals__c reading, String doseText) {
        String at = reading.Timestamp__c == null ? 'an unknown time' : reading.Timestamp__c.formatGmt('yyyy-MM-dd HH:mm:ss') + ' UTC';
        return 'Device ' + deviceId + ' reported ' + reading.Temperature__c.setScale(1) + ' C at ' + at
            + ' (reading ' + reading.Device_Reading_Id__c + '). '
            + 'This is the room-temperature demo rule: the sensor measures room air, not the patient. '
            + 'It is not a clinical alert. AWS reports the device again every re-alert interval while it stays hot; '
            + 'no new Case opens while this one is open. Dose: ' + doseText;
    }

    private static String errorsOf(Database.SaveResult result) {
        List<String> messages = new List<String>();
        for (Database.Error error : result.getErrors()) {
            messages.add(error.getMessage());
        }
        return String.join(messages, ' | ');
    }
}
