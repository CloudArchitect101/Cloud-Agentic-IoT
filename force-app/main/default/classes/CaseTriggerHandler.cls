/*
 * CaseTriggerHandler.cls
 *
 * Routes Case trigger contexts to the queue monitoring service, which moves
 * the queue indicator, and to CaseAlertService, which turns a device's motor
 * on while it has an open Case in the care team queue. Contains no
 * business logic of its own: its whole job is to translate trigger context
 * (Trigger.new, Trigger.old) into a plain collection the service can act on,
 * because a service that takes plain collections can be unit tested without
 * performing any DML.
 */
public with sharing class CaseTriggerHandler extends TriggerHandler {

    protected override void handleAfterInsert() {
        CaseQueueMonitorService.refreshQueueDepthFor(collectOwnerIdsFrom(Trigger.new));
        CaseAlertService.casesAdded((List<Case>) Trigger.new);
    }

    protected override void handleAfterUpdate() {
        // A case moving between queues changes depth on BOTH sides, so the
        // owners before and after the change are equally relevant.
        Set<Id> affectedOwnerIds = collectOwnerIdsFrom(Trigger.new);
        affectedOwnerIds.addAll(collectOwnerIdsFrom(Trigger.old));
        CaseQueueMonitorService.refreshQueueDepthFor(affectedOwnerIds);
        CaseAlertService.casesChanged((List<Case>) Trigger.new, (Map<Id, Case>) Trigger.oldMap);
    }

    protected override void handleAfterDelete() {
        CaseQueueMonitorService.refreshQueueDepthFor(collectOwnerIdsFrom(Trigger.old));
        CaseAlertService.casesRemoved((List<Case>) Trigger.old);
    }

    protected override void handleAfterUndelete() {
        CaseQueueMonitorService.refreshQueueDepthFor(collectOwnerIdsFrom(Trigger.new));
        CaseAlertService.casesAdded((List<Case>) Trigger.new);
    }

    // Exempt from TriggerHandler's ceiling of five runs a transaction:
    // neither service writes to Case, so this handler never re-enters
    // itself, and the ceiling would skip the third 200-record chunk of a
    // large save, leaving a motor turning for Cases that were all closed.
    // Both services count again from the database on every run, so a second
    // run in one transaction publishes the same depth again and sends no
    // second CASE_ALERT.
    protected override Boolean limitsExecutions() {
        return false;
    }

    /**
     * Trigger.new and Trigger.old are List<SObject> in this context, so the
     * cast is explicit. Returning a Set removes the duplicates that arise
     * when many cases share one queue.
     */
    private Set<Id> collectOwnerIdsFrom(List<SObject> caseRecords) {
        Set<Id> ownerIds = new Set<Id>();
        for (SObject record : caseRecords) {
            Id ownerId = (Id) record.get('OwnerId');
            if (ownerId != null) {
                ownerIds.add(ownerId);
            }
        }
        return ownerIds;
    }
}
