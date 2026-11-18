/*
 * PatientVitalAlertTriggerHandler.cls
 *
 * Subscribes to Patient_Vital_Alert__e and hands each batch to
 * VitalAlertCaseService. Thin on purpose: an agent or a Flow can subscribe
 * to the same event without this class changing.
 */
public with sharing class PatientVitalAlertTriggerHandler extends TriggerHandler {

    protected override void handleAfterInsert() {
        VitalAlertCaseService.openCasesFor((List<Patient_Vital_Alert__e>) Trigger.new);
    }
}
