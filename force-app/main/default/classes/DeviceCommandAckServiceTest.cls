/*
 * DeviceCommandAckServiceTest.cls
 *
 * Covers DeviceCommandAckService: a board's answer recorded as Acked or
 * Failed, once, and only from the board the command was for.
 */
@IsTest
private class DeviceCommandAckServiceTest {

    // Whole seconds: a Datetime field keeps no milliseconds.
    private static final Datetime AT = Datetime.newInstanceGmt(2026, 11, 6, 5, 30, 0);

    /** Commands for the board PM-1, in the status given, saved without starting a job. */
    private static List<Device_Command__c> commands(String status, Integer count) {
        List<Device_Command__c> commands = new List<Device_Command__c>();
        for (Integer i = 0; i < count; i++) {
            commands.add(new Device_Command__c(Device__c = 'PM-1', Command__c = 'DISPENSE_MEDICATION',
                                               Status__c = status, Requested_By__c = 'Ack Test'));
        }
        TriggerHandler.bypass('DeviceCommandTriggerHandler');
        insert commands;
        TriggerHandler.clearBypass('DeviceCommandTriggerHandler');
        return commands;
    }

    private static Device_Command__c command(String status) {
        return commands(status, 1)[0];
    }

    private static DeviceCommandAckService.Answer answer(String commandId, String thingName, String outcome, String detail) {
        DeviceCommandAckService.Answer answer = new DeviceCommandAckService.Answer();
        answer.commandId = commandId;
        answer.thingName = thingName;
        answer.outcome = outcome;
        answer.detail = detail;
        answer.answeredAtMillis = AT.getTime();
        return answer;
    }

    private static List<DeviceCommandAckService.Recorded> record(List<DeviceCommandAckService.Answer> answers) {
        Test.startTest();
        List<DeviceCommandAckService.Recorded> recorded = DeviceCommandAckService.record(answers);
        Test.stopTest();
        return recorded;
    }

    private static DeviceCommandAckService.Recorded recordOne(DeviceCommandAckService.Answer answer) {
        return record(new List<DeviceCommandAckService.Answer>{ answer })[0];
    }

    private static Device_Command__c saved(Id commandId) {
        return [SELECT Status__c, Status_Detail__c, Answered_At__c, Sent_At__c
                FROM Device_Command__c WHERE Id = :commandId];
    }

    @IsTest
    static void doneIsAckedWithWhatTheBoardSaid() {
        Device_Command__c command = command('Sent');

        DeviceCommandAckService.Recorded recorded = recordOne(answer(command.Id, 'PM-1', 'done', 'every 60 s'));

        Assert.areEqual(String.valueOf(command.Id), recorded.commandId, 'Names its command');
        Assert.isTrue(recorded.applied, 'Applied');
        Assert.isNull(recorded.skipped, 'Nothing skipped');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Acked', saved.Status__c, 'Acked');
        Assert.areEqual('every 60 s', saved.Status_Detail__c, 'What the board said');
        Assert.areEqual(AT, saved.Answered_At__c, 'When the answer reached AWS IoT');
    }

    @IsTest
    static void doneWithoutADetailLeavesNone() {
        Device_Command__c command = command('Sent');

        recordOne(answer(command.Id, 'PM-1', 'done', null));

        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Acked', saved.Status__c, 'Acked');
        Assert.isNull(saved.Status_Detail__c, 'Nothing to say');
    }

    @IsTest
    static void failedIsFailedWithWhyTheBoardCouldNot() {
        Device_Command__c command = command('Sent');

        DeviceCommandAckService.Recorded recorded = recordOne(
            answer(command.Id, 'PM-1', 'failed', 'seconds must be 5-86400'));

        Assert.isTrue(recorded.applied, 'Applied');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Failed', saved.Status__c, 'Failed');
        Assert.areEqual('The board could not carry it out: seconds must be 5-86400', saved.Status_Detail__c, 'Why');
    }

    @IsTest
    static void refusedIsFailedSayingTheBoardDoesNotTakeIt() {
        Device_Command__c command = command('Sent');

        DeviceCommandAckService.Recorded recorded = recordOne(
            answer(command.Id, 'PM-1', 'refused', 'unknown operation DISPENSE_MEDICATION'));

        Assert.isTrue(recorded.applied, 'Applied');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Failed', saved.Status__c, 'Failed');
        Assert.areEqual('The board does not take this command: unknown operation DISPENSE_MEDICATION',
            saved.Status_Detail__c, 'Why');
    }

