@IsTest
private class PatientCareAgentActionsTest {

    private static PatientCareAgentActions.EscalationRequest req(String device, String reason, String sev) {
        PatientCareAgentActions.EscalationRequest r = new PatientCareAgentActions.EscalationRequest();
        r.deviceId = device; r.reason = reason; r.severity = sev;
        return r;
    }

    @IsTest
    static void createsCaseAndReturnsCaseNumber() {
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req('ESP32-01', 'Temperature above threshold for 15 minutes', 'HIGH')
            });
        Test.stopTest();

        Assert.isTrue(results[0].success, 'Escalation should succeed');
        Assert.isNotNull(results[0].caseNumber, 'CaseNumber must be read back after insert');

        Case c = [SELECT Priority, Origin, Description FROM Case LIMIT 1];
        Assert.areEqual('High', c.Priority, 'HIGH severity maps to High priority');
        Assert.areEqual('Agentforce', c.Origin, 'Origin identifies agent-created cases for audit');
    }

    @IsTest
    static void rejectsIncompleteRequestWithoutFailingTheBatch() {
        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results =
            PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
                req(null, 'missing device', 'HIGH'),
                req('ESP32-02', 'valid request', 'LOW')
            });
        Test.stopTest();

        Assert.isFalse(results[0].success, 'Invalid row is rejected');
        Assert.isTrue(results[1].success, 'A bad row must not fail its neighbours');
        Assert.areEqual(1, [SELECT COUNT() FROM Case], 'Only the valid row creates a Case');
    }

    @IsTest
    static void severityDefaultsToMediumWhenAbsentOrUnknown() {
        Test.startTest();
        PatientCareAgentActions.escalate(new List<PatientCareAgentActions.EscalationRequest>{
            req('ESP32-03', 'no severity given', null),
            req('ESP32-04', 'nonsense severity', 'BANANA')
        });
        Test.stopTest();

        for (Case c : [SELECT Priority FROM Case]) {
            Assert.areEqual('Medium', c.Priority, 'Unrecognised severity falls back to Medium');
        }
    }

    @IsTest
    static void bulkInvocationStaysWithinLimits() {
        List<PatientCareAgentActions.EscalationRequest> many =
            new List<PatientCareAgentActions.EscalationRequest>();
        for (Integer i = 0; i < 200; i++) {
            many.add(req('ESP32-' + i, 'Bulk escalation ' + i, 'MEDIUM'));
        }

        Test.startTest();
        List<PatientCareAgentActions.EscalationResult> results = PatientCareAgentActions.escalate(many);
        Assert.isTrue(Limits.getDmlStatements() < Limits.getLimitDmlStatements(),
            'Bulk invocation must not approach the DML limit');
        Test.stopTest();

        Assert.areEqual(200, results.size(), 'Every request gets a result');
        Assert.areEqual(200, [SELECT COUNT() FROM Case], 'All 200 cases created');
    }
}
