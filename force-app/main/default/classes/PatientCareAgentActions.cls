/*
 * PatientCareAgentActions.cls
 *
 * Custom Agent Actions an Agentforce agent can invoke. Each @InvocableMethod
 * is a tool the agent may call; the agent decides *whether* to call it, this
 * class decides *what is allowed to happen* when it does.
 *
 * The split matters: an LLM choosing to escalate is a suggestion, not an
 * authorisation. Validation, sharing enforcement, and the audit trail live
 * here, in Apex, where they cannot be prompted away.
 *
 * Demonstrates: API development, OAuth 2.0 via Named Credential, workflow
 * automation, agents taking meaningful autonomous action.
 */
// "with sharing" = this class only sees records the running user is allowed
// to see, like row-level security enforced by the ORM. Without these two words
// the agent would read every patient in the org - a classic audit finding.
public with sharing class PatientCareAgentActions {

    // Inner classes as typed payloads: the closest Apex has to a Pydantic
    // model. @InvocableVariable marks a field as part of the action's schema -
    // Agentforce shows the label to the model deciding what to pass.
    public class EscalationRequest {
        @InvocableVariable(required=true label='Device ID')
        public String deviceId;

        @InvocableVariable(required=true label='Reason')
        public String reason;

        @InvocableVariable(label='Severity' description='LOW, MEDIUM or HIGH')
        public String severity;
    }

    public class EscalationResult {
        @InvocableVariable public Boolean success;
        @InvocableVariable public String caseNumber;
        @InvocableVariable public String message;
    }

    /**
     * Escalates a device condition to the care team by creating a Case.
     *
     * Bulk-safe because Agentforce may invoke an action once per record in a
     * batch; a per-invocation DML would blow the governor limit on the third
     * patient.
     */
    // @InvocableMethod registers this as a callable tool - think "FastAPI
    // endpoint with a schema", except the caller is an AI agent or a Flow.
    // Signature is List-in/List-out by contract: the platform batches calls.
    @InvocableMethod(
        label='Escalate Device Condition'
        description='Creates a care team Case for a device condition the agent judged significant.'
        category='Patient Care')
    public static List<EscalationResult> escalate(List<EscalationRequest> requests) {
        List<EscalationResult> results = new List<EscalationResult>();
        List<Case> toInsert = new List<Case>();
        List<Integer> indexOfCase = new List<Integer>();
        // Device_Platform_Setting__mdt, so the Case Origin a support team
        // reports on is theirs to choose.
        String origin = DevicePlatformSettings.escalationCaseOrigin();
        // The queue the care team works from, also a setting. A Case the
        // running user owns never reaches the queue, so the queue indicator
        // would never move for an escalation.
        Id queueId = escalationQueueId(DevicePlatformSettings.escalationCaseQueue());
        // The device's Asset, so the Case shows on it and counts as that
        // device's open Case (the case alert counts by AssetId).
        Map<String, Id> assetBySerial = assetsBySerial(requests);

        for (Integer i = 0; i < requests.size(); i++) {
            EscalationRequest req = requests[i];
            EscalationResult res = new EscalationResult();
            results.add(res);

            if (String.isBlank(req.deviceId) || String.isBlank(req.reason)) {
                res.success = false;
                res.message = 'deviceId and reason are both required.';
                continue;
            }

            Case escalation = new Case(
                Subject     = 'Device escalation: ' + req.deviceId,
                Description = req.reason,
                Priority    = normalisePriority(req.severity),
                Origin      = origin
            );
            if (queueId != null) {
                escalation.OwnerId = queueId;
            }
            escalation.AssetId = assetBySerial.get(req.deviceId.trim());
            toInsert.add(escalation);
            indexOfCase.add(i);
        }

        if (toInsert.isEmpty()) {
            return results;
        }

        // ONE insert for the whole batch. Governor limits count DML
        // *statements* (150/transaction), not rows - the Python instinct of
        // insert-per-loop-iteration dies at record 151 here. Collect, then act.
        // allOrNone=false: one invalid row must not fail the whole agent batch.
        List<Database.SaveResult> saves = Database.insert(toInsert, false);

        Set<Id> insertedIds = new Set<Id>();
        for (Integer j = 0; j < saves.size(); j++) {
            EscalationResult res = results[indexOfCase[j]];
            if (saves[j].isSuccess()) {
                res.success = true;
                insertedIds.add(saves[j].getId());
            } else {
                res.success = false;
                res.message = saves[j].getErrors()[0].getMessage();
            }
        }

        // CaseNumber is generated by the database on insert (like a Postgres
        // sequence/DEFAULT) - the in-memory object doesn't have it, so it must
        // be queried back. Returning null here means the agent cheerfully
        // tells the user "your case number is null".
        Map<Id, Case> byId = new CaseNumbers().numbersFor(insertedIds);
        for (Integer j = 0; j < saves.size(); j++) {
            if (saves[j].isSuccess()) {
                EscalationResult res = results[indexOfCase[j]];
                Case created = byId.get(saves[j].getId());
                res.caseNumber = created == null ? null : created.CaseNumber;
                // String.valueOf first: a ternary takes its first branch's type, so
                // an Id there would turn the CaseNumber into an Id and throw.
                res.message = 'Case ' + (res.caseNumber == null ? String.valueOf(saves[j].getId()) : res.caseNumber) + ' created'
                    + (queueId == null ? '.' : ' for the care team queue.');
            }
        }

        return results;
    }

    /**
     * Each device serial number in the batch mapped to its one Asset, in one
     * query. A serial number with no Asset the user can see, or shared by
     * several, maps to nothing: the Case is still created, unlinked, rather
     * than tied to the wrong device. Matched case-sensitively, as
     * DeviceReadingsAgentAction matches a device.
     */
    private static Map<String, Id> assetsBySerial(List<EscalationRequest> requests) {
        Set<String> serials = new Set<String>();
        for (EscalationRequest req : requests) {
            if (req != null && String.isNotBlank(req.deviceId)) {
                serials.add(req.deviceId.trim());
            }
        }
        Map<String, Id> bySerial = new Map<String, Id>();
        if (serials.isEmpty()) {
            return bySerial;
        }
        Set<String> duplicated = new Set<String>();
        for (Asset device : [SELECT Id, SerialNumber FROM Asset WHERE SerialNumber IN :serials]) {
            if (!serials.contains(device.SerialNumber)) {
                continue;   // the same serial number in another case
            }
            if (bySerial.containsKey(device.SerialNumber)) {
                duplicated.add(device.SerialNumber);
            }
            bySerial.put(device.SerialNumber, device.Id);
        }
        for (String serial : duplicated) {
            bySerial.remove(serial);
        }
        return bySerial;
    }

    /**
     * The queue's Id, found the way RoomTemperatureCaseService finds its
     * queue: by DeveloperName, and only if it lists Case as a supported
     * object. Null when it is missing, and the Case keeps the running user
     * as its owner, so an escalation is never lost to a setup mistake.
     */
    private static Id escalationQueueId(String queueName) {
        for (QueueSobject row : [
            SELECT QueueId FROM QueueSobject
            WHERE SobjectType = 'Case' AND Queue.DeveloperName = :queueName
            LIMIT 1
        ]) {
            return row.QueueId;
        }
        System.debug(LoggingLevel.ERROR, 'Queue ' + queueName
            + ' is missing or does not accept Cases; agent Case left with the running user');
        return null;
    }

    /**
     * Reads back the CaseNumber of Cases this transaction has just inserted.
     * Without sharing on purpose, and for that one thing only: once a queue
     * owns the Case, a user whose org keeps Cases private may no longer see
     * the Case they just created, and the agent would have no number to
     * report. The Ids come from our own insert, never from the agent.
     */
    private without sharing class CaseNumbers {
        Map<Id, Case> numbersFor(Set<Id> ids) {
            return new Map<Id, Case>([SELECT Id, CaseNumber FROM Case WHERE Id IN :ids]);
        }
    }

    private static String normalisePriority(String severity) {
        if (String.isBlank(severity)) return 'Medium';
        switch on severity.toUpperCase() {
            when 'HIGH' { return 'High'; }
            when 'LOW'  { return 'Low'; }
            when else   { return 'Medium'; }
        }
    }
}
