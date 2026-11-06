/*
 * DeviceCommandServiceTest.cls
 *
 * Covers Device_Command__c insert -> DeviceCommandTrigger ->
 * DeviceCommandTriggerHandler -> DeviceCommandService: the command made
 * ready before insert, and one send job started after it.
 */
@IsTest
private class DeviceCommandServiceTest {

    private static final String ARN_PREFIX = 'arn:aws:iot:us-east-2:111122223333:thing/';

    /**
     * Devices, saved without firing the Asset trigger. A device with a Thing
     * name is provisioned as that Thing; one without has no Thing ARN yet.
     */
    private static List<Asset> devices(List<String> serialNumbers, List<String> thingNames) {
        Account patient = new Account(Name = 'Command Patient');
        insert patient;
        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < serialNumbers.size(); i++) {
            String thingName = thingNames[i];
            devices.add(new Asset(
                Name = 'Device ' + i, SerialNumber = serialNumbers[i], AccountId = patient.Id, Status = 'Installed',
                Thing_ARN__c = thingName == null ? null : ARN_PREFIX + thingName,
                Provisioning_Status__c = thingName == null ? 'Not Provisioned' : 'Provisioned'
            ));
        }
        TriggerHandler.bypass('AssetTriggerHandler');
        insert devices;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return devices;
    }

    private static Asset device(String serialNumber, String thingName) {
        return devices(new List<String>{ serialNumber }, new List<String>{ thingName })[0];
    }

    private static Device_Command__c command(String deviceId, Id assetId) {
        return new Device_Command__c(Device__c = deviceId, Asset__c = assetId, Command__c = 'DISPENSE_MEDICATION');
    }

    private static Device_Command__c saved(Id commandId) {
        return [SELECT Device__c, Asset__c, Status__c, Status_Detail__c, Requested_By__c, Sent_At__c
                FROM Device_Command__c WHERE Id = :commandId];
    }

    /** Every message of a save that failed, so a test finds what it expects whichever comes first. */
    private static String errorsOf(Database.SaveResult result) {
        List<String> messages = new List<String>();
        for (Database.Error error : result.getErrors()) {
            messages.add(error.getMessage());
        }
        return String.join(messages, ' | ');
    }

    /* ------------------------------------------------------------ prepare */

    @IsTest
    static void aNewCommandIsPendingAndNamesWhoAskedForIt() {
        Device_Command__c command = new Device_Command__c(Device__c = 'PM-NONE', Command__c = 'RESTART');

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.areEqual('Pending', command.Status__c, 'Waiting to be sent');
        Assert.areEqual(UserInfo.getName().abbreviate(80), command.Requested_By__c, 'Whoever created it');
        Assert.isNull(command.Asset__c, 'No Asset has this serial number');
        Assert.areEqual('PM-NONE', command.Device__c, 'Sent to the Device ID as given');
    }

    @IsTest
    static void whatTheCreatorSetIsKept() {
        // What Slack sets.
        Device_Command__c command = new Device_Command__c(Device__c = 'PM-NONE', Command__c = 'DISPENSE_MEDICATION',
                                                          Status__c = 'Pending', Requested_By__c = 'Slack');

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.areEqual('Pending', command.Status__c, 'Kept');
        Assert.areEqual('Slack', command.Requested_By__c, 'Kept');
    }

    @IsTest
    static void aDeviceIdIsLinkedToTheOneAssetWithThatSerialNumber() {
        Asset device = device('PM-1', 'PM-1');
        Device_Command__c command = command('PM-1', null);

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.areEqual(device.Id, command.Asset__c, 'Linked by serial number');
        Assert.areEqual('PM-1', command.Device__c, 'Its Thing');
    }

    @IsTest
    static void aSerialNumberEditedAfterProvisioningIsNotLinked() {
        // The serial number was edited after provisioning: the board is still
        // Thing PM-1, and PM-2 names another board, or none.
        device('PM-2', 'PM-1');
        Device_Command__c command = command('PM-2', null);

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.isNull(command.Asset__c, 'Its board is PM-1, not PM-2');
        Assert.areEqual('PM-2', command.Device__c, 'Sent to PM-2 as given, never to another board');
    }

    @IsTest
    static void aSerialNumberTwoAssetsShareLinksNeither() {
        devices(new List<String>{ 'PM-1', 'PM-1' }, new List<String>{ 'PM-1', null });
        Device_Command__c command = command('PM-1', null);

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.isNull(command.Asset__c, 'Two Assets: no telling which one is meant');
        Assert.areEqual('PM-1', command.Device__c, 'Still sent to PM-1');
    }

    @IsTest
    static void aSerialNumberInAnotherCaseIsAnotherBoard() {
        // AWS IoT Thing names are case-sensitive; SOQL comparisons are not.
        device('Test7', 'Test7');
        Device_Command__c command = command('test7', null);

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.isNull(command.Asset__c, 'test7 is not Test7');
        Assert.areEqual('test7', command.Device__c, 'Sent to test7 as given');
    }

    @IsTest
    static void aCommandOnAnAssetGoesToItsThing() {
        Asset device = device('PM-2', 'PM-1');
        List<Device_Command__c> commands = new List<Device_Command__c>{
            command(null, device.Id),     // Device ID left empty
            command('PM-2', device.Id),   // its serial number, as Send Command fills it in
            command('PM-1', device.Id)    // its Thing name
        };

        DeviceCommandService.prepare(commands);

        for (Device_Command__c command : commands) {
            Assert.areEqual('PM-1', command.Device__c, 'The Thing its Thing ARN names');
            Assert.areEqual(device.Id, command.Asset__c, 'Still on its Asset');
        }
    }

    @IsTest
    static void aDeviceNotYetProvisionedIsNamedByItsSerialNumber() {
        Asset device = device('PM-9', null);
        Device_Command__c command = command(null, device.Id);

        DeviceCommandService.prepare(new List<Device_Command__c>{ command });

        Assert.areEqual('PM-9', command.Device__c, 'No Thing ARN yet: its serial number');
    }

    @IsTest
    static void aDeviceIdThatNamesAnotherBoardIsRefusedNamingBoth() {
        Asset device = device('PM-1', 'PM-1');

        Database.SaveResult result = Database.insert(command('PM-7', device.Id), false);

        Assert.isFalse(result.isSuccess(), 'Not saved: one record would name two boards');
        String errors = errorsOf(result);
        Assert.isTrue(errors.contains('PM-7') && errors.contains('PM-1'), errors);
        Assert.isTrue(result.getErrors()[0].getFields().contains('Device__c'), 'On Device ID: ' + errors);
        Assert.areEqual(0, [SELECT COUNT() FROM Device_Command__c], 'Nothing saved, so nothing sent');
    }

    @IsTest
    static void anAssetWithNoBoardToNameIsRefused() {
        Asset device = device(null, null);

        Database.SaveResult result = Database.insert(command('PM-X', device.Id), false);

        Assert.isFalse(result.isSuccess(), 'Not saved: no board can take it');
        Assert.isTrue(errorsOf(result).contains('no Serial Number and no Thing ARN'), errorsOf(result));
    }

    @IsTest
    static void twoHundredCommandsAreMadeReadyWithOneQuery() {
        List<String> names = new List<String>();
        for (Integer i = 0; i < 200; i++) {
            names.add('BULK-' + i);
        }
        List<Asset> devices = devices(names, names);
        // Half name their Asset, as Send Command does; half only a Device ID, as Slack does.
        List<Device_Command__c> commands = new List<Device_Command__c>();
        for (Integer i = 0; i < 200; i++) {
            commands.add(i < 100 ? command(null, devices[i].Id) : command(names[i], null));
        }

        Test.startTest();
        Integer queriesBefore = Limits.getQueries();
        DeviceCommandService.prepare(commands);
        Integer queries = Limits.getQueries() - queriesBefore;
        Test.stopTest();

        Assert.areEqual(1, queries, 'One query for the whole save');
        for (Integer i = 0; i < 200; i++) {
            Assert.areEqual(devices[i].Id, commands[i].Asset__c, 'Command ' + i + ' is on its device');
            Assert.areEqual(names[i], commands[i].Device__c, 'Command ' + i + ' goes to its Thing');
        }
    }

    /* --------------------------------------------------------------- send */

    @IsTest
    static void oneJobSendsThePendingCommandsOfASave() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<Device_Command__c> commands = new List<Device_Command__c>{
            command('PM-A', null),
            command('PM-B', null),
            // Loaded with its history, already answered: not sent again.
            new Device_Command__c(Device__c = 'PM-C', Command__c = 'RESTART', Status__c = 'Acked')
        };

        Test.startTest();
        insert commands;
        Integer jobs = Limits.getQueueableJobs();
        Test.stopTest();   // runs the send job

        Assert.areEqual(1, jobs, 'One job for the whole save');
        Assert.areEqual(2, aws.bodies.size(), 'One callout per Pending command');
        Assert.areEqual('PM-A', aws.bodies[0].get('thingName'), 'Oldest first');
        Assert.areEqual('PM-B', aws.bodies[1].get('thingName'), 'Oldest first');
        Assert.areEqual('Sent', saved(commands[0].Id).Status__c, 'Sent');
        Assert.areEqual('Sent', saved(commands[1].Id).Status__c, 'Sent');
        Assert.areEqual('Acked', saved(commands[2].Id).Status__c, 'Left as it was');
    }

    @IsTest
    static void aSlackCommandForABoardWithoutAnAssetIsStillSent() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        // Exactly what lambda/slack-integration creates for /dispense-medication.
        Device_Command__c command = new Device_Command__c(Device__c = 'PM-SLACK', Command__c = 'DISPENSE_MEDICATION',
                                                          Requested_By__c = 'Slack', Status__c = 'Pending');

        Test.startTest();
        insert command;
        Test.stopTest();

        Device_Command__c saved = saved(command.Id);
        Assert.areEqual('Sent', saved.Status__c, 'Sent');
        Assert.areEqual('Slack', saved.Requested_By__c, 'Still Slack');
        Assert.isNull(saved.Asset__c, 'No Asset has this serial number');
        Assert.areEqual('PM-SLACK', aws.bodies[0].get('thingName'), 'To the board Slack named');
        Assert.areEqual('DISPENSE_MEDICATION', aws.bodies[0].get('operation'), 'The command Slack asked for');
    }

    @IsTest
    static void aSlackCommandForADeviceWithAnAssetIsLinkedToIt() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = device('PM-1', 'PM-1');
        Device_Command__c command = new Device_Command__c(Device__c = 'PM-1', Command__c = 'DISPENSE_MEDICATION',
                                                          Requested_By__c = 'Slack', Status__c = 'Pending');

        Test.startTest();
        insert command;
        Test.stopTest();

        Device_Command__c saved = saved(command.Id);
        Assert.areEqual(device.Id, saved.Asset__c, 'Shows on the device');
        Assert.areEqual('Sent', saved.Status__c, 'A provisioned board not known to be offline is sent to');
        Assert.areEqual('PM-1', aws.bodies[0].get('thingName'), 'To its Thing');
    }
}
