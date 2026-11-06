/*
 * DeviceCommandSendJobTest.cls
 *
 * Covers DeviceCommandSendJob: each Pending command sent once, with its
 * record Id as commandId, or Failed with why; an answer saved while the job
 * ran kept; and the commands left when the callouts run out handed on.
 */
@IsTest
private class DeviceCommandSendJobTest {

    private static final String ARN_PREFIX = 'arn:aws:iot:us-east-2:111122223333:thing/';

    // Whole seconds: a Datetime field keeps no milliseconds.
    private static final Datetime SINCE = Datetime.newInstanceGmt(2026, 11, 6, 5, 30, 0);

    /** A device, saved without firing the Asset trigger. */
    private static Asset device(String thingName, String provisioningStatus, String connectionStatus) {
        Account patient = new Account(Name = 'Command Patient');
        insert patient;
        Asset device = new Asset(
            Name = thingName, SerialNumber = thingName, AccountId = patient.Id, Status = 'Installed',
            Thing_ARN__c = provisioningStatus == 'Provisioned' ? ARN_PREFIX + thingName : null,
            Provisioning_Status__c = provisioningStatus,
            Connection_Status__c = connectionStatus,
            Connection_Since__c = connectionStatus == null ? null : SINCE
        );
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    /** Pending commands, as the trigger leaves them, saved without starting a job. */
    private static List<Device_Command__c> pending(String deviceId, Id assetId, Integer count) {
        List<Device_Command__c> commands = new List<Device_Command__c>();
        for (Integer i = 0; i < count; i++) {
            commands.add(new Device_Command__c(
                Device__c = deviceId, Asset__c = assetId, Command__c = 'DISPENSE_MEDICATION',
                Status__c = 'Pending', Requested_By__c = 'Send Job Test'
            ));
        }
        TriggerHandler.bypass('DeviceCommandTriggerHandler');
        insert commands;
        TriggerHandler.clearBypass('DeviceCommandTriggerHandler');
        return commands;
    }

    private static Device_Command__c pendingFor(Asset device) {
        return pending(device.SerialNumber, device.Id, 1)[0];
    }

    private static List<Id> idsOf(List<Device_Command__c> commands) {
        List<Id> ids = new List<Id>();
        for (Device_Command__c command : commands) {
            ids.add(command.Id);
        }
        return ids;
    }

    private static void run(List<Device_Command__c> commands) {
        Test.startTest();
        new DeviceCommandSendJob(idsOf(commands)).execute(null);
        Test.stopTest();
    }

    private static Device_Command__c saved(Id commandId) {
        return [SELECT Status__c, Status_Detail__c, Sent_At__c, Answered_At__c
                FROM Device_Command__c WHERE Id = :commandId];
    }

    @IsTest
    static void aCommandAwsTakesIsSentWithItsRecordIdAsCommandId() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Device_Command__c command = pendingFor(device('PM-1', 'Provisioned', 'Online'));

        run(new List<Device_Command__c>{ command });

        Assert.areEqual(new List<String>{ 'device-command' }, aws.paths, 'One call, to POST /device-command');
        Map<String, Object> body = aws.bodies[0];
        Assert.areEqual('PM-1', body.get('thingName'), 'To its board');
        Assert.areEqual('DISPENSE_MEDICATION', body.get('operation'), 'The command');
        Assert.areEqual(String.valueOf(command.Id), body.get('commandId'), 'Its record Id, which the board answers with');
        Assert.areEqual(18, String.valueOf(body.get('commandId')).length(), 'All 18 characters');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Sent', saved.Status__c, 'Sent');
        Assert.isNotNull(saved.Sent_At__c, 'When AWS took it');
        Assert.isNull(saved.Status_Detail__c, 'Nothing to explain');
    }

    @IsTest
    static void aCommandAwsRefusesIsFailedWithWhy() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 400;
        Test.setMock(HttpCalloutMock.class, aws);
        Device_Command__c command = pendingFor(device('PM-1', 'Provisioned', 'Online'));

