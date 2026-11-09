/*
 * VitalAlertCaseService.cls
 *
 * The subscriber to Patient_Vital_Alert__e (chapter 02). StreamingAlertService
 * publishes the event when the alert dispatcher in AWS sends vitals in a
 * band; this class turns each CRITICAL_VITALS alert into a Case for the care
 * team, so an alert from the stream is something a person sees and claims.
 * ABNORMAL_TREND alerts open nothing: a warning band is for the agent to
 * read, not for a queue.
 *
 * One open Case per device: a device whose Case from this rule (Origin
 * Vital Alert) is still open gets no second one, and a closed one does not
 * count. The Case goes on the device's Asset (exactly one Asset with that
 * serial number, compared case-sensitively) and to the queue
 * Escalation_Case_Queue__c names, the same queue as the agent's escalations.
 * An Internal Device opens nothing.
 *
 * It runs as the Automated Process user, without sharing so the dedupe sees
 * every open Case. It never throws: a throw would make the event bus retry
 * the whole batch, and every Case in it would be tried again. A failure is
 * logged.
 *
 * Bulk shape: 3 queries (Assets, open Cases, queue) and 1 DML call whatever
 * the batch size; a batch with no critical alert costs nothing.
 */
public without sharing class VitalAlertCaseService {

    public static final String ORIGIN = 'Vital Alert';
    public static final String CRITICAL = 'CRITICAL_VITALS';

    public static void openCasesFor(List<Patient_Vital_Alert__e> alerts) {
        Map<String, Patient_Vital_Alert__e> firstByDevice = new Map<String, Patient_Vital_Alert__e>();
        for (Patient_Vital_Alert__e alert : alerts == null ? new List<Patient_Vital_Alert__e>() : alerts) {
            if (alert != null && alert.Alert_Type__c == CRITICAL
                    && String.isNotBlank(alert.Patient_Device_Id__c)
                    && !firstByDevice.containsKey(alert.Patient_Device_Id__c)) {
                firstByDevice.put(alert.Patient_Device_Id__c, alert);
            }
        }
        if (firstByDevice.isEmpty()) {
            return;
        }
        try {
            open(firstByDevice);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Vital alert Cases skipped for this batch: ' + e.getMessage());
        }
    }

    private static void open(Map<String, Patient_Vital_Alert__e> firstByDevice) {
        String queueName = DevicePlatformSettings.escalationCaseQueue();

        Map<String, Asset> assetByDevice = assetsFor(firstByDevice.keySet());
        Set<Id> assetIds = new Set<Id>();
        for (Asset device : assetByDevice.values()) {
            assetIds.add(device.Id);
        }
        Set<Id> withOpenCase = new Set<Id>();
        for (Case existing : [
            SELECT AssetId FROM Case WHERE AssetId IN :assetIds AND IsClosed = false AND Origin = :ORIGIN
        ]) {
            withOpenCase.add(existing.AssetId);
        }

        Id queueId = null;
        for (QueueSobject row : [
            SELECT QueueId FROM QueueSobject
            WHERE SobjectType = 'Case' AND Queue.DeveloperName = :queueName LIMIT 1
        ]) {
            queueId = row.QueueId;
        }
        if (queueId == null) {
            System.debug(LoggingLevel.ERROR, 'Queue ' + queueName
                + ' is missing or does not accept Cases; vital alert Case left with the default owner');
        }

        List<Case> cases = new List<Case>();
        List<String> deviceIds = new List<String>();
        for (String deviceId : firstByDevice.keySet()) {
            Asset device = assetByDevice.get(deviceId);
            if (device == null || withOpenCase.contains(device.Id)) {
                continue;
            }
            Patient_Vital_Alert__e alert = firstByDevice.get(deviceId);
            Case alertCase = new Case(
                AssetId = device.Id,
                Origin = ORIGIN,
                Priority = 'High',
                Subject = ('Critical vitals on ' + deviceId).left(255),
                Description = describe(alert).left(32000)
            );
            if (queueId != null) {
                alertCase.OwnerId = queueId;
            }
            cases.add(alertCase);
            deviceIds.add(deviceId);
        }
        if (cases.isEmpty()) {
            return;
        }
        Database.SaveResult[] saves = Database.insert(cases, false);
        for (Integer i = 0; i < saves.size(); i++) {
            if (!saves[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Vital alert Case for ' + deviceIds[i] + ' not created: '
                    + saves[i].getErrors()[0].getMessage());
            }
        }
    }

    /** The one patient Asset of each device; a device with none, or with two, gets no Case. */
    private static Map<String, Asset> assetsFor(Set<String> deviceIds) {
        Map<String, List<Asset>> bySerial = new Map<String, List<Asset>>();
        for (Asset device : [SELECT Id, RecordTypeId, SerialNumber FROM Asset WHERE SerialNumber IN :deviceIds]) {
            if (!deviceIds.contains(device.SerialNumber)) {
                continue;   // the same serial number in another case
            }
            if (!bySerial.containsKey(device.SerialNumber)) {
                bySerial.put(device.SerialNumber, new List<Asset>());
            }
            bySerial.get(device.SerialNumber).add(device);
        }
        Map<String, Asset> result = new Map<String, Asset>();
        for (String deviceId : deviceIds) {
            List<Asset> matches = bySerial.get(deviceId);
            if (matches == null || matches.size() != 1) {
                System.debug(LoggingLevel.WARN, 'No single Asset for ' + deviceId + ', no vital alert Case');
            } else if (DeviceRoles.isInternal(matches[0])) {
                System.debug(LoggingLevel.INFO, deviceId + ' is an Internal Device, no vital alert Case');
            } else {
                result.put(deviceId, matches[0]);
            }
        }
        return result;
    }

    private static String describe(Patient_Vital_Alert__e alert) {
        return (alert.Message__c == null ? 'Critical vitals reported.' : alert.Message__c)
            + ' Risk score: ' + alert.Risk_Score__c + '.'
            + ' Raised from the vitals stream (Patient_Vital_Alert__e). No new Case opens for this device while this one is open.';
    }
}