    @IsTest
    static void aLongDetailIsCutToTheField() {
        Device_Command__c command = command('Sent');

        recordOne(answer(command.Id, 'PM-1', 'failed', 'x'.repeat(255)));

        Assert.areEqual(255, saved(command.Id).Status_Detail__c.length(), 'Status Detail holds 255');
    }

    @IsTest
    static void anAnswerWithoutATimeIsAnsweredNow() {
        Device_Command__c command = command('Sent');
        DeviceCommandAckService.Answer answer = answer(command.Id, 'PM-1', 'done', null);
        answer.answeredAtMillis = null;
        Datetime before = Datetime.now().addSeconds(-1);

        recordOne(answer);

        Datetime answeredAt = saved(command.Id).Answered_At__c;
        Assert.isTrue(answeredAt >= before && answeredAt <= Datetime.now().addSeconds(1), 'Now: ' + answeredAt);
    }

    @IsTest
    static void aPendingCommandTakesItsAnswer() {
        // The answer can arrive before the send job has saved Sent.
        Device_Command__c command = command('Pending');

        DeviceCommandAckService.Recorded recorded = recordOne(answer(command.Id, 'PM-1', 'done', null));

        Assert.isTrue(recorded.applied, 'Applied');
        Assert.areEqual('Acked', saved(command.Id).Status__c, 'Acked');
    }

    @IsTest
    static void aCommandSalesforceFailedStillTakesTheBoardsAnswer() {
        // The callout timed out after AWS had published the command.
        Device_Command__c command = command('Failed');
        update new Device_Command__c(Id = command.Id, Status_Detail__c = 'Not sent: HTTP 0: Read timed out');

        DeviceCommandAckService.Recorded recorded = recordOne(answer(command.Id, 'PM-1', 'done', 'dispensed'));

        Assert.isTrue(recorded.applied, 'The board carried it out, so that is what the record says');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Acked', saved.Status__c, 'Acked');
        Assert.areEqual('dispensed', saved.Status_Detail__c, 'The board\'s word replaces the timeout');
    }

    @IsTest
    static void aCommandTheBoardAnsweredKeepsItsFirstAnswer() {
        List<Device_Command__c> commands = commands('Sent', 2);
        update new List<Device_Command__c>{
            new Device_Command__c(Id = commands[0].Id, Status__c = 'Acked', Answered_At__c = AT),
            new Device_Command__c(Id = commands[1].Id, Status__c = 'Failed', Answered_At__c = AT,
                                  Status_Detail__c = 'The board could not carry it out: servo stuck')
        };

        List<DeviceCommandAckService.Recorded> recorded = record(new List<DeviceCommandAckService.Answer>{
            answer(commands[0].Id, 'PM-1', 'failed', 'already carried out'),
            answer(commands[1].Id, 'PM-1', 'done', 'already carried out')
        });

        for (DeviceCommandAckService.Recorded one : recorded) {
            Assert.isFalse(one.applied, 'Not applied');
            Assert.isTrue(one.skipped.contains('Already answered'), one.skipped);
        }
        Assert.areEqual('Acked', saved(commands[0].Id).Status__c, 'Still Acked');
        Device_Command__c failed = saved(commands[1].Id);
        Assert.areEqual('Failed', failed.Status__c, 'Still Failed');
        Assert.areEqual('The board could not carry it out: servo stuck', failed.Status_Detail__c, 'Still the first reason');
    }

    @IsTest
    static void twoAnswersToOneCommandInOneCallApplyTheFirst() {
        Device_Command__c command = command('Sent');

        List<DeviceCommandAckService.Recorded> recorded = record(new List<DeviceCommandAckService.Answer>{
            answer(command.Id, 'PM-1', 'done', 'dispensed'),
            answer(command.Id, 'PM-1', 'done', 'already carried out')
        });

        Assert.isTrue(recorded[0].applied, 'The first applies');
        Assert.isFalse(recorded[1].applied, 'The repeat does not');
        Assert.isTrue(recorded[1].skipped.contains('Already answered'), recorded[1].skipped);
        Assert.areEqual('dispensed', saved(command.Id).Status_Detail__c, 'The first answer stands');
    }

