/*
 * RequestNurseAgentAction.cls
 *
 * The patient agent's one write: "I need a nurse". It opens a Case for the
 * signed-in patient, on their own account, in the care team's queue, so the
 * ward board moves like it does for any other Case on that queue.
 *
 * Who the patient is comes from the verified chat (PortalIdentityService), not
 * from the model. A device the patient names is attached only if it is on
 * their own account. A second request while one is still open returns the
 * open Case instead of a new one, so a patient repeating themselves, or a
 * looping model, does not flood the queue.
 *
 * without sharing: the agent user creates the Case on the patient's account
 * and hands it to the queue, which its own sharing would not allow. Nothing
 * is written unless PortalIdentityService proved a patient first.
 */
public without sharing class RequestNurseAgentAction {

    public class NurseRequest {
        @InvocableVariable(required=true label='Messaging Session ID'
            description='The Id of this conversation (MessagingSession). Bound from the context variable RoutableId; never ask the patient for it.')
        public String messagingSessionId;

        @InvocableVariable(required=true label='Reason'
            description='What the patient needs, in their own words.')
        public String reason;

        @InvocableVariable(label='Device ID'
            description='Optional: the serial number of the patient\'s device the request is about, for example Test8.')
        public String deviceId;
    }

    public class NurseResult {
        @InvocableVariable(label='Success') public Boolean success;
        @InvocableVariable(label='Message') public String message;
        @InvocableVariable(label='Case Number') public String caseNumber;
        @InvocableVariable(label='Already Open'
            description='True when an open nurse request already existed and no new one was made.')
        public Boolean alreadyOpen;
    }

    @InvocableMethod(
        label='Request a Nurse'
        description='Opens a nurse request (a Case for the care team) for the signed-in patient, or returns the one already open.'
        category='Patient Portal')
    public static List<NurseResult> requestNurse(List<NurseRequest> requests) {
        List<NurseResult> results = new List<NurseResult>();
        for (NurseRequest req : requests == null ? new List<NurseRequest>() : requests) {
            results.add(request(req));
        }
        return results;
    }

    private static NurseResult request(NurseRequest req) {
        NurseResult res = new NurseResult();
        res.success = false;
        res.alreadyOpen = false;
        PortalIdentityService.Identity who = PortalIdentityService.forMessagingSession(
            req == null ? null : req.messagingSessionId);
        if (!who.isPatient()) {
            res.message = who.reason;
            return res;
        }
        if (String.isBlank(req.reason)) {
            res.message = 'Say what you need, and I will pass it to the care team.';
            return res;
        }
        return open(who, req, res);
    }

    private static NurseResult open(PortalIdentityService.Identity who, NurseRequest req, NurseResult res) {
        Patient_Portal_Setting__mdt setting = PatientPortalSettings.get();
        String origin = setting.Nurse_Request_Origin__c;
        for (Case existing : [
            SELECT CaseNumber FROM Case
            WHERE AccountId = :who.accountId AND Origin = :origin AND IsClosed = false
            ORDER BY CreatedDate DESC
            LIMIT 1
        ]) {
            res.success = true;
            res.alreadyOpen = true;
            res.caseNumber = existing.CaseNumber;
            res.message = 'Your nurse request ' + existing.CaseNumber
                + ' is already with the care team. A nurse will come to you.';
            return res;
        }

        Case request = new Case(
            Subject     = 'Patient request: nurse',
            Description = req.reason.trim().left(32000),
            Priority    = 'High',
            Origin      = origin,
            AccountId   = who.accountId,
            ContactId   = who.contactId
        );
        if (String.isNotBlank(req.deviceId)) {
            List<PatientDeviceService.Device> device =
                PatientDeviceService.devicesFor(who.accountId, req.deviceId, 1);
            if (!device.isEmpty()) {
                request.AssetId = device[0].assetId;
            }
        }
        Id queueId = queueId(setting.Nurse_Request_Queue__c);
        if (queueId != null) {
            request.OwnerId = queueId;
        }
        try {
            insert request;
        } catch (DmlException e) {
            res.message = 'The request could not be sent: ' + e.getDmlMessage(0)
                + ' Press the call button by your bed if you need help now.';
            return res;
        }
        res.success = true;
        res.caseNumber = [SELECT CaseNumber FROM Case WHERE Id = :request.Id].CaseNumber;
        res.message = 'Your nurse request ' + res.caseNumber + ' is with the care team. A nurse will come to you.';
        return res;
    }

    private static Id queueId(String queueName) {
        for (QueueSobject row : [
            SELECT QueueId FROM QueueSobject
            WHERE SobjectType = 'Case' AND Queue.DeveloperName = :queueName
            LIMIT 1
        ]) {
            return row.QueueId;
        }
        System.debug(LoggingLevel.ERROR, 'Queue ' + queueName + ' not found; the nurse request stays with the agent user.');
        return null;
    }
}
