/*
 * PatientDeviceService.cls
 *
 * One patient's devices and their latest readings, for the patient portal
 * (PortalDevicesResource) and the patient agent (MyDevicesAgentAction).
 *
 * The scope is the AccountId passed in, which only PortalIdentityService
 * produces, from the signed-in user or the verified chat: a patient's Person
 * Account. Only Patient Device Assets on that account are ever read, and a
 * serial number on another account is "not found", the same answer as one
 * that does not exist, so a patient cannot even learn that it exists.
 *
 * without sharing, and system mode: Patient_Vitals__c rows carry the device
 * serial as text, not a lookup, so no sharing set can give a portal user (or
 * the agent user) the right rows. The account filter is the access rule.
 * What leaves this class is a fixed set of fields, with the free text a
 * person or AWS typed (the device name, its last disconnect reason) masked.
 *
 * Salesforce keeps only the readings someone must act on (state changes and
 * re-alerts), so the newest saved reading can be days old while the board
 * reports every 30 seconds. withLatestFromAws adds the newest reading the
 * board stored in AWS (POST /device-live, mode latest, read only), as the
 * staff agent's readings action does. It needs the caller to hold
 * AWS_IoT_Relay_Callers; without it, or when AWS fails, the saved readings
 * stand and liveNote says why.
 */
public without sharing class PatientDeviceService {

    public static final String PATIENT_DEVICE = 'Patient_Device';

    @TestVisible
    private static final Integer MAX_DEVICES = 10;

    @TestVisible
    private static final Integer MAX_READINGS = 20;

    public class Reading {
        public Datetime at;
        public Decimal temperature;
        public Decimal humidity;
        public Decimal heartRate;
        public Decimal spO2;
        public String patientState;
        public Boolean roomTemperatureAlert;
        /** True for the newest reading stored in AWS, false for a saved one. */
        public Boolean live = false;
    }

    public class Device {
        public Id assetId;
        public String serialNumber;
        public String name;
        public String connectionStatus;
        public Datetime connectionSince;
        public List<Reading> readings = new List<Reading>();
        /** Why there is no newer reading from AWS, when there is none. */
        public String liveNote;
    }

    /** The patient's devices, each with its latest readings, newest first. */
    public static List<Device> devicesFor(Id accountId, Integer readingsEach) {
        return devicesFor(accountId, null, readingsEach);
    }

    /**
     * As above; a serialNumber narrows it to that one device, and returns an
     * empty list when the device is not on this account.
     */
    public static List<Device> devicesFor(Id accountId, String serialNumber, Integer readingsEach) {
        List<Device> devices = new List<Device>();
        if (accountId == null) {
            return devices;
        }
        Integer howMany = clamp(readingsEach);
        String serial = String.isBlank(serialNumber) ? null : serialNumber.trim();
        List<Asset> assets = [
            SELECT Id, Name, SerialNumber, Connection_Status__c, Connection_Since__c
            FROM Asset
            WHERE AccountId = :accountId
              AND RecordType.DeveloperName = :PATIENT_DEVICE
              AND SerialNumber != null
            ORDER BY Name
            LIMIT :MAX_DEVICES
        ];
        for (Asset row : assets) {
            // SOQL matches case-insensitively; a device is its exact serial.
            if (serial != null && row.SerialNumber != serial) {
                continue;
            }
            Device device = new Device();
            device.assetId = row.Id;
            device.serialNumber = row.SerialNumber;
            device.name = PiiMaskingService.mask(row.Name).maskedText;
            device.connectionStatus = row.Connection_Status__c;
            device.connectionSince = row.Connection_Since__c;
            for (Patient_Vitals__c vital : [
                SELECT Timestamp__c, Temperature__c, Humidity__c, Heart_Rate__c, SpO2__c,
                       Patient_State__c, Room_Temperature_Alert__c
                FROM Patient_Vitals__c
                WHERE Device__c = :row.SerialNumber
                ORDER BY Timestamp__c DESC NULLS LAST
                LIMIT :howMany
            ]) {
                Reading reading = new Reading();
                reading.at = vital.Timestamp__c;
                reading.temperature = vital.Temperature__c;
                reading.humidity = vital.Humidity__c;
                reading.heartRate = vital.Heart_Rate__c;
                reading.spO2 = vital.SpO2__c;
                reading.patientState = vital.Patient_State__c;
                reading.roomTemperatureAlert = vital.Room_Temperature_Alert__c == true;
                device.readings.add(reading);
            }
            devices.add(device);
        }
        return devices;
    }

    /**
     * Puts the newest reading the board stored in AWS first in each device's
     * readings when it is newer than the newest saved one. Callouts only: call
     * it before any DML in the transaction. Never throws.
     */
    public static List<Device> withLatestFromAws(List<Device> devices) {
        DeviceApiClient client = null;
        for (Device device : devices) {
            try {
                if (client == null) {
                    client = new DeviceApiClient();
                }
                if (!client.canCall()) {
                    device.liveNote = 'No callout left in this request.';
                    continue;
                }
                addLatest(device, client.post('device-live',
                    new Map<String, Object>{ 'thingName' => device.serialNumber, 'mode' => 'latest' }));
            } catch (Exception e) {
                // Most often the caller lacks access to the AWS credential.
                device.liveNote = 'The newest reading from AWS could not be read: ' + e.getMessage().abbreviate(160);
            }
            System.debug(LoggingLevel.WARN, 'Newest AWS reading for ' + device.serialNumber + ': '
                + (device.liveNote == null ? (device.readings.isEmpty() || !device.readings[0].live ? 'not newer than the saved one' : 'added') : device.liveNote));
        }
        return devices;
    }

    @TestVisible
    private static void addLatest(Device device, DeviceApiClient.Result result) {
        if (!result.succeeded()) {
            device.liveNote = 'The newest reading from AWS is unavailable (HTTP ' + result.statusCode + ').';
            return;
        }
        Map<String, Object> latest = (Map<String, Object>) ((Map<String, Object>) JSON.deserializeUntyped(result.body)).get('latest');
        if (latest == null || latest.get('at') == null) {
            device.liveNote = 'AWS holds no stored reading for this device.';
            return;
        }
        Reading reading = new Reading();
        reading.at = (Datetime) JSON.deserialize('"' + (String) latest.get('at') + '"', Datetime.class);
        Reading newestSaved = device.readings.isEmpty() ? null : device.readings[0];
        if (newestSaved != null && newestSaved.at != null && reading.at <= newestSaved.at) {
            return;
        }
        reading.temperature = decimalOrNull(latest.get('temperature'));
        reading.humidity = decimalOrNull(latest.get('humidity'));
        reading.live = true;
        // A saved reading is written on every alert change, so the newest
        // saved one still says whether the temperature alert is on.
        reading.roomTemperatureAlert = newestSaved != null && newestSaved.roomTemperatureAlert == true;
        reading.patientState = newestSaved == null ? null : newestSaved.patientState;
        if (device.readings.isEmpty()) {
            device.readings.add(reading);
        } else {
            device.readings.add(0, reading);
        }
    }

    private static Decimal decimalOrNull(Object raw) {
        return raw instanceof Decimal || raw instanceof Integer || raw instanceof Double || raw instanceof Long
            ? Decimal.valueOf(String.valueOf(raw)) : null;
    }

    private static Integer clamp(Integer requested) {
        if (requested == null || requested < 1) {
            return 5;
        }
        return Math.min(requested, MAX_READINGS);
    }
}
