/*
 * One trigger per object. All context routing lives in the handler, all logic
 * in the service - see TriggerHandler for why.
 */
trigger CaseTrigger on Case (after insert, after update, after delete, after undelete) {
    new CaseTriggerHandler().run();
}
