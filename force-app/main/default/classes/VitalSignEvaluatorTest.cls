@IsTest
private class VitalSignEvaluatorTest {

    private static VitalSignEvaluator.Assessment assess(Map<String, Decimal> reading) {
        DeviceTestSettings.use();
        DeviceTestSettings.useStandardThresholds();
        return VitalSignEvaluator.assess(reading);
    }

    @IsTest
    static void normalVitalsScoreZeroAndAreStable() {
        VitalSignEvaluator.Assessment result = assess(new Map<String, Decimal>{
            'heartRate' => 75, 'spo2' => 98, 'temperature' => 36.8, 'bpSystolic' => 120
        });
        Assert.areEqual(0, result.riskScore, 'Normal vitals add no points');
        Assert.areEqual(VitalSignEvaluator.STABLE, result.patientState, 'Stable');
        Assert.isFalse(result.anyCritical() || result.anyWarning(), 'Nothing flagged');
    }

    @IsTest
    static void criticalBandsAddTheirPointsAndSetTheState() {
        // 30 + 35 + 25 + 20, capped at 100.
        VitalSignEvaluator.Assessment result = assess(new Map<String, Decimal>{
            'heartRate' => 130, 'spo2' => 85, 'temperature' => 39.5, 'bpSystolic' => 170
        });
        Assert.areEqual(100, result.riskScore, 'Capped at Max_Risk_Score__c');
        Assert.areEqual(VitalSignEvaluator.CRITICAL, result.patientState, 'Critical');
        Assert.areEqual(new List<String>{ 'heartRate', 'spo2', 'temperature', 'bpSystolic' }, result.criticalVitals,
            'Listed in Sort_Order__c order');
    }

    @IsTest
    static void aWarningIsNotAlsoCritical() {
        VitalSignEvaluator.Assessment result = assess(new Map<String, Decimal>{ 'heartRate' => 55, 'spo2' => 93 });
        Assert.areEqual(35, result.riskScore, '15 + 20');
        Assert.areEqual(VitalSignEvaluator.STABLE, result.patientState, 'Below the AT_RISK cutoff of 40');
        Assert.areEqual(new List<String>{ 'heartRate', 'spo2' }, result.warningVitals, 'Both are warnings');
        Assert.isFalse(result.anyCritical(), 'Neither is critical');
    }

    @IsTest
    static void aValueOnALimitIsInsideTheBand() {
        VitalSignEvaluator.Assessment result = assess(new Map<String, Decimal>{ 'heartRate' => 120, 'spo2' => 90 });
        Assert.areEqual(new List<String>(), result.criticalVitals, 'Exactly 120 bpm and exactly 90% are not critical');
        Assert.areEqual(new List<String>{ 'heartRate', 'spo2' }, result.warningVitals, 'They are warnings');
    }

    @IsTest
    static void anUnmeasuredVitalScoresNothing() {
        // The patient monitor's DHT11 reports temperature and humidity only.
        VitalSignEvaluator.Assessment result = assess(new Map<String, Decimal>{
            'heartRate' => null, 'spo2' => null, 'temperature' => 36.9
        });
        Assert.areEqual(0, result.riskScore, 'Missing values are not abnormal values');
    }

    @IsTest
    static void bandsComeFromConfigurationNotCode() {
        DeviceTestSettings.use();
        // A clinic that treats 110 bpm as critical, and has switched SpO2 off.
        Vital_Sign_Threshold__mdt spo2 = DeviceTestSettings.band('spo2', 90, null, 95, null, 35, 20, 20);
        spo2.Active__c = false;
        VitalSignEvaluator.testThresholds = new List<Vital_Sign_Threshold__mdt>{
            DeviceTestSettings.band('heartRate', 50, 110, 60, 100, 70, 15, 10), spo2
        };

        VitalSignEvaluator.Assessment result = VitalSignEvaluator.assess(new Map<String, Decimal>{
            'heartRate' => 115, 'spo2' => 80
        });
        Assert.areEqual(70, result.riskScore, 'Only the active heart rate band scores');
        Assert.areEqual(VitalSignEvaluator.CRITICAL, result.patientState, '70 reaches Critical_Score__c');
    }

    @IsTest
    static void theDeployedBandsMatchTheShippedDefaults() {
        // The real records, compared with the values the AWS side uses
        // (config/vital-thresholds.json is compared with these same records
        // by the Node test suite).
        DeviceTestSettings.use();
        VitalSignEvaluator.Assessment result = VitalSignEvaluator.assess(new Map<String, Decimal>{
            'heartRate' => 130, 'spo2' => 85, 'temperature' => 39.5
        });
        Assert.areEqual(90, result.riskScore, 'The deployed Vital_Sign_Threshold__mdt records score 30 + 35 + 25');
    }
}
