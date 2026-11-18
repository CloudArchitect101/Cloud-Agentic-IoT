/*
 * VitalSignEvaluator.cls
 *
 * Scores a set of vital signs against the clinical bands in
 * Vital_Sign_Threshold__mdt and the state cutoffs in Device_Platform_Setting__mdt.
 * DataIngestionService and StreamingAlertService both use it, so the two can
 * no longer disagree about what "critical" means, and a clinician's change to
 * a band is a metadata edit, not a code change.
 *
 * The AWS side scores readings with the same numbers, kept in
 * config/vital-thresholds.json; test/config/thresholds-match.test.js fails the
 * checks when the two differ.
 */
public with sharing class VitalSignEvaluator {

    public static final String CRITICAL = 'CRITICAL';
    public static final String AT_RISK  = 'AT_RISK';
    public static final String STABLE   = 'STABLE';

    public class Assessment {
        public Integer riskScore = 0;
        public String patientState = STABLE;
        /** Payload fields (heartRate, spo2, ...) whose value is in the critical band, in Sort_Order__c order. */
        public List<String> criticalVitals = new List<String>();
        /** Payload fields whose value is in the warning band, and not critical. */
        public List<String> warningVitals = new List<String>();

        public Boolean anyCritical() { return !criticalVitals.isEmpty(); }
        public Boolean anyWarning()  { return !warningVitals.isEmpty(); }
    }

    /** Tests set this to score against known bands instead of the deployed records. */
    @TestVisible
    private static List<Vital_Sign_Threshold__mdt> testThresholds;

    private static List<Vital_Sign_Threshold__mdt> cachedThresholds;

    /**
     * @param valueByPayloadField the reading, keyed the way the device sends it
     *        (heartRate, spo2, temperature, bpSystolic). A vital that was not
     *        measured is absent or null and scores nothing; a measured zero is
     *        a reading like any other.
     */
    public static Assessment assess(Map<String, Decimal> valueByPayloadField) {
        Device_Platform_Setting__mdt settings = DevicePlatformSettings.get();
        Assessment result = new Assessment();
        Decimal score = 0;

        for (Vital_Sign_Threshold__mdt band : thresholds()) {
            Decimal value = valueByPayloadField.get(band.Payload_Field__c);
            if (value == null) {
                continue;
            }
            if (isOutside(value, band.Critical_Below__c, band.Critical_Above__c)) {
                score += band.Critical_Points__c;
                result.criticalVitals.add(band.Payload_Field__c);
            } else if (isOutside(value, band.Warning_Below__c, band.Warning_Above__c)) {
                score += band.Warning_Points__c;
                result.warningVitals.add(band.Payload_Field__c);
            }
        }

        result.riskScore = Math.min(score, settings.Max_Risk_Score__c).intValue();
        if (result.riskScore >= settings.Critical_Score__c) {
            result.patientState = CRITICAL;
        } else if (result.riskScore >= settings.At_Risk_Score__c) {
            result.patientState = AT_RISK;
        }
        return result;
    }

    /** Strictly outside: a value equal to a limit is inside the band. A blank limit is no limit. */
    @TestVisible
    private static Boolean isOutside(Decimal value, Decimal below, Decimal above) {
        return (below != null && value < below) || (above != null && value > above);
    }

    /** The active bands, in Sort_Order__c order. */
    public static List<Vital_Sign_Threshold__mdt> thresholds() {
        if (testThresholds != null) {
            return sortAndFilter(testThresholds);
        }
        if (cachedThresholds == null) {
            cachedThresholds = sortAndFilter(Vital_Sign_Threshold__mdt.getAll().values());
        }
        return cachedThresholds;
    }

    private static List<Vital_Sign_Threshold__mdt> sortAndFilter(List<Vital_Sign_Threshold__mdt> source) {
        List<OrderedBand> ordered = new List<OrderedBand>();
        for (Vital_Sign_Threshold__mdt band : source) {
            if (band.Active__c == true && String.isNotBlank(band.Payload_Field__c)) {
                ordered.add(new OrderedBand(band));
            }
        }
        ordered.sort();
        List<Vital_Sign_Threshold__mdt> result = new List<Vital_Sign_Threshold__mdt>();
        for (OrderedBand entry : ordered) {
            result.add(entry.band);
        }
        return result;
    }

    private class OrderedBand implements Comparable {
        private final Vital_Sign_Threshold__mdt band;

        OrderedBand(Vital_Sign_Threshold__mdt band) {
            this.band = band;
        }

        public Integer compareTo(Object other) {
            Decimal mine = band.Sort_Order__c == null ? 0 : band.Sort_Order__c;
            Vital_Sign_Threshold__mdt theirBand = ((OrderedBand) other).band;
            Decimal theirs = theirBand.Sort_Order__c == null ? 0 : theirBand.Sort_Order__c;
            if (mine == theirs) {
                return 0;
            }
            return mine < theirs ? -1 : 1;
        }
    }
}
