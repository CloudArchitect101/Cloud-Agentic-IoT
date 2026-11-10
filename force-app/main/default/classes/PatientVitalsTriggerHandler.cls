/*
 * PatientVitalsTriggerHandler.cls
 *
 * Routes Patient_Vitals__c inserts to RoomTemperatureCaseService, which opens
 * a Case for readings AWS flagged as patient temperature alerts. Unflagged readings, which is nearly all of them, cost nothing.
 *
 * Emergency stop without a deploy: add PatientVitalsTriggerHandler to
 * Integration_Control__c.Bypass_Handlers__c.
 */
public with sharing class PatientVitalsTriggerHandler extends TriggerHandler {

    protected override void handleAfterInsert() {
        RoomTemperatureCaseService.openCasesFor((List<Patient_Vitals__c>) Trigger.new);
    }

    // Exempt from TriggerHandler's ceiling of five runs a transaction: this
    // handler inserts Cases and Device Commands, never vitals, so it cannot
    // re-enter itself, and the ceiling would silently skip the after insert
    // of a later 200-record chunk of one sync.
    protected override Boolean limitsExecutions() {
        return false;
    }
}
