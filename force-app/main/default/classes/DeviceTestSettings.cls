/*
 * DeviceTestSettings.cls
 *
 * Known configuration for tests, so a test asserts against values it can see
 * rather than whatever the org's custom metadata happens to hold today.
 * Custom metadata records cannot be inserted in a test, but they can be built
 * in memory and handed to the class that reads them.
 */
@IsTest
public class DeviceTestSettings {

    /** The values the Default record ships with. */
    public static Device_Platform_Setting__mdt standard() {
        return new Device_Platform_Setting__mdt(
            Named_Credential__c         = 'AWS_IoT_Relay',
            Callout_Timeout_Seconds__c  = 25,
            Bundle_TTL_Minutes__c       = 15,
            Default_Thing_Group__c      = 'fleet-patient-monitor',
            Devices_Per_Callout__c      = 10,
            Commands_Per_Callout__c     = 200,
            Callouts_Per_Job__c         = 50,
            Max_Callout_Attempts__c     = 3,
            Retry_Delay_Minutes__c      = 1,
            Sweep_Delay_Minutes__c      = 15,
            At_Risk_Score__c            = 40,
            Critical_Score__c           = 70,
            Max_Risk_Score__c           = 100,
            Escalation_Case_Origin__c   = 'Agentforce',
            Escalation_Case_Queue__c    = 'Care_Team_Queue',
            Room_Temp_Case_Origin__c    = 'Room Temperature Rule',
            Room_Temp_Case_Queue__c     = 'Care_Team_Queue',
            Room_Temp_Dispense__c       = true,
            Room_Temp_Dispense_Cooldown_Minutes__c = 60
        );
    }

    /** Uses the standard values for the rest of this test, and returns them for changing. */
    public static Device_Platform_Setting__mdt use() {
        Device_Platform_Setting__mdt settings = standard();
        DevicePlatformSettings.testOverride = settings;
        return settings;
    }

    /** The four bands the records ship with. */
    public static List<Vital_Sign_Threshold__mdt> standardThresholds() {
        return new List<Vital_Sign_Threshold__mdt>{
            band('heartRate',   50,   120,  60,   100,  30, 15, 10),
            band('spo2',        90,   null, 95,   null, 35, 20, 20),
            band('temperature', 35.0, 39.0, 36.5, 38.5, 25, 15, 30),
            band('bpSystolic',  null, 160,  null, 140,  20, 10, 40)
        };
    }

    public static void useStandardThresholds() {
        VitalSignEvaluator.testThresholds = standardThresholds();
    }

    public static Vital_Sign_Threshold__mdt band(
        String payloadField, Decimal criticalBelow, Decimal criticalAbove,
        Decimal warningBelow, Decimal warningAbove,
        Decimal criticalPoints, Decimal warningPoints, Decimal sortOrder
    ) {
        return new Vital_Sign_Threshold__mdt(
            Payload_Field__c   = payloadField,
            Critical_Below__c  = criticalBelow,
            Critical_Above__c  = criticalAbove,
            Warning_Below__c   = warningBelow,
            Warning_Above__c   = warningAbove,
            Critical_Points__c = criticalPoints,
            Warning_Points__c  = warningPoints,
            Sort_Order__c      = sortOrder,
            Active__c          = true
        );
    }
}