        run(new List<Device_Command__c>{ command });

        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Failed', saved.Status__c, 'Failed');
        Assert.isTrue(saved.Status_Detail__c.startsWith('Not sent: HTTP 400'), saved.Status_Detail__c);
        Assert.isTrue(saved.Status_Detail__c.contains('mock answered 400'), 'With what AWS said: ' + saved.Status_Detail__c);
        Assert.isNull(saved.Sent_At__c, 'Never sent');
    }

    @IsTest
    static void aCommandForABoardThatIsOfflineIsFailedWithoutACallout() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Device_Command__c command = pendingFor(device('PM-1', 'Provisioned', 'Offline'));

        run(new List<Device_Command__c>{ command });

        Assert.areEqual(0, aws.bodies.size(), 'No callout: the board would never hear it');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Failed', saved.Status__c, 'Failed');
        Assert.areEqual('Not sent: the board has been offline since 2026-11-06 05:30 UTC. Send it again once the board is online.',
            saved.Status_Detail__c, 'Says since when, and what to do');
        Assert.isNull(saved.Sent_At__c, 'Never sent');
    }

    @IsTest
    static void aCommandForADeviceNotProvisionedIsFailedWithoutACallout() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Device_Command__c command = pendingFor(device('PM-1', 'Not Provisioned', null));

        run(new List<Device_Command__c>{ command });

        Assert.areEqual(0, aws.bodies.size(), 'No callout: there is no board yet');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Failed', saved.Status__c, 'Failed');
        Assert.areEqual('Not sent: PM-1 is not provisioned yet.', saved.Status_Detail__c, 'Names the device');
    }

    @IsTest
    static void aCommandWithoutAnAssetIsSentToItsDeviceId() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        // Slack's, for a board no Asset has: there is nothing to check first.
        List<Device_Command__c> commands = pending('PM-SLACK', null, 1);

        run(commands);

        Assert.areEqual('PM-SLACK', aws.bodies[0].get('thingName'), 'To the Device ID');
        Assert.areEqual('Sent', saved(commands[0].Id).Status__c, 'Sent');
    }

    @IsTest
    static void anAnswerSavedWhileTheJobRanIsKept() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Device_Command__c command = pendingFor(device('PM-1', 'Provisioned', 'Online'));
        DeviceCommandSendJob job = new DeviceCommandSendJob(new List<Id>{ command.Id });
        DeviceCommandAckService.Answer answer = new DeviceCommandAckService.Answer();
        answer.commandId = command.Id;
        answer.thingName = 'PM-1';
        answer.outcome = 'done';
        answer.detail = 'dispensed';
        answer.answeredAtMillis = SINCE.addMinutes(1).getTime();

        Test.startTest();
        Map<Id, Device_Command__c> outcomes = new Map<Id, Device_Command__c>();
        job.sendWhatFits(outcomes);
        // AWS published the command and the board answered before the job saved Sent.
        DeviceCommandAckService.record(new List<DeviceCommandAckService.Answer>{ answer });
        DeviceCommandSendJob.save(outcomes);
        Test.stopTest();

        Assert.areEqual(1, aws.bodies.size(), 'It was sent');
        Assert.areEqual('Sent', outcomes.get(command.Id).Status__c, 'The job had Sent to save');
        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Acked', saved.Status__c, 'The answer stands');
        Assert.areEqual('dispensed', saved.Status_Detail__c, 'With what the board said');
        Assert.areEqual(SINCE.addMinutes(1), saved.Answered_At__c, 'When the board answered');
        Assert.isNotNull(saved.Sent_At__c, 'And it gains when it was sent');
    }

    @IsTest
    static void commandsLeftWhenTheCalloutsRunOutGoToTheNextJob() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Callouts_Per_Job__c = 2;
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = device('PM-1', 'Provisioned', 'Online');
        List<Device_Command__c> commands = pending(device.SerialNumber, device.Id, 3);

        run(commands);

        Assert.areEqual(2, aws.bodies.size(), 'Two callouts: Callouts_Per_Job__c');
        Assert.areEqual(String.valueOf(commands[0].Id), aws.bodies[0].get('commandId'), 'Oldest first');
        Assert.areEqual(String.valueOf(commands[1].Id), aws.bodies[1].get('commandId'), 'Oldest first');
        DeviceCommandSendJob next = DeviceCommandSendJob.lastChainedJob;
        Assert.isNotNull(next, 'The rest go to the next job');
        Assert.areEqual(new List<Id>{ commands[2].Id }, next.commandIds, 'The third command');
        Assert.areEqual('Pending', saved(commands[2].Id).Status__c, 'Still waiting for that job');
        Assert.areEqual(2, [SELECT COUNT() FROM Device_Command__c WHERE Status__c = 'Sent'], 'The two sent');
    }

    @IsTest
    static void aCommandNoLongerPendingIsNotSentAgain() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Device_Command__c command = pendingFor(device('PM-1', 'Provisioned', 'Online'));
        update new Device_Command__c(Id = command.Id, Status__c = 'Sent');

        run(new List<Device_Command__c>{ command });

        Assert.areEqual(0, aws.bodies.size(), 'Not sent twice');
        Assert.isNull(DeviceCommandSendJob.lastChainedJob, 'Nothing left over');
        Assert.areEqual('Sent', saved(command.Id).Status__c, 'Left as it was');
    }
}
