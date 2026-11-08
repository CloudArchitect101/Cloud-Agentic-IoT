/*
 * DeviceReadingsAgentAction.cls
 *
 * The Patient Care agent's read action: what a patient monitoring device has
 * reported lately, and whether it is connected. The topic tells the agent to
 * answer only from retrieved readings, so without this action every answer
 * would be "I have no data".
 *
 * A device is named by its serial number (Asset.SerialNumber), which is also
 * its AWS IoT Thing name and the Device__c on each Patient_Vitals__c row.
 *
 * Read-only, and it reads as the person talking to the agent: "with sharing"
 * and WITH USER_MODE, so the agent sees exactly the Assets, readings and
 * fields that person may see. An unreadable field fails the query rather
 * than coming back empty, and the agent is told so instead of guessing.
 * No patient name is returned: the device is the subject, not the person.
 *
 * Its own class because Apex allows one @InvocableMethod per class.
 */
public with sharing class DeviceReadingsAgentAction {

    /** How many readings come back when the agent does not say. */
    @TestVisible
    private static final Integer DEFAULT_READINGS = 5;

    /** The most it may ask for: enough for a trend, small enough to read. */
    @TestVisible
    private static final Integer MAX_READINGS = 20;

    /** Each device costs one query for its readings, so one call reads at most this many. */
    @TestVisible
    private static final Integer MAX_DEVICES_PER_CALL = 20;

    public class ReadingsRequest {
        @InvocableVariable(required=true label='Device ID'
            description='The device serial number (Asset.SerialNumber), the same as its AWS IoT Thing name.')
        public String deviceId;

        @InvocableVariable(label='Number of Readings'
            description='How many of the latest readings to return, newest first. 5 if empty, at most 20.')
        public Integer readingCount;
    }

    public class ReadingsResult {
        @InvocableVariable(label='Success') public Boolean success;
        @InvocableVariable(label='Message') public String message;
        @InvocableVariable(label='Device ID') public String deviceId;
        @InvocableVariable(label='Device Name') public String deviceName;
        @InvocableVariable(label='Connection Status') public String connectionStatus;
        @InvocableVariable(label='Connection Since') public Datetime connectionSince;
        @InvocableVariable(label='Last Disconnect Reason') public String lastDisconnectReason;
        @InvocableVariable(label='Last Telemetry At') public Datetime lastTelemetryAt;
        @InvocableVariable(label='Readings Returned') public Integer readingsReturned;
        @InvocableVariable(label='Latest Reading At') public Datetime latestReadingAt;
        @InvocableVariable(label='Latest Heart Rate') public Decimal latestHeartRate;
        @InvocableVariable(label='Latest SpO2') public Decimal latestSpO2;
        @InvocableVariable(label='Latest Temperature') public Decimal latestTemperature;
        @InvocableVariable(label='Latest Patient State') public String latestPatientState;
        @InvocableVariable(label='Latest Risk Score') public Decimal latestRiskScore;
        @InvocableVariable(label='Readings'
            description='One line per reading, newest first. A value that was not measured says not measured.')
        public String readings;
    }

    @InvocableMethod(
        label='Get Latest Device Readings'
        description='Returns the latest vital-sign readings a patient monitoring device reported, and whether the device is connected.'
        category='Patient Care')
    public static List<ReadingsResult> getLatestReadings(List<ReadingsRequest> requests) {
        List<ReadingsResult> results = new List<ReadingsResult>();
        Set<String> wanted = new Set<String>();
        for (ReadingsRequest req : requests == null ? new List<ReadingsRequest>() : requests) {
            ReadingsResult res = new ReadingsResult();
            res.success = false;
            results.add(res);
            if (req == null || String.isBlank(req.deviceId)) {
                res.message = 'A device ID (the device serial number) is required.';
                continue;
            }
            res.deviceId = req.deviceId.trim();
            if (wanted.size() >= MAX_DEVICES_PER_CALL && !wanted.contains(res.deviceId)) {
                res.message = 'Too many devices in one request; ask for at most ' + MAX_DEVICES_PER_CALL + '.';
                res.deviceId = null;
                continue;
            }
            wanted.add(res.deviceId);
        }
        if (wanted.isEmpty()) {
            return results;
        }

        Map<String, List<Asset>> devicesBySerial;
        try {
            devicesBySerial = assetsBySerial(wanted);
        } catch (QueryException e) {
            // Most often a field the user may not read: say so, do not guess.
            return failAll(results, 'The device record could not be read with your access: ' + e.getMessage());
        }

        for (Integer i = 0; i < results.size(); i++) {
            ReadingsResult res = results[i];
            if (res.deviceId == null) {
                continue;
            }
            List<Asset> matches = devicesBySerial.get(res.deviceId);
            if (matches == null || matches.isEmpty()) {
                res.message = 'No device with serial number ' + res.deviceId + ' that you have access to.';
                continue;
            }
            if (matches.size() > 1) {
                res.message = matches.size() + ' devices share serial number ' + res.deviceId
                    + '; the readings cannot be tied to one of them. Ask an admin to fix the duplicate.';
                continue;
            }
            Asset device = matches[0];
            res.deviceName = device.Name;
            res.connectionStatus = device.Connection_Status__c;
            res.connectionSince = device.Connection_Since__c;
            res.lastDisconnectReason = device.Last_Disconnect_Reason__c;
            res.lastTelemetryAt = device.Last_Telemetry_At__c;

            List<Patient_Vitals__c> latest;
            try {
                latest = latestReadings(res.deviceId, clamp(requests[i].readingCount));
            } catch (QueryException e) {
                res.message = 'The readings could not be read with your access: ' + e.getMessage();
                continue;
            }
            describe(res, latest);
        }
        return results;
    }

    /** Matched case-sensitively, as DeviceCommandService.prepare matches a device. */
    private static Map<String, List<Asset>> assetsBySerial(Set<String> serials) {
        Map<String, List<Asset>> bySerial = new Map<String, List<Asset>>();
        for (Asset device : [
            SELECT Id, Name, SerialNumber, Connection_Status__c, Connection_Since__c,
                   Last_Disconnect_Reason__c, Last_Telemetry_At__c
            FROM Asset
            WHERE SerialNumber IN :serials
            WITH USER_MODE
        ]) {
            if (!serials.contains(device.SerialNumber)) {
                continue;   // the same serial number in another case
            }
            if (!bySerial.containsKey(device.SerialNumber)) {
                bySerial.put(device.SerialNumber, new List<Asset>());
            }
            bySerial.get(device.SerialNumber).add(device);
        }
        return bySerial;
    }

    private static List<Patient_Vitals__c> latestReadings(String deviceId, Integer howMany) {
        return [
            SELECT Timestamp__c, Heart_Rate__c, SpO2__c, Temperature__c, BP_Systolic__c, BP_Diastolic__c,
                   Humidity__c, Patient_State__c, Risk_Score__c, Room_Temperature_Alert__c
            FROM Patient_Vitals__c
            WHERE Device__c = :deviceId
            WITH USER_MODE
            ORDER BY Timestamp__c DESC NULLS LAST
            LIMIT :howMany
        ];
    }

    private static void describe(ReadingsResult res, List<Patient_Vitals__c> latest) {
        res.success = true;
        res.readingsReturned = latest.size();
        if (latest.isEmpty()) {
            res.message = 'Device ' + res.deviceId + ' has no readings you have access to.';
            res.readings = '';
            return;
        }
        Patient_Vitals__c newest = latest[0];
        res.latestReadingAt = newest.Timestamp__c;
        res.latestHeartRate = newest.Heart_Rate__c;
        res.latestSpO2 = newest.SpO2__c;
        res.latestTemperature = newest.Temperature__c;
        res.latestPatientState = newest.Patient_State__c;
        res.latestRiskScore = newest.Risk_Score__c;
        // Nothing writes Asset.Last_Telemetry_At__c yet, so fall back to the
        // newest reading: a null here made the device look silent.
        if (res.lastTelemetryAt == null) {
            res.lastTelemetryAt = newest.Timestamp__c;
        }

        List<String> lines = new List<String>();
        for (Patient_Vitals__c reading : latest) {
            lines.add(line(reading));
        }
        res.readings = String.join(lines, '\n');
        res.message = latest.size() + ' latest reading' + (latest.size() == 1 ? '' : 's')
            + ' for device ' + res.deviceId + ', newest first.';
    }

    private static String line(Patient_Vitals__c reading) {
        String at = reading.Timestamp__c == null ? 'unknown time' : reading.Timestamp__c.formatGmt('yyyy-MM-dd HH:mm:ss') + ' UTC';
        String bp = reading.BP_Systolic__c == null && reading.BP_Diastolic__c == null ? 'not measured'
            : value(reading.BP_Systolic__c) + '/' + value(reading.BP_Diastolic__c) + ' mmHg';
        return at
            + ': heart rate ' + value(reading.Heart_Rate__c, ' bpm')
            + ', SpO2 ' + value(reading.SpO2__c, ' %')
            + ', temperature ' + value(reading.Temperature__c, ' C')
            + ', blood pressure ' + bp
            + ', humidity ' + value(reading.Humidity__c, ' %')
            + ', state ' + (String.isBlank(reading.Patient_State__c) ? 'not reported' : reading.Patient_State__c)
            + ', risk score ' + value(reading.Risk_Score__c, '')
            + (reading.Room_Temperature_Alert__c == true ? ', room-temperature flag set' : '');
    }

    private static String value(Decimal measured, String unit) {
        return measured == null ? 'not measured' : measured.toPlainString() + unit;
    }

    private static String value(Decimal measured) {
        return measured == null ? '?' : measured.toPlainString();
    }

    private static Integer clamp(Integer requested) {
        if (requested == null || requested < 1) {
            return DEFAULT_READINGS;
        }
        return Math.min(requested, MAX_READINGS);
    }

    private static List<ReadingsResult> failAll(List<ReadingsResult> results, String message) {
        for (ReadingsResult res : results) {
            if (res.deviceId != null) {
                res.message = message;
            }
        }
        return results;
    }
}
