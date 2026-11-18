/*
 * One trigger per object. All context routing lives in the handler, all logic
 * in the service - see TriggerHandler for why.
 */
trigger PatientVitalsTrigger on Patient_Vitals__c (after insert) {
    new PatientVitalsTriggerHandler().run();
}
