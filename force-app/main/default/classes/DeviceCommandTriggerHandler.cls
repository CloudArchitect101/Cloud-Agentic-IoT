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

    // Exempt from TriggerHandler's ceiling of five runs a transaction:
    // prepare only reads and send only starts a job, so this handler never
    // re-enters itself, and the ceiling would skip the after insert of a third
    // 200-record chunk, or of a third insert in one transaction, leaving those
    // commands Pending with no job to send them.
    protected override Boolean limitsExecutions() {
        return false;
    }
}
