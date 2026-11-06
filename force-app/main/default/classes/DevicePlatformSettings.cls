/*
 * DevicePlatformSettings.cls
 *
 * The one place Apex reads how it talks to the AWS device platform: the Named
 * Credential, timeouts, batch sizes, retry limits and the risk score bands,
 * the Origin and queue of the Cases the Patient Care agent creates,
 * and how the room-temperature demo rule opens its Cases: their Origin, the
 * queue that owns them, and whether (and how often) one also requests a dose.
 * Whether the rule runs at all is decided in AWS (RoomTempAlert in
 * config/<env>.json), not here.
 * Values live in the Device_Platform_Setting__mdt record named Default, so an
 * admin changes them in Setup (or in force-app/main/default/customMetadata)
 * without touching code.
 *
 * A missing record or a nonsensical value fails loudly with the field's name,
 * rather than falling back to a number nobody can see.
 */
public with sharing class DevicePlatformSettings {

    public static final String RECORD_NAME = 'Default';

    /** Tests set this to run against known values instead of the deployed record. */
    @TestVisible
    private static Device_Platform_Setting__mdt testOverride;

    private static Device_Platform_Setting__mdt cached;

    public class SettingException extends Exception {}

    public static Device_Platform_Setting__mdt get() {
        if (testOverride != null) {
            return testOverride;
        }
        if (cached == null) {
            cached = Device_Platform_Setting__mdt.getInstance(RECORD_NAME);
        }
        if (cached == null) {
            throw new SettingException(
                'Custom metadata record Device_Platform_Setting__mdt.' + RECORD_NAME + ' is missing. '
                + 'It ships in force-app/main/default/customMetadata; deploy it.');
        }
        return cached;
    }

    /** callout:<Named Credential>/<path> */
    public static String endpoint(String path) {
        String credential = get().Named_Credential__c;
        if (String.isBlank(credential)) {
            throw new SettingException('Device_Platform_Setting__mdt.Named_Credential__c is blank.');
        }
        return 'callout:' + credential + '/' + path;
    }

    public static Integer calloutTimeoutMillis() {
        return atLeastOne(get().Callout_Timeout_Seconds__c, 'Callout_Timeout_Seconds__c') * 1000;
    }

    public static Integer bundleTtlMinutes() {
        return atLeastOne(get().Bundle_TTL_Minutes__c, 'Bundle_TTL_Minutes__c');
    }

    public static Integer devicesPerCallout() {
        return atLeastOne(get().Devices_Per_Callout__c, 'Devices_Per_Callout__c');
    }

    public static Integer commandsPerCallout() {
        return atLeastOne(get().Commands_Per_Callout__c, 'Commands_Per_Callout__c');
    }

    public static Integer calloutsPerJob() {
        return atLeastOne(get().Callouts_Per_Job__c, 'Callouts_Per_Job__c');
    }

    public static Integer maxCalloutAttempts() {
        return atLeastOne(get().Max_Callout_Attempts__c, 'Max_Callout_Attempts__c');
    }

    /** Minutes a job waits before retrying devices AWS was busy for. Salesforce allows 0 to 10. */
    public static Integer retryDelayMinutes() {
        Decimal value = get().Retry_Delay_Minutes__c;
        if (value == null || value < 0 || value > 10) {
            throw new SettingException('Device_Platform_Setting__mdt.Retry_Delay_Minutes__c must be 0 to 10, not ' + value + '.');
        }
        return value.intValue();
    }

    /** How long DeviceProvisioningBatch leaves a just-edited device to the job its trigger started. */
    public static Integer sweepDelayMinutes() {
        Decimal value = get().Sweep_Delay_Minutes__c;
        if (value == null || value < 0) {
            throw new SettingException('Device_Platform_Setting__mdt.Sweep_Delay_Minutes__c must be 0 or more, not ' + value + '.');
        }
        return value.intValue();
    }

    public static String defaultThingGroup() {
        return required(get().Default_Thing_Group__c, 'Default_Thing_Group__c');
    }

    public static String escalationCaseOrigin() {
        return required(get().Escalation_Case_Origin__c, 'Escalation_Case_Origin__c');
    }

    /** DeveloperName of the queue that owns the Cases the Patient Care agent creates. */
    public static String escalationCaseQueue() {
        return required(get().Escalation_Case_Queue__c, 'Escalation_Case_Queue__c');
    }

    /** Origin on room-temperature Cases; also how the rule recognises its own Cases. */
    public static String roomTempCaseOrigin() {
        return required(get().Room_Temp_Case_Origin__c, 'Room_Temp_Case_Origin__c');
    }

    /** DeveloperName of the queue that owns them. */
    public static String roomTempCaseQueue() {
        return required(get().Room_Temp_Case_Queue__c, 'Room_Temp_Case_Queue__c');
    }

    /** Whether each new room-temperature Case also requests one DISPENSE_MEDICATION command. */
    public static Boolean roomTempDispense() {
        return get().Room_Temp_Dispense__c == true;
    }

    /** No second room-temperature dose for a device within this many minutes. */
    public static Integer roomTempDispenseCooldownMinutes() {
        return atLeastOne(get().Room_Temp_Dispense_Cooldown_Minutes__c, 'Room_Temp_Dispense_Cooldown_Minutes__c');
    }

    private static Integer atLeastOne(Decimal value, String fieldName) {
        if (value == null || value < 1) {
            throw new SettingException('Device_Platform_Setting__mdt.' + fieldName + ' must be 1 or more, not ' + value + '.');
        }
        return value.intValue();
    }

    private static String required(String value, String fieldName) {
        if (String.isBlank(value)) {
            throw new SettingException('Device_Platform_Setting__mdt.' + fieldName + ' is blank.');
        }
        return value;
    }
}
