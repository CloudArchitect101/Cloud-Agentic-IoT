/*
 * DeviceCommandSendJob.cls
 *
 * Sends Device Commands to their boards: one callout per command to the
 * device API's POST /device-command, { thingName, operation, commandId },
 * which publishes it on device/<thing>/command. The commandId is the record's
 * Id; the board answers with it on device/<thing>/ack, and
 * DeviceCommandAckService records the answer as Acked or Failed.
 *
 * DeviceCommandService starts one job for the Pending commands of each save.
 * A command whose Asset is not provisioned, or whose board is offline, is
 * Failed with the reason and costs no callout: the board subscribes with a
 * clean session, so AWS IoT keeps nothing for a board that is away, and the
 * command would be lost without a word.
 *
 * The job stops calling out while it is still inside Salesforce's callout
 * limits (see DeviceApiClient.canCall) and hands the commands it did not
 * reach to a new job.
 *
 * It runs as the user who created the commands, so its callouts use that
 * user's access to the AWS_IoT_Relay external credential.
 */
public with sharing class DeviceCommandSendJob implements Queueable, Database.AllowsCallouts {

    @TestVisible
    private final List<Id> commandIds;

    // A test cannot chain one job to another, so in a test the job that would
    // have been started is kept here for the test to inspect.
    @TestVisible
    private static DeviceCommandSendJob lastChainedJob;

    public DeviceCommandSendJob(List<Id> commandIds) {
        this.commandIds = commandIds == null ? new List<Id>() : commandIds;
    }

    public void execute(QueueableContext context) {
        Map<Id, Device_Command__c> outcomes = new Map<Id, Device_Command__c>();
        List<Id> notReached = sendWhatFits(outcomes);
        if (!notReached.isEmpty()) {
            String refusal = chain(new DeviceCommandSendJob(notReached));
            if (refusal != null) {
                for (Id commandId : notReached) {
                    outcomes.put(commandId, failed(commandId, 'Not sent: Salesforce would not start another job to send it ('
                        + refusal + '). Send the command again.'));
                }
            }
        }
        save(outcomes);
    }

    /**
     * Sends the commands that are still Pending, oldest first, while a callout
     * is left, and puts what became of each in outcomes. Returns the Ids of
     * the commands it did not reach. Nothing is saved here (see save).
     */
    @TestVisible
    private List<Id> sendWhatFits(Map<Id, Device_Command__c> outcomes) {
        List<Device_Command__c> commands = [
            SELECT Id, Device__c, Command__c,
                   Asset__r.Name, Asset__r.Provisioning_Status__c,
                   Asset__r.Connection_Status__c, Asset__r.Connection_Since__c
            FROM Device_Command__c
            WHERE Id IN :commandIds AND Status__c = 'Pending'
            ORDER BY CreatedDate, Id
        ];
        DeviceApiClient api = new DeviceApiClient();
        Integer index = 0;
        while (index < commands.size() && api.canCall()) {
            outcomes.put(commands[index].Id, send(api, commands[index]));
            index++;
        }
        List<Id> notReached = new List<Id>();
        while (index < commands.size()) {
            notReached.add(commands[index].Id);
            index++;
        }
        return notReached;
    }

    private static Device_Command__c send(DeviceApiClient api, Device_Command__c command) {
        Asset device = command.Asset__r;
        if (device != null && device.Provisioning_Status__c != 'Provisioned') {
            return failed(command.Id, 'Not sent: ' + device.Name + ' is not provisioned yet.');
        }
        if (device != null && device.Connection_Status__c == DeviceConnectionService.OFFLINE) {
            String since = device.Connection_Since__c == null
                ? 'is offline'
                : 'has been offline since ' + device.Connection_Since__c.formatGmt('yyyy-MM-dd HH:mm') + ' UTC';
            return failed(command.Id, 'Not sent: the board ' + since + '. Send it again once the board is online.');
        }

        Map<String, Object> body = new Map<String, Object>{
            'thingName' => command.Device__c,
            'operation' => command.Command__c,
            'commandId' => (String) command.Id
        };
        DeviceApiClient.Result result = api.post('device-command', body);
        if (!result.succeeded()) {
            return failed(command.Id, 'Not sent: ' + result.summary());
        }
        return new Device_Command__c(
            Id               = command.Id,
            Status__c        = DeviceCommandService.SENT,
            Sent_At__c       = System.now(),
            Status_Detail__c = null
        );
    }

    private static Device_Command__c failed(Id commandId, String reason) {
        return new Device_Command__c(
            Id               = commandId,
            Status__c        = DeviceCommandService.FAILED,
            Status_Detail__c = reason.abbreviate(255)
        );
    }

    /**
     * Saves each outcome, but only on a command that is still Pending. The
     * board can answer before this job ends, since AWS published the command
     * before the job saves Sent, and an answer must never turn back into
     * Sent. The commands are read again and locked, so an answer saved
     * meanwhile is seen here, and one saved later waits for this save and
     * then overwrites it. An answered command only gains its Sent At.
     */
    @TestVisible
    private static void save(Map<Id, Device_Command__c> outcomes) {
        if (outcomes.isEmpty()) {
            return;
        }
        List<Device_Command__c> rows = new List<Device_Command__c>();
        for (Device_Command__c current : [
            SELECT Id, Status__c, Sent_At__c
            FROM Device_Command__c
            WHERE Id IN :outcomes.keySet()
            FOR UPDATE
        ]) {
            Device_Command__c outcome = outcomes.get(current.Id);
            if (current.Status__c == DeviceCommandService.PENDING) {
                rows.add(outcome);
            } else if (current.Sent_At__c == null && outcome.Sent_At__c != null) {
                rows.add(new Device_Command__c(Id = current.Id, Sent_At__c = outcome.Sent_At__c));
            }
        }
        if (rows.isEmpty()) {
            return;
        }
        List<Database.SaveResult> saves = Database.update(rows, false);
        for (Integer i = 0; i < saves.size(); i++) {
            if (!saves[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Could not save what became of Device Command ' + rows[i].Id
                    + ': ' + saves[i].getErrors()[0].getMessage());
            }
        }
    }

    /** Starts the next job. Returns null, or why Salesforce would not start it. */
    private static String chain(DeviceCommandSendJob next) {
        if (Test.isRunningTest()) {
            lastChainedJob = next;
            return null;
        }
        try {
            System.enqueueJob(next);
            return null;
        } catch (AsyncException e) {
            // Developer Edition and trial orgs stop a chain at five jobs. The
            // commands left are Failed with the reason rather than left
            // Pending, where nothing would ever send them.
            System.debug(LoggingLevel.ERROR, 'Could not start the next job for ' + next.commandIds.size()
                + ' Device Command(s): ' + e.getMessage());
            return e.getMessage();
        }
    }
}
