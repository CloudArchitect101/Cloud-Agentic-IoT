@IsTest
private class DeviceConnectionServiceTest {

    private static final String ARN_PREFIX = 'arn:aws:iot:us-east-2:111122223333:thing/';

    // Whole seconds: a Datetime field keeps no milliseconds.
    private static final Datetime AT = Datetime.newInstanceGmt(2026, 11, 6, 5, 30, 0);

    /** Provisioned devices, saved without firing the Asset trigger. */
    private static List<Asset> devices(List<String> thingNames) {
        Account patient = TestAccounts.patient('Presence Patient');
        insert patient;
        List<Asset> devices = new List<Asset>();
        for (String thingName : thingNames) {
            devices.add(new Asset(Name = thingName, SerialNumber = thingName, AccountId = patient.Id,
                                  Status = 'Installed', Thing_ARN__c = ARN_PREFIX + thingName,
                                  Provisioning_Status__c = 'Provisioned'));
        }
        TriggerHandler.bypass('AssetTriggerHandler');
        insert devices;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return devices;
    }

    private static Asset device(String thingName) {
        return devices(new List<String>{ thingName })[0];
    }

    /** Makes a device show a connection already, as an earlier event would have. */
    private static void showing(Asset device, String status, Datetime since, String reason) {
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = device.Id, Connection_Status__c = status, Connection_Since__c = since,
                         Last_Disconnect_Reason__c = reason);
        TriggerHandler.clearBypass('AssetTriggerHandler');
    }

    private static DeviceConnectionService.Change event(String thingName, String status, Datetime at, String reason) {
        DeviceConnectionService.Change change = new DeviceConnectionService.Change();
        change.thingArn = ARN_PREFIX + thingName;
        change.status = status;
        change.changedAtMillis = at == null ? null : at.getTime();
        change.disconnectReason = reason;
        return change;
    }

    private static List<DeviceConnectionService.Outcome> record(List<DeviceConnectionService.Change> changes) {
        Test.startTest();
        List<DeviceConnectionService.Outcome> outcomes = DeviceConnectionService.record(changes);
        Test.stopTest();
        return outcomes;
    }

    private static Asset saved(Id assetId) {
        return [SELECT Connection_Status__c, Connection_Since__c, Last_Disconnect_Reason__c
                FROM Asset WHERE Id = :assetId];
    }

    @IsTest
    static void aBoardThatConnectsIsOnlineAndKeepsItsLastDisconnectReason() {
        Asset device = device('PM-1');
        showing(device, 'Offline', AT.addMinutes(-5), 'CONNECTION_LOST');

        List<DeviceConnectionService.Outcome> outcomes = record(
            new List<DeviceConnectionService.Change>{ event('PM-1', 'Online', AT, null) });

        Assert.areEqual(1, outcomes.size(), 'One outcome per change');
        Assert.areEqual(ARN_PREFIX + 'PM-1', outcomes[0].thingArn, 'Names its Thing ARN');
        Assert.areEqual(1, outcomes[0].assetsUpdated, 'One Asset updated');
        Assert.isNull(outcomes[0].skipped, 'Nothing skipped');
        Asset saved = saved(device.Id);
        Assert.areEqual('Online', saved.Connection_Status__c, 'Online');
        Assert.areEqual(AT, saved.Connection_Since__c, 'Since the connect, by AWS IoT clock');
        Assert.areEqual('CONNECTION_LOST', saved.Last_Disconnect_Reason__c, 'Still says why it was last away');
    }

    @IsTest
    static void aBoardThatDisconnectsIsOfflineWithTheReason() {
        Asset device = device('PM-1');
        showing(device, 'Online', AT.addMinutes(-5), 'CONNECTION_LOST');

        List<DeviceConnectionService.Outcome> outcomes = record(
            new List<DeviceConnectionService.Change>{ event('PM-1', 'Offline', AT, 'MQTT_KEEP_ALIVE_TIMEOUT') });

        Assert.areEqual(1, outcomes[0].assetsUpdated, 'Updated');
        Asset saved = saved(device.Id);
        Assert.areEqual('Offline', saved.Connection_Status__c, 'Offline');
        Assert.areEqual(AT, saved.Connection_Since__c, 'Since the disconnect');
        Assert.areEqual('MQTT_KEEP_ALIVE_TIMEOUT', saved.Last_Disconnect_Reason__c, 'The new reason');
    }

    @IsTest
    static void aDisconnectWithoutAReasonLeavesNoReason() {
        Asset device = device('PM-1');
        showing(device, 'Online', AT.addMinutes(-5), 'CONNECTION_LOST');

        record(new List<DeviceConnectionService.Change>{ event('PM-1', 'Offline', AT, null) });

        Asset saved = saved(device.Id);
        Assert.areEqual('Offline', saved.Connection_Status__c, 'Offline');
        Assert.isNull(saved.Last_Disconnect_Reason__c, 'Null stays null: the old reason was another disconnect\'s');
    }

    @IsTest
    static void anOlderEventChangesNothingAndSaysWhy() {
        // A disconnect delivered after the connect that followed it.
        Asset device = device('PM-1');
        showing(device, 'Online', AT, null);

        List<DeviceConnectionService.Outcome> outcomes = record(new List<DeviceConnectionService.Change>{
            event('PM-1', 'Offline', AT.addSeconds(-3), 'CONNECTION_LOST') });

        Assert.areEqual(0, outcomes[0].assetsUpdated, 'Nothing updated');
        Assert.isTrue(outcomes[0].skipped.contains('older event'), outcomes[0].skipped);
        Asset saved = saved(device.Id);
        Assert.areEqual('Online', saved.Connection_Status__c, 'Still Online');
        Assert.areEqual(AT, saved.Connection_Since__c, 'Still the newer time');
        Assert.isNull(saved.Last_Disconnect_Reason__c, 'No reason written');
    }

    @IsTest
    static void anEventAsOldAsTheOneShownIsApplied() {
        Asset device = device('PM-1');
        showing(device, 'Online', AT, null);

        List<DeviceConnectionService.Outcome> outcomes = record(new List<DeviceConnectionService.Change>{
            event('PM-1', 'Offline', AT, 'SERVER_INITIATED_DISCONNECT') });

        Assert.areEqual(1, outcomes[0].assetsUpdated, 'The same time is not older');
        Assert.areEqual('Offline', saved(device.Id).Connection_Status__c, 'Offline');
    }

    @IsTest
    static void aThingArnNoAssetHasIsSkipped() {
        device('PM-1');

        List<DeviceConnectionService.Outcome> outcomes = record(
            new List<DeviceConnectionService.Change>{ event('PM-UNKNOWN', 'Online', AT, null) });

        Assert.areEqual(0, outcomes[0].assetsUpdated, 'Nothing updated');
        Assert.isTrue(outcomes[0].skipped.contains('No Asset'), outcomes[0].skipped);
    }

    @IsTest
    static void aThingArnInAnotherCaseIsAnotherThing() {
        // AWS IoT Thing names are case-sensitive; SOQL comparisons are not.
        Asset device = device('Test7');

        List<DeviceConnectionService.Outcome> outcomes = record(
            new List<DeviceConnectionService.Change>{ event('test7', 'Online', AT, null) });

        Assert.areEqual(0, outcomes[0].assetsUpdated, 'test7 is not Test7');
        Assert.isTrue(outcomes[0].skipped.contains('No Asset'), outcomes[0].skipped);
        Assert.isNull(saved(device.Id).Connection_Status__c, 'Test7 is untouched');
    }

    @IsTest
    static void aBadChangeIsSkippedAndTheOthersStillApply() {
        Asset device = device('PM-1');
        DeviceConnectionService.Change noArn = event('PM-1', 'Online', AT, null);
        noArn.thingArn = null;

        List<DeviceConnectionService.Outcome> outcomes = record(new List<DeviceConnectionService.Change>{
            event('PM-1', 'Sleeping', AT, null),
            event('PM-1', 'online', AT, null),
            event('PM-1', 'Online', null, null),
            noArn,
            null,
            event('PM-1', 'Online', AT, null)
        });

        Assert.areEqual(6, outcomes.size(), 'One outcome per change, in order');
        Assert.isTrue(outcomes[0].skipped.contains('Online or Offline'), outcomes[0].skipped);
        Assert.isTrue(outcomes[1].skipped.contains('Online or Offline'), 'Exactly Online: ' + outcomes[1].skipped);
        Assert.isTrue(outcomes[2].skipped.contains('changedAtMillis'), outcomes[2].skipped);
        Assert.isTrue(outcomes[3].skipped.contains('Thing ARN'), outcomes[3].skipped);
        Assert.isNotNull(outcomes[4].skipped, 'An empty change is skipped too');
        for (Integer i = 0; i < 5; i++) {
            Assert.areEqual(0, outcomes[i].assetsUpdated, 'Skipped change ' + i + ' updated nothing');
        }
        Assert.areEqual(1, outcomes[5].assetsUpdated, 'The good change applied');
        Assert.areEqual('Online', saved(device.Id).Connection_Status__c, 'Online');
    }

    @IsTest
    static void everyAssetWithTheThingArnIsUpdated() {
        // A copy of a record keeps the Thing ARN, and both show the board.
        List<Asset> devices = devices(new List<String>{ 'PM-1', 'PM-2' });
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = devices[1].Id, Thing_ARN__c = ARN_PREFIX + 'PM-1');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        List<DeviceConnectionService.Outcome> outcomes = record(
            new List<DeviceConnectionService.Change>{ event('PM-1', 'Online', AT, null) });

        Assert.areEqual(2, outcomes[0].assetsUpdated, 'Both Assets');
        Assert.areEqual('Online', saved(devices[0].Id).Connection_Status__c, 'The first');
        Assert.areEqual('Online', saved(devices[1].Id).Connection_Status__c, 'The copy');
    }

    @IsTest
    static void twoEventsForOneBoardInOneCallApplyInTimeOrder() {
        // The Lambda sends one change per Thing; two must not save one Asset twice.
        Asset device = device('PM-1');

        List<DeviceConnectionService.Outcome> outcomes = record(new List<DeviceConnectionService.Change>{
            event('PM-1', 'Offline', AT.addSeconds(5), 'CONNECTION_LOST'),
            event('PM-1', 'Online', AT, null)
        });

        Assert.areEqual(1, outcomes[0].assetsUpdated, 'The newer one applied');
        Assert.areEqual(0, outcomes[1].assetsUpdated, 'The older one did not');
        Assert.isTrue(outcomes[1].skipped.contains('older event'), outcomes[1].skipped);
        Asset saved = saved(device.Id);
        Assert.areEqual('Offline', saved.Connection_Status__c, 'Offline');
        Assert.areEqual(AT.addSeconds(5), saved.Connection_Since__c, 'Since the disconnect');
    }

    @IsTest
    static void twoHundredBoardsAreOneQueryAndOneUpdate() {
        List<String> thingNames = new List<String>();
        for (Integer i = 0; i < 200; i++) {
            thingNames.add('BULK-' + i);
        }
        devices(thingNames);
        List<DeviceConnectionService.Change> changes = new List<DeviceConnectionService.Change>();
        for (String thingName : thingNames) {
            changes.add(event(thingName, 'Online', AT, null));
        }

        Test.startTest();
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        List<DeviceConnectionService.Outcome> outcomes = DeviceConnectionService.record(changes);
        Integer queries = Limits.getQueries() - queriesBefore;
        Integer dml = Limits.getDmlStatements() - dmlBefore;
        Test.stopTest();

        Assert.areEqual(1, queries, 'One query for the whole batch');
        Assert.areEqual(1, dml, 'One update for the whole batch');
        Assert.areEqual(200, outcomes.size(), 'One outcome per change');
        Assert.areEqual(ARN_PREFIX + 'BULK-199', outcomes[199].thingArn, 'In order');
        Assert.areEqual(200, [SELECT COUNT() FROM Asset WHERE Connection_Status__c = 'Online'], 'Every board');
    }

    @IsTest
    static void theAssetTriggerIsBypassedOnlyForTheUpdate() {
        device('PM-1');

        record(new List<DeviceConnectionService.Change>{ event('PM-1', 'Online', AT, null) });

        Assert.isFalse(TriggerHandler.isBypassed('AssetTriggerHandler'), 'On again for the rest of the transaction');
    }

    @IsTest
    static void aBypassTheCallerSetIsLeftInPlace() {
        device('PM-1');
        TriggerHandler.bypass('AssetTriggerHandler');

        record(new List<DeviceConnectionService.Change>{ event('PM-1', 'Online', AT, null) });

        Assert.isTrue(TriggerHandler.isBypassed('AssetTriggerHandler'), 'Still bypassed, as the caller left it');
        TriggerHandler.clearBypass('AssetTriggerHandler');
    }

    /* ------------------------------------- no case alert on reconnect */

    // Since firmware 2.5.0 a patient board's motor follows its own room, so a
    // board coming online is sent no CASE_ALERT.
    private static Integer alerts() {
        return [SELECT COUNT() FROM Device_Command__c WHERE Command__c = 'CASE_ALERT'];
    }

    @IsTest
    static void aBoardComingOnlineIsSentNoCaseAlert() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = device('PM-1');
        Datetime now = Datetime.newInstance(System.now().getTime() / 1000 * 1000);
        showing(device, 'Offline', now.addMinutes(-10), 'CONNECTION_LOST');

        record(new List<DeviceConnectionService.Change>{ event('PM-1', 'Online', now, null) });

        Assert.areEqual(0, alerts(), 'No CASE_ALERT');
        Assert.areEqual(0, aws.bodies.size(), 'No callout');
    }
}
