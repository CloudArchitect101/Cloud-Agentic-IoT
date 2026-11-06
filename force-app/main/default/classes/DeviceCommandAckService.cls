/*
 * DeviceCommandAckService.cls
 *
 * Records a board's answer to a Device Command: Acked when the board carried
 * the command out, Failed with why when it could not, or does not take that
 * command at all.
 *
 * DeviceCommandSendJob sends each command with its record Id as commandId.
 * The board answers on device/<thing>/ack, an IoT rule queues the answer,
 * and the device-command-ack Lambda calls this action as the integration
 * user with up to 200 answers at a time: one query and one update per call,
 * and one Recorded per answer, in order.
 *
 * An answer that cannot apply is skipped, with the reason in its Recorded,
 * and never throws: an exception here would fail every answer in the call,
 * and AWS would send them all again. A command keeps its first answer: a
 * board that is sent a command twice carries it out once and answers the
 * repeat with the first outcome, which changes nothing here.
 *
 * A command counts as answered once it has an Answered At, or is Acked. A
 * command Salesforce marked Failed, because its callout timed out or AWS
 * answered with an error after it had published, may still have reached the
 * board, and the board's answer says what really happened, so it applies.
 *
 * Without sharing: Device_Command__c is Private, and the board's answer must
 * reach the command whoever created it. What guards it is the check that the
 * answering board is the command's device: the Thing name comes from the
 * topic the answer was published on, which the device policy lets only that
 * Thing publish to, and it must be exactly the command's Device ID. Only
 * Device_Integration may run this class.
 */
