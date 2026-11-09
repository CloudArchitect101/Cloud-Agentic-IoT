/*
 * One trigger per object. Routing lives in the handler, logic in the service.
 */
trigger PatientVitalAlertTrigger on Patient_Vital_Alert__e (after insert) {
    new PatientVitalAlertTriggerHandler().run();
}