    @IsTest
    static void anAnswerFromAnotherBoardIsSkipped() {
        Device_Command__c command = command('Sent');

        List<DeviceCommandAckService.Recorded> recorded = record(new List<DeviceCommandAckService.Answer>{
            answer(command.Id, 'PM-2', 'done', null),
            // Thing names are case-sensitive: pm-1 is another board.
            answer(command.Id, 'pm-1', 'done', null)
        });

        for (DeviceCommandAckService.Recorded one : recorded) {
            Assert.isFalse(one.applied, 'Not applied');
            Assert.isTrue(one.skipped.contains('to a command for PM-1'), one.skipped);
        }
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Sent', saved.Status__c, 'Unchanged');
        Assert.isNull(saved.Answered_At__c, 'Not answered');
    }

    @IsTest
    static void anAnswerToACommandThatIsGoneIsSkipped() {
        Device_Command__c command = command('Sent');
        delete command;

        DeviceCommandAckService.Recorded recorded = recordOne(answer(command.Id, 'PM-1', 'done', null));

        Assert.isFalse(recorded.applied, 'Not applied');
        Assert.isTrue(recorded.skipped.contains('No Device Command'), recorded.skipped);
    }

    @IsTest
    static void anAnswerWhoseCommandIdIsNotADeviceCommandIsSkipped() {
        List<DeviceCommandAckService.Recorded> recorded = record(new List<DeviceCommandAckService.Answer>{
            answer('cmd-42_from-a-script', 'PM-1', 'done', null),
            // A real Id, of a User.
            answer(UserInfo.getUserId(), 'PM-1', 'done', null)
        });

        for (DeviceCommandAckService.Recorded one : recorded) {
            Assert.isFalse(one.applied, 'Not applied');
            Assert.isTrue(one.skipped.contains('Not a Device Command Id'), one.skipped);
        }
    }

    @IsTest
    static void aBadAnswerIsSkippedAndTheOthersStillApply() {
        Device_Command__c command = command('Sent');
        DeviceCommandAckService.Answer noCommandId = answer(null, 'PM-1', 'done', null);
        DeviceCommandAckService.Answer noThingName = answer(command.Id, null, 'done', null);

        List<DeviceCommandAckService.Recorded> recorded = record(new List<DeviceCommandAckService.Answer>{
            answer(command.Id, 'PM-1', 'acked', null),
            answer(command.Id, 'PM-1', 'Done', null),
            noCommandId,
            noThingName,
            null,
            answer(command.Id, 'PM-1', 'done', null)
        });

        Assert.areEqual(6, recorded.size(), 'One Recorded per answer, in order');
        Assert.isTrue(recorded[0].skipped.contains('done, failed or refused'), recorded[0].skipped);
        Assert.isTrue(recorded[1].skipped.contains('done, failed or refused'), 'Exactly done: ' + recorded[1].skipped);
        Assert.isTrue(recorded[2].skipped.contains('commandId'), recorded[2].skipped);
        Assert.isTrue(recorded[3].skipped.contains('thingName'), recorded[3].skipped);
        Assert.isNotNull(recorded[4].skipped, 'An empty answer is skipped too');
        for (Integer i = 0; i < 5; i++) {
            Assert.isFalse(recorded[i].applied, 'Skipped answer ' + i + ' applied nothing');
        }
        Assert.isTrue(recorded[5].applied, 'The good answer applied');
        Assert.areEqual('Acked', saved(command.Id).Status__c, 'Acked');
    }

    @IsTest
    static void twoHundredAnswersAreOneQueryAndOneUpdate() {
        List<Device_Command__c> commands = commands('Sent', 200);
        List<DeviceCommandAckService.Answer> answers = new List<DeviceCommandAckService.Answer>();
        for (Device_Command__c command : commands) {
            answers.add(answer(command.Id, 'PM-1', 'done', null));
        }

        Test.startTest();
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        List<DeviceCommandAckService.Recorded> recorded = DeviceCommandAckService.record(answers);
        Integer queries = Limits.getQueries() - queriesBefore;
        Integer dml = Limits.getDmlStatements() - dmlBefore;
        Test.stopTest();

        Assert.areEqual(1, queries, 'One query for the whole call');
        Assert.areEqual(1, dml, 'One update for the whole call');
        Assert.areEqual(200, recorded.size(), 'One Recorded per answer');
        Assert.areEqual(String.valueOf(commands[199].Id), recorded[199].commandId, 'In order');
        Assert.areEqual(200, [SELECT COUNT() FROM Device_Command__c WHERE Status__c = 'Acked'], 'Every command');
    }
}