public without sharing class DeviceCommandAckService {

    private static final String OUTCOME_DONE = 'done';
    private static final String OUTCOME_FAILED = 'failed';
    private static final String OUTCOME_REFUSED = 'refused';

    /** One board's answer, as the device-command-ack Lambda sends it. */
    public class Answer {
        @InvocableVariable(required=true label='Command Id'
                           description='The Device Command\'s record Id, which the board was sent as commandId.')
        public String commandId;

        @InvocableVariable(required=true label='Thing Name'
                           description='The AWS IoT Thing that answered, from the topic of its answer.')
        public String thingName;

        @InvocableVariable(required=true label='Outcome'
                           description='done (carried out), failed (could not carry it out) or refused (does not take this command).')
        public String outcome;

        @InvocableVariable(label='Detail' description='What the board said about it, if anything.')
        public String detail;

        @InvocableVariable(label='Answered At (ms)'
                           description='When the answer reached AWS IoT, in milliseconds since 1970-01-01 UTC. Empty means now.')
        public Long answeredAtMillis;
    }

    /** What one Answer did: whether it was recorded, and if not, why. */
    public class Recorded {
        @InvocableVariable(label='Command Id')
        public String commandId;

        @InvocableVariable(label='Applied')
        public Boolean applied;

        @InvocableVariable(label='Skipped' description='Why the answer was not recorded. Empty when it was.')
        public String skipped;
    }

    @InvocableMethod(label='Record Device Command Answer'
                     description='Sets each Device Command to Acked or Failed from its board\'s answer, unless the board answered it already or the answer comes from another board.'
                     category='Device Platform')
    public static List<Recorded> record(List<Answer> answers) {
        List<Recorded> results = new List<Recorded>();
        if (answers == null) {
            return results;
        }

        // The command each answer is for, or null for an answer already skipped.
        List<Id> commandIdByAnswer = new List<Id>();
        Set<Id> commandIds = new Set<Id>();
        for (Answer answer : answers) {
            Recorded result = new Recorded();
            result.commandId = answer == null ? null : answer.commandId;
            result.applied = false;
            result.skipped = problemWith(answer);
            Id commandId = null;
            if (result.skipped == null) {
                commandId = deviceCommandId(answer.commandId);
                if (commandId == null) {
                    result.skipped = 'Not a Device Command Id: ' + answer.commandId + '.';
                } else {
                    commandIds.add(commandId);
                }
            }
            results.add(result);
            commandIdByAnswer.add(commandId);
        }
        Map<Id, Device_Command__c> commands = commandsWithIds(commandIds);

        // A command is changed in memory, so a second answer to it in this
        // call finds it answered, and it is saved once.
        Map<Id, Device_Command__c> answered = new Map<Id, Device_Command__c>();
        for (Integer i = 0; i < answers.size(); i++) {
            if (results[i].skipped != null) {
                continue;
            }
            Answer answer = answers[i];
            Device_Command__c command = commands.get(commandIdByAnswer[i]);
            if (command == null) {
                results[i].skipped = 'No Device Command has this Id.';
            } else if (!answer.thingName.equals(command.Device__c)) {
                // equals, not ==: Thing names are case-sensitive.
                results[i].skipped = 'An answer from ' + answer.thingName + ' to a command for ' + command.Device__c + '.';
            } else if (command.Answered_At__c != null || command.Status__c == DeviceCommandService.ACKED) {
                results[i].skipped = 'Already answered: ' + command.Status__c + '.';
            } else {
                apply(answer, command);
                answered.put(command.Id, command);
            }
        }

        Map<Id, String> errorsById = save(answered.values());
        for (Integer i = 0; i < answers.size(); i++) {
            if (results[i].skipped != null) {
                continue;
            }
            String error = errorsById.get(commandIdByAnswer[i]);
            if (error == null) {
                results[i].applied = true;
            } else {
                results[i].skipped = 'Not saved: ' + error;
            }
        }
        return results;
    }

    private static String problemWith(Answer answer) {
        if (answer == null) {
            return 'An empty answer.';
        }
        if (String.isBlank(answer.commandId)) {
            return 'No commandId.';
        }
        if (String.isBlank(answer.thingName)) {
            return 'No thingName, so the board that answered is unknown.';
        }
        // equals, not ==: Apex compares strings with == regardless of case,
        // and the board sends exactly these three.
        if (!OUTCOME_DONE.equals(answer.outcome) && !OUTCOME_FAILED.equals(answer.outcome)
                && !OUTCOME_REFUSED.equals(answer.outcome)) {
            return 'outcome must be done, failed or refused, not ' + answer.outcome + '.';
        }
        return null;
    }

    /** The Id in commandId when it is a Device Command's, else null. */
    private static Id deviceCommandId(String value) {
        try {
            Id recordId = Id.valueOf(value);
            return recordId.getSObjectType() == Device_Command__c.SObjectType ? recordId : null;
        } catch (Exception e) {
            return null;   // not an Id at all, or the Id of no object
        }
    }

    // System mode, in a class without sharing: the integration user's own
    // access must not decide which commands hear their board's answer.
    private static Map<Id, Device_Command__c> commandsWithIds(Set<Id> commandIds) {
        if (commandIds.isEmpty()) {
            return new Map<Id, Device_Command__c>();
        }
        return new Map<Id, Device_Command__c>([
            SELECT Id, Device__c, Status__c, Status_Detail__c, Answered_At__c
            FROM Device_Command__c
            WHERE Id IN :commandIds
            WITH SYSTEM_MODE
        ]);
    }

    private static void apply(Answer answer, Device_Command__c command) {
        String said = String.isBlank(answer.detail) ? null : answer.detail;
        String statusDetail;
        if (OUTCOME_DONE.equals(answer.outcome)) {
            command.Status__c = DeviceCommandService.ACKED;
            statusDetail = said;
        } else if (OUTCOME_FAILED.equals(answer.outcome)) {
            command.Status__c = DeviceCommandService.FAILED;
            statusDetail = 'The board could not carry it out' + (said == null ? '.' : ': ' + said);
        } else {
            command.Status__c = DeviceCommandService.FAILED;
            statusDetail = 'The board does not take this command' + (said == null ? '.' : ': ' + said);
        }
        command.Status_Detail__c = statusDetail == null ? null : statusDetail.abbreviate(255);
        command.Answered_At__c = answer.answeredAtMillis == null
            ? System.now() : Datetime.newInstance(answer.answeredAtMillis);
    }

    /**
     * One update for the whole call, and the error of each command it could
     * not save, by Id. Only the three answer fields are written.
     */
    private static Map<Id, String> save(List<Device_Command__c> commands) {
        Map<Id, String> errorsById = new Map<Id, String>();
        if (commands.isEmpty()) {
            return errorsById;
        }
        List<Device_Command__c> rows = new List<Device_Command__c>();
        for (Device_Command__c command : commands) {
            rows.add(new Device_Command__c(
                Id               = command.Id,
                Status__c        = command.Status__c,
                Status_Detail__c = command.Status_Detail__c,
                Answered_At__c   = command.Answered_At__c
            ));
        }
        List<Database.SaveResult> saves = Database.update(rows, false);
        for (Integer i = 0; i < saves.size(); i++) {
            if (!saves[i].isSuccess()) {
                String error = saves[i].getErrors()[0].getMessage();
                errorsById.put(rows[i].Id, error);
                System.debug(LoggingLevel.ERROR, 'Could not record the answer to Device Command ' + rows[i].Id + ': ' + error);
            }
        }
        return errorsById;
    }
}
