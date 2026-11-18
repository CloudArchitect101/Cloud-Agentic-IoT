@IsTest
private class DeviceProvisioningJobTest {

    /** Devices ready to provision, saved without firing the Asset trigger. */
    private static List<Asset> readyDevices(Integer count, String prefix) {
        Account patient = TestAccounts.patient('Fleet Patient');
        insert patient;
        Wi_Fi_Network__c network = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert network;
        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < count; i++) {
            devices.add(new Asset(Name = prefix + i, SerialNumber = prefix + i, AccountId = patient.Id,
                                  Status = 'Installed', Wi_Fi_Network__c = network.Id));
        }
        TriggerHandler.bypass('AssetTriggerHandler');
        insert devices;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return devices;
    }

    private static List<String> idsOf(List<Asset> devices) {
        List<String> ids = new List<String>();
        for (Asset device : devices) {
            ids.add(String.valueOf(device.Id));
        }
        return ids;
    }

    private static Integer countWithStatus(String status) {
        return [SELECT COUNT() FROM Asset WHERE Provisioning_Status__c = :status];
    }

    @IsTest
    static void provisionsInBatchesAndHandsTheRestToTheNextJob() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Devices_Per_Callout__c = 10;
        settings.Callouts_Per_Job__c = 2;
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(25, 'PM-');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.areEqual(2, aws.bodies.size(), 'Two callouts: Callouts_Per_Job__c');
        Assert.areEqual(10, DeviceApiMock.devicesIn(aws.bodies[0]).size(), 'Ten devices each: Devices_Per_Callout__c');
        Assert.areEqual(20, countWithStatus('Provisioned'), 'The twenty that were sent are provisioned');
        Assert.areEqual(5, DeviceProvisioningJob.lastChainedJob.keys.size(), 'The other five go to the next job');
        Assert.areEqual(0, DeviceProvisioningJob.lastChainDelayMinutes, 'Untried work does not wait');

        Asset first = [SELECT Thing_ARN__c, Certificate_Id__c, Thing_Group__c, Provisioning_Expires_At__c
                       FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('cert-PM-0', first.Certificate_Id__c, 'Certificate id is stored for audit');
        Assert.areEqual('fleet-patient-monitor', first.Thing_Group__c, 'The default group comes from settings');
        Assert.isNotNull(first.Provisioning_Expires_At__c, 'The bundle link carries an expiry');
    }

    @IsTest
    static void aDeviceAwsIsBusyForIsTriedAgainLater() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.busyThingNames.add('PM-1');
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(3, 'PM-');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        DeviceProvisioningJob retry = DeviceProvisioningJob.lastChainedJob;
        String busyId = String.valueOf(devices[1].Id);
        Assert.areEqual(new List<String>{ busyId }, retry.keys, 'Only the busy device is tried again');
        Assert.areEqual(1, retry.attemptsByKey.get(busyId), 'It has had one attempt');
        Assert.areEqual(1, DeviceProvisioningJob.lastChainDelayMinutes, 'A retry waits Retry_Delay_Minutes__c');
        Assert.areEqual(2, countWithStatus('Provisioned'), 'The other two were provisioned the first time');
        Assert.areEqual(0, countWithStatus('Failed'), 'Busy is not failed, yet');
    }

    @IsTest
    static void aDeviceAwsIsBusyForOnEveryAttemptIsFailedWithTheReason() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Max_Callout_Attempts__c = 3;
        DeviceApiMock aws = new DeviceApiMock();
        aws.busyThingNames.add('PM-0');
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(1, 'PM-');
        String key = String.valueOf(devices[0].Id);

        Test.startTest();
        // The job a third attempt runs in: two attempts already made.
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, new List<String>{ key },
                                  new Map<String, Integer>{ key => 2 }).execute(null);
        Test.stopTest();

        Assert.isNull(DeviceProvisioningJob.lastChainedJob, 'No fourth attempt');
        Asset busy = [SELECT Provisioning_Status__c, Provisioning_Error__c FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('Failed', busy.Provisioning_Status__c, 'Failed after Max_Callout_Attempts__c');
        Assert.isTrue(busy.Provisioning_Error__c.contains('all 3 attempts'), busy.Provisioning_Error__c);
        Assert.isTrue(busy.Provisioning_Error__c.contains('Rate exceeded'), busy.Provisioning_Error__c);
    }

    @IsTest
    static void aWholeRequestAwsIsBusyForIsRetried() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 503;
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(3, 'PM-');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.areEqual(3, DeviceProvisioningJob.lastChainedJob.keys.size(), 'All three are tried again');
        Assert.areEqual(0, countWithStatus('Failed'), 'Nothing is failed on the first busy answer');
    }

    @IsTest
    static void aRefusedRequestFailsEveryDeviceInItWithoutRetrying() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.statusCode = 403;   // e.g. the Named Credential's AWS keys are wrong
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(3, 'PM-');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.isNull(DeviceProvisioningJob.lastChainedJob, 'A 403 fails the same way every time: no retry');
        Asset failed = [SELECT Provisioning_Status__c, Provisioning_Error__c FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('Failed', failed.Provisioning_Status__c, 'Failed');
        Assert.isTrue(failed.Provisioning_Error__c.startsWith('HTTP 403'), failed.Provisioning_Error__c);
    }

    @IsTest
    static void oneRefusedDeviceDoesNotFailTheOthers() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.refusedThingNames.add('PM-2');
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(4, 'PM-');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.areEqual(3, countWithStatus('Provisioned'), 'The other three are provisioned');
        Asset refused = [SELECT Provisioning_Status__c, Provisioning_Error__c FROM Asset WHERE Id = :devices[2].Id];
        Assert.areEqual('Failed', refused.Provisioning_Status__c, 'The refused one is failed');
        Assert.isTrue(refused.Provisioning_Error__c.contains('refused by the mock'), refused.Provisioning_Error__c);
    }

    @IsTest
    static void aDeviceWithoutANetworkIsFailedWithoutACallout() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(1, 'PM-');
        update new Asset(Id = devices[0].Id, Wi_Fi_Network__c = null);

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'Nothing to send');
        Asset saved = [SELECT Provisioning_Status__c, Provisioning_Error__c FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('Failed', saved.Provisioning_Status__c, 'Failed');
        Assert.isTrue(saved.Provisioning_Error__c.contains('Wi-Fi Network'), saved.Provisioning_Error__c);
    }

    @IsTest
    static void reprovisioningReplacesTheCertificateAndKeepsTheThing() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(1, 'PM-');
        String thingArn = 'arn:aws:iot:ca-central-1:111122223333:thing/PM-0';
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = devices[0].Id, Thing_ARN__c = thingArn, Certificate_Id__c = 'cert-old',
                         Provisioning_Status__c = 'Provisioned');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.REPROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.areEqual('reprovision-device', aws.paths[0], 'Calls the reprovision route');
        Asset saved = [SELECT Thing_ARN__c, Certificate_Id__c FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('cert-PM-0', saved.Certificate_Id__c, 'New certificate');
        Assert.areEqual(thingArn, saved.Thing_ARN__c, 'Same Thing, so all history keyed on it survives');
    }

    @IsTest
    static void aProvisioningSalesforceCannotSaveIsFailedWithWhatAwsMade() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.bundleUrlLength = 40000;   // more than Provisioning_Bundle_Link__c holds
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(1, 'PM-');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.PROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Asset saved = [SELECT Provisioning_Status__c, Provisioning_Error__c, Thing_ARN__c, Certificate_Id__c,
                              Provisioning_Bundle_Link__c
                       FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('Failed', saved.Provisioning_Status__c, 'Not left looking as if nothing happened');
        Assert.isTrue(saved.Provisioning_Error__c.contains('Re-provision'), saved.Provisioning_Error__c);
        Assert.isFalse(saved.Provisioning_Error__c.contains('https://'),
            'A bundle link is a credential, so the reason never quotes it: ' + saved.Provisioning_Error__c);
        Assert.areEqual('arn:aws:iot:ca-central-1:111122223333:thing/PM-0', saved.Thing_ARN__c,
            'The Thing AWS made is recorded, so Re-provision and delete can reach it');
        Assert.areEqual('cert-PM-0', saved.Certificate_Id__c, 'So is the certificate it issued');
        Assert.areEqual('fleet-patient-monitor', [SELECT Thing_Group__c FROM Asset WHERE Id = :devices[0].Id].Thing_Group__c,
            'And the Thing Group it was put in');
        Assert.isNull(saved.Provisioning_Bundle_Link__c, 'No link was saved');
    }

    @IsTest
    static void reprovisioningRefusesAThingArnThatNamesAnotherThing() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(1, 'PM-');
        TriggerHandler.bypass('AssetTriggerHandler');
        // Provisioned as PM-9; its serial number reads PM-0 now.
        update new Asset(Id = devices[0].Id, Thing_ARN__c = 'arn:aws:iot:ca-central-1:111122223333:thing/PM-9',
                         Provisioning_Status__c = 'Provisioned');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.REPROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'AWS is not asked to replace the certificate of Thing PM-0');
        Asset saved = [SELECT Provisioning_Status__c, Provisioning_Error__c, Thing_ARN__c FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('Failed', saved.Provisioning_Status__c, 'Refused');
        Assert.isTrue(saved.Provisioning_Error__c.contains('does not name the Thing PM-0'), saved.Provisioning_Error__c);
        Assert.isTrue(saved.Thing_ARN__c.endsWith(':thing/PM-9'), 'The Thing ARN is left as it was');
    }

    @IsTest
    static void teardownsKeepThingsAnotherAssetStillUses() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        // Remaining devices: PM-0 by its serial number only, and one
        // provisioned as PM-1 whose serial number has changed since.
        List<Asset> remaining = readyDevices(2, 'PM-');
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = remaining[1].Id, SerialNumber = 'PM-1-NEW', Provisioning_Status__c = 'Provisioned',
                         Thing_ARN__c = 'arn:aws:iot:ca-central-1:111122223333:thing/PM-1');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        DeviceProvisioningJob.Run leftovers = DeviceProvisioningJob.process(
            DeviceProvisioningJob.Action.TEARDOWN_LEFTOVER, new List<String>{ 'PM-0', 'pm-1', 'PM-2' });
        DeviceProvisioningJob.Run full = DeviceProvisioningJob.process(
            DeviceProvisioningJob.Action.TEARDOWN, new List<String>{ 'PM-1', 'PM-0' });
        Test.stopTest();

        Assert.areEqual(2, aws.bodies.size(), 'One callout for each kind');
        List<Object> sent = (List<Object>) aws.bodies[0].get('leftoverThingNames');
        Assert.areEqual(1, sent.size(), 'Only one leftover sent: ' + sent);
        Assert.areEqual('PM-2', sent[0], 'PM-2, the one no remaining device uses; case does not matter');
        Assert.areEqual(3, leftovers.succeeded, 'Keeping the other two is a decision, not a failure');
        Assert.areEqual(0, leftovers.failed, 'Nothing failed');

        // A full teardown keeps only a Thing another Asset's Thing ARN names.
        // PM-0's certificate is the deleted device's, whatever shares its
        // serial number, so it still goes.
        List<Object> tornDown = (List<Object>) aws.bodies[1].get('thingNames');
        Assert.areEqual(new List<Object>{ 'PM-0' }, tornDown, 'Only PM-0 torn down: ' + tornDown);
        Assert.areEqual(2, full.succeeded, 'PM-1 kept, PM-0 torn down');
        Assert.areEqual(0, full.failed, 'Nothing failed');
    }

    @IsTest
    static void theInUseCheckCoversEveryNameOfALargeDelete() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        // More names than one query asks about, with one in use in each query:
        // PM-7 by a serial number, PM-77 and PM-119 by Thing ARNs.
        List<Asset> remaining = readyDevices(3, 'KEEP-');
        TriggerHandler.bypass('AssetTriggerHandler');
        update new List<Asset>{
            new Asset(Id = remaining[0].Id, SerialNumber = 'PM-7'),
            new Asset(Id = remaining[1].Id, Provisioning_Status__c = 'Provisioned',
                      Thing_ARN__c = 'arn:aws:iot:ca-central-1:111122223333:thing/PM-77'),
            new Asset(Id = remaining[2].Id, Provisioning_Status__c = 'Provisioned',
                      Thing_ARN__c = 'arn:aws:iot:ca-central-1:111122223333:thing/PM-119')
        };
        TriggerHandler.clearBypass('AssetTriggerHandler');
        List<String> thingNames = new List<String>();
        for (Integer i = 0; i < 120; i++) {
            thingNames.add('PM-' + i);
        }

        Test.startTest();
        DeviceProvisioningJob.Run run = DeviceProvisioningJob.process(
            DeviceProvisioningJob.Action.TEARDOWN_LEFTOVER, thingNames);
        Test.stopTest();

        Set<String> sent = new Set<String>();
        for (Map<String, Object> body : aws.bodies) {
            for (Object thingName : (List<Object>) body.get('leftoverThingNames')) {
                sent.add((String) thingName);
            }
        }
        Assert.areEqual(117, sent.size(), 'Every name but the three in use');
        Assert.isFalse(sent.contains('PM-7') || sent.contains('PM-77') || sent.contains('PM-119'),
            'The three in use are kept: ' + sent);
        Assert.areEqual(120, run.succeeded, 'All 120 decided');
        Assert.areEqual(0, run.failed, 'Nothing failed');
        Assert.isTrue(run.notReached.isEmpty(), 'All reached in one job');
    }

    @IsTest
    static void aReprovisioningSalesforceCannotSaveKeepsTheThingArn() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.bundleUrlLength = 40000;
        Test.setMock(HttpCalloutMock.class, aws);
        List<Asset> devices = readyDevices(1, 'PM-');
        String thingArn = 'arn:aws:iot:ca-central-1:111122223333:thing/PM-0';
        TriggerHandler.bypass('AssetTriggerHandler');
        update new Asset(Id = devices[0].Id, Thing_ARN__c = thingArn, Certificate_Id__c = 'cert-old',
                         Provisioning_Status__c = 'Provisioned');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.REPROVISION, idsOf(devices)).execute(null);
        Test.stopTest();

        Asset saved = [SELECT Provisioning_Status__c, Thing_ARN__c, Certificate_Id__c FROM Asset WHERE Id = :devices[0].Id];
        Assert.areEqual('Failed', saved.Provisioning_Status__c, 'The old certificate is revoked, so it cannot stay Provisioned');
        Assert.areEqual(thingArn, saved.Thing_ARN__c, 'Still the same Thing, so Re-provision can run again');
        Assert.areEqual('cert-PM-0', saved.Certificate_Id__c, 'The certificate AWS issued, not the revoked one');
    }

    @IsTest
    static void teardownSendsThingNamesInBatches() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        List<String> thingNames = new List<String>();
        for (Integer i = 0; i < 25; i++) {
            thingNames.add('PM-' + i);
        }

        Test.startTest();
        new DeviceProvisioningJob(DeviceProvisioningJob.Action.TEARDOWN, thingNames).execute(null);
        Test.stopTest();

        Assert.areEqual(3, aws.bodies.size(), '25 devices, 10 per callout');
        Assert.areEqual(25, aws.devicesSent(), 'Every Thing name is sent once');
        Assert.areEqual('teardown-device', aws.paths[0], 'Calls the teardown route');
    }

    @IsTest
    static void aLeftoverThatAwsKeepsIsNotAFailure() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        aws.keptThingNames.add('PM-1');
        Test.setMock(HttpCalloutMock.class, aws);

        Test.startTest();
        DeviceProvisioningJob.Run run = DeviceProvisioningJob.process(
            DeviceProvisioningJob.Action.TEARDOWN_LEFTOVER, new List<String>{ 'PM-0', 'PM-1' });
        Test.stopTest();

        Assert.areEqual('teardown-device', aws.paths[0], 'Calls the teardown route');
        Assert.isNull(aws.bodies[0].get('thingNames'), 'Never as Things to tear down in full');
        Assert.areEqual(2, ((List<Object>) aws.bodies[0].get('leftoverThingNames')).size(), 'Both, as leftovers');
        Assert.areEqual(2, run.succeeded, 'Removed and kept are both what was asked for');
        Assert.areEqual(0, run.failed, 'Nothing failed');
        Assert.areEqual(0, run.busy.size(), 'Nothing to retry');
    }
}
