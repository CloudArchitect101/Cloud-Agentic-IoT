/*
 * PatientPortalSettings.cls
 *
 * Reads Patient_Portal_Setting__mdt.Default: how the patient portal's React
 * chat proves who the patient is to Messaging for In-App and Web, and where a
 * patient's nurse request goes. Environments differ in this record only.
 */
public with sharing class PatientPortalSettings {

    public static final String RECORD_NAME = 'Default';

    /** Tests set this to run against known values instead of the deployed record. */
    @TestVisible
    private static Patient_Portal_Setting__mdt testOverride;

    private static Patient_Portal_Setting__mdt cached;

    public class SettingException extends Exception {}

    public static Patient_Portal_Setting__mdt get() {
        if (testOverride != null) {
            return testOverride;
        }
        if (cached == null) {
            cached = Patient_Portal_Setting__mdt.getInstance(RECORD_NAME);
        }
        if (cached == null) {
            throw new SettingException(
                'Custom metadata record Patient_Portal_Setting__mdt.' + RECORD_NAME + ' is missing. '
                + 'It ships in force-app/main/default/customMetadata; deploy it.');
        }
        return cached;
    }

    /**
     * The Messaging API host. Blank in the record means the org's own:
     * https://<my domain>.my.salesforce.com becomes
     * https://<my domain>.my.salesforce-scrt.com, the host Messaging for
     * In-App and Web serves its REST API and event stream from.
     */
    public static String scrtUrl() {
        String configured = get().Scrt_Url__c;
        if (String.isNotBlank(configured)) {
            return configured.removeEnd('/');
        }
        return scrtUrlFor(URL.getOrgDomainUrl().toExternalForm());
    }

    @TestVisible
    private static String scrtUrlFor(String orgDomainUrl) {
        return orgDomainUrl.removeEnd('/').replace('.my.salesforce.com', '.my.salesforce-scrt.com');
    }

    public static Integer tokenMinutes() {
        Decimal minutes = get().Token_Minutes__c;
        if (minutes == null || minutes < 1) {
            return 5;
        }
        return Math.min(minutes.intValue(), 60);
    }
}
