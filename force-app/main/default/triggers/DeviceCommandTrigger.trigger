/*
 * One trigger per object. Routing lives in the handler, logic in the service.
 */
trigger DeviceCommandTrigger on Device_Command__c (before insert, after insert) {
    new DeviceCommandTriggerHandler().run();
}
