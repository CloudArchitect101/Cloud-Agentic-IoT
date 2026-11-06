/*
 * DeviceCommandTriggerHandler.cls
 *
 * Routes Device Command inserts to DeviceCommandService: before insert makes
 * each command ready to send, after insert sends it. A command has to be
 * saved before it is sent, because its record Id is what the board answers
 * with.
 */
public with sharing class DeviceCommandTriggerHandler extends TriggerHandler {

    protected override void handleBeforeInsert() {
        DeviceCommandService.prepare((List<Device_Command__c>) Trigger.new);
    }

    protected override void handleAfterInsert() {
        DeviceCommandService.send((List<Device_Command__c>) Trigger.new);
    }
}
