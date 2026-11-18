/*
 * RoomTemperatureCaseService.cls
 *
 * The temperature alert, Salesforce half. (The class and the flag field keep
 * their first API names, from when the demo watched room air; they are to be
 * renamed later, as renaming a field in Salesforce means deleting it and its
 * data.)
 *
 * A monitored device's sensor can sit anywhere something must not get too
 * warm: against a patient, in a fridge, in a room. In the demo it is a DHT11
 * held under the arm, which reads about 33-36 C there, so the demo alert
 * level is 30 C. A real deployment sets the level for what is monitored and
 * uses a suitable probe. The alert is not a diagnosis: it asks a person to go
 * and check.
 *
 * AWS decides when, Salesforce decides what. AWS patient-vitals sets
 * Room_Temperature_Alert__c on a reading at or above its threshold (30 C by
 * default, config/<env>.json), on the first crossing and then at most once
 * per re-alert interval while the device stays there. So the flag already
 * holds the threshold and the throttle, and this class never compares
 * Temperature__c with a number.
 *
 * For each flagged reading it opens a Case on the device's Asset, owned by
 * the queue Device_Platform_Setting__mdt names, unless a Case from this rule
 * (Origin = Room_Temp_Case_Origin__c) is already open for that Asset. A
 * closed one does not count, which is how a device that reads high again
 * after its Case was closed gets a new one. The Case is all it does: the
 * device's own alarm motor is driven by the board's own reading, and the
 * ward board follows the queue the Case lands in.
 *
 * An Internal Device (DeviceRoles) is a ward board, not a monitored device,
 * so a reading from one, should it have a sensor, opens no Case.
 *
 * Without sharing: the Cases are owned by a queue and the Assets may be
 * invisible to the integration user that inserts the vitals. A dedupe that
 * cannot see the open Case would open a duplicate.
 *
 * It never throws. The vitals must save whatever happens here: a throw would
 * fail the whole 200-record upsert from AWS and send it to the dead-letter
 * queue. A failure is logged, and the next AWS report retries.
 *
 * Bulk shape: up to 3 queries (Assets, open Cases, queue) and 1 DML call
 * whatever the batch size. A batch with no flagged reading costs no query and
 * no DML.
 *
 * Salesforce may run it a second time on the rows that saved (a partial save
 * with allOrNone false). It keeps no static state: the open-Case query is
 * what makes a re-run create nothing.
 */
public without sharing class RoomTemperatureCaseService {

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
            System.debug(LoggingLevel.ERROR, 'Temperature alert skipped this batch: ' + e.getMessage());
        }
    }

    private static void open(Map<String, Patient_Vitals__c> firstByDevice) {
        // Read first, so a blank setting is caught like any other failure.
        String origin = DevicePlatformSettings.roomTempCaseOrigin();
        String queueName = DevicePlatformSettings.roomTempCaseQueue();

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

        List<String> deviceIds = new List<String>(assetByDevice.keySet());
        List<Case> cases = new List<Case>();
        for (String deviceId : deviceIds) {
            Patient_Vitals__c reading = firstByDevice.get(deviceId);
            Case alertCase = new Case(
                AssetId = assetByDevice.get(deviceId).Id,
                Origin = origin,
                Priority = 'High',
                Subject = ('High temperature ' + reading.Temperature__c.setScale(1) + ' C on ' + deviceId).left(255),
                Description = describe(deviceId, reading).left(32000)
            );
            if (queueId != null) {
                alertCase.OwnerId = queueId;
            }
            cases.add(alertCase);
        }

        Database.SaveResult[] caseResults = Database.insert(cases, false);
        for (Integer i = 0; i < caseResults.size(); i++) {
            if (!caseResults[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Temperature alert Case for ' + deviceIds[i]
                    + ' not created: ' + errorsOf(caseResults[i]));
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
            found = [SELECT Id, RecordTypeId, SerialNumber, Thing_ARN__c FROM Asset WHERE SerialNumber IN :keys FOR UPDATE];
        } catch (QueryException e) {
            System.debug(LoggingLevel.WARN, 'Temperature alert could not read the Assets now: ' + e.getMessage());
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
                if (DeviceRoles.isInternal(matches[0])) {
                    // A ward board, not a monitored device: no Case.
                    System.debug(LoggingLevel.INFO, deviceId + ' is an Internal Device, no temperature alert Case');
                    continue;
                }
                byDevice.put(deviceId, matches[0]);
            } else {
                System.debug(LoggingLevel.WARN, 'No Asset for ' + deviceId + ', no temperature alert Case');
            }
        }
        return byDevice;
    }

    private static String describe(String deviceId, Patient_Vitals__c reading) {
        String at = reading.Timestamp__c == null ? 'an unknown time' : reading.Timestamp__c.formatGmt('yyyy-MM-dd HH:mm:ss') + ' UTC';
        return 'Device ' + deviceId + ' reported ' + reading.Temperature__c.setScale(1) + ' C at ' + at
            + ' (reading ' + reading.Device_Reading_Id__c + '), at or above its alert level. '
            + 'Go to what it monitors and check it with a suitable thermometer (SOP-WARD-001). '
            + 'The demo sensor is not a calibrated thermometer, and this alert is not a diagnosis. '
            + 'AWS reports the device again every re-alert interval while it stays high; '
            + 'no new Case opens while this one is open.';
    }

    private static String errorsOf(Database.SaveResult result) {
        List<String> messages = new List<String>();
        for (Database.Error error : result.getErrors()) {
            messages.add(error.getMessage());
        }
        return String.join(messages, ' | ');
    }
}
