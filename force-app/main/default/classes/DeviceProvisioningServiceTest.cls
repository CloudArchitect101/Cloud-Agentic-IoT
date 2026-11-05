@IsTest
private class DeviceProvisioningServiceTest {

    private static Asset newDevice(String serial) {
        Account patient = new Account(Name = 'Test Patient');
        insert patient;
        Wi_Fi_Network__c net = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert net;
        return new Asset(
            Name = serial, SerialNumber = serial, AccountId = patient.Id,
            Status = 'Installed', Wi_Fi_Network__c = net.Id
        );
    }

    @IsTest
    static void newDeviceIsProvisioned() {
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Asset device = newDevice('ESP32-T1');

        Test.startTest();
        insert device;
        Test.stopTest();

        Asset saved = [SELECT Thing_ARN__c, Certificate_Id__c, Provisioning_Status__c,
                              Provisioning_Bundle_Link__c, Provisioning_Expires_At__c
                       FROM Asset WHERE Id = :device.Id];
        Assert.areEqual('Provisioned', saved.Provisioning_Status__c, 'Should be provisioned');
        Assert.areEqual('cert-ESP32-T1', saved.Certificate_Id__c, 'Certificate id is stored for audit');
        Assert.isNotNull(saved.Provisioning_Expires_At__c, 'Bundle link must carry an expiry');
        Assert.isFalse(saved.Provisioning_Bundle_Link__c.contains('PRIVATE KEY'),
            'Only a link is stored - never the private key itself');
        Assert.isTrue(saved.Provisioning_Bundle_Link__c.length() > 255,
            'The whole link is stored, longer than a URL field could hold');
    }

    // A callout these tests do not expect would not fail them on its own:
    // DeviceApiClient turns any callout exception, an unmocked callout's
    // included, into an answer of AWS being busy. So the tests below that
    // expect none set the mock anyway, and assert that it was never called.

    @IsTest
    static void deviceWithoutNetworkIsNotProvisioned() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Account patient = new Account(Name = 'Test Patient');
        insert patient;

        Test.startTest();
        insert new Asset(Name = 'ESP32-T2', SerialNumber = 'ESP32-T2',
                         AccountId = patient.Id, Status = 'Installed');
        Assert.areEqual(0, Limits.getQueueableJobs(), 'No provisioning job');
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'No callout');
        Asset saved = [SELECT Provisioning_Status__c FROM Asset WHERE SerialNumber = 'ESP32-T2'];
        Assert.areNotEqual('Provisioned', saved.Provisioning_Status__c,
            'A device with no network must not be provisioned');
    }

    @IsTest
    static void deletingAProvisionedDeviceTearsDownAws() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = newDevice('ESP32-T1');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        // Simulate the provisioned state the async callout would have written.
        update new Asset(Id = device.Id, Thing_ARN__c = 'arn:aws:iot:us-east-1:1:thing/ESP32-T1');

        Test.startTest();
        delete device;
        Test.stopTest();

        Assert.areEqual(1, aws.bodies.size(), 'One callout');
        Assert.areEqual('teardown-device', aws.paths[0], 'To the teardown route');
        Assert.areEqual(new List<Object>{ 'ESP32-T1' }, (List<Object>) aws.bodies[0].get('thingNames'),
            'The Thing torn down in full');
        Assert.areEqual(0, [SELECT COUNT() FROM Asset WHERE Id = :device.Id],
            'Asset is deleted');
    }

    @IsTest
    static void unprovisionedDeleteMakesNoCallout() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Account patient = new Account(Name = 'Test Patient');
        insert patient;
        Asset device = new Asset(Name = 'ESP32-T3', SerialNumber = 'ESP32-T3',
                                 AccountId = patient.Id, Status = 'Installed');
        insert device;

        Test.startTest();
        // A device that never had a Wi-Fi Network never reached AWS.
        delete device;
        Assert.areEqual(0, Limits.getQueueableJobs(), 'No teardown job');
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'No callout');
        Assert.areEqual(0, [SELECT COUNT() FROM Asset WHERE Id = :device.Id], 'Deleted');
    }

    @IsTest
    static void deletingACopyOfAProvisionedDeviceKeepsTheThingTheOriginalUses() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        String thingArn = 'arn:aws:iot:us-east-2:111122223333:thing/ESP32-C1';
        Asset original = newDevice('ESP32-C1');
        Asset copy = newDevice('ESP32-C1');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert new List<Asset>{ original, copy };
        // Cloning a record copies its Thing ARN too.
        update new List<Asset>{
            new Asset(Id = original.Id, Thing_ARN__c = thingArn, Provisioning_Status__c = 'Provisioned'),
            new Asset(Id = copy.Id, Thing_ARN__c = thingArn, Provisioning_Status__c = 'Provisioned')
        };
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        delete copy;
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'Nothing torn down: the original still uses that Thing');
    }

    @IsTest
    static void deletingADuplicateKeepsTheThingTheProvisionedDeviceUses() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset provisioned = newDevice('ESP32-D1');
        Asset duplicate = newDevice('ESP32-D1');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert new List<Asset>{ provisioned, duplicate };
        // The duplicate was refused, since the Thing already had a certificate.
        // While the provisioned device's certificate is being replaced, that
        // Thing has none, and is not what a failed attempt left.
        update new List<Asset>{
            new Asset(Id = provisioned.Id, Provisioning_Status__c = 'Provisioned',
                      Thing_ARN__c = 'arn:aws:iot:us-east-2:111122223333:thing/ESP32-D1'),
            new Asset(Id = duplicate.Id, Provisioning_Status__c = 'Failed')
        };
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        delete duplicate;
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'Nothing sent as a leftover: the provisioned device uses that Thing');
    }

    @IsTest
    static void deletingDevicesThatNeverFinishedProvisioningRemovesWhatTheyLeft() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset failed = newDevice('ESP32-F1');
        Asset pending = newDevice('ESP32-P1');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert new List<Asset>{ failed, pending };
        // One failed and then lost its Wi-Fi Network; the other is still
        // waiting for its first try.
        update new Asset(Id = failed.Id, Provisioning_Status__c = 'Failed', Wi_Fi_Network__c = null);
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        delete new List<Asset>{ failed, pending };
        Test.stopTest();

        Assert.areEqual(1, aws.bodies.size(), 'One callout for both');
        Assert.areEqual('teardown-device', aws.paths[0], 'To the teardown route');
        Assert.isNull(aws.bodies[0].get('thingNames'), 'Not torn down in full: they have no Thing ARN');
        List<Object> leftovers = (List<Object>) aws.bodies[0].get('leftoverThingNames');
        Assert.areEqual(2, leftovers.size(), 'Both, by serial number');
        Assert.isTrue(leftovers.contains('ESP32-F1') && leftovers.contains('ESP32-P1'), 'Named after their serial numbers');
    }

    @IsTest
    static void deletingAProvisionedDeviceTearsDownTheThingItsArnNames() {
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Asset device = newDevice('ESP32-OLD');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        // Provisioned as ESP32-OLD; its serial number was edited afterwards.
        update new Asset(Id = device.Id, SerialNumber = 'ESP32-NEW', Provisioning_Status__c = 'Provisioned',
                         Thing_ARN__c = 'arn:aws:iot:us-east-2:111122223333:thing/ESP32-OLD');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        delete device;
        Test.stopTest();

        Assert.areEqual(1, aws.bodies.size(), 'One callout');
        List<Object> thingNames = (List<Object>) aws.bodies[0].get('thingNames');
        Assert.areEqual(1, thingNames.size(), 'One Thing');
        Assert.areEqual('ESP32-OLD', thingNames[0], 'The Thing it was provisioned as, not its current serial number');
        Assert.isNull(aws.bodies[0].get('leftoverThingNames'), 'Torn down in full, certificate and all');
    }

    @IsTest
    static void undeleteClearsStaleAwsIdentifiers() {
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Asset device = newDevice('ESP32-T1');
        insert device;
        update new Asset(Id = device.Id, Thing_ARN__c = 'arn:aws:iot:us-east-1:1:thing/ESP32-T1',
                         Certificate_Id__c = 'cert-old', Provisioning_Status__c = 'Provisioned');
        delete device;

        Test.startTest();
        undelete device;
        Test.stopTest();

        Asset restored = [SELECT Thing_ARN__c, Certificate_Id__c, Provisioning_Status__c
                          FROM Asset WHERE Id = :device.Id];
        Assert.areNotEqual('cert-old', restored.Certificate_Id__c,
            'The old certificate was deleted in AWS, so its id must not persist');
    }

    @IsTest
    static void bulkDeleteCollectsEveryThingName() {
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Account patient = new Account(Name = 'Bulk Patient');
        insert patient;
        Wi_Fi_Network__c net = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert net;

        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < 50; i++) {
            devices.add(new Asset(Name = 'ESP32-B' + i, SerialNumber = 'ESP32-B' + i,
                                  AccountId = patient.Id, Status = 'Installed',
                                  Wi_Fi_Network__c = net.Id,
                                  Thing_ARN__c = 'arn:aws:iot:us-east-1:1:thing/ESP32-B' + i));
        }
        insert devices;

        Test.startTest();
        delete devices;
        Assert.areEqual(1, Limits.getQueueableJobs(),
            'One teardown job for the whole delete, not one per device');
        Test.stopTest();
    }

    @IsTest
    static void twoHundredDevicesInOneSaveAreAllProvisioned() {
        // One save of 200 used to mean 200 callouts in one @future: past 100
        // it threw a LimitException nothing could catch, and none of the 200
        // was provisioned or told why.
        DeviceTestSettings.use();
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Account patient = new Account(Name = 'Ward');
        insert patient;
        Wi_Fi_Network__c net = new Wi_Fi_Network__c(Name = 'Ward', SSID__c = 'ward-wifi');
        insert net;
        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < 200; i++) {
            devices.add(new Asset(Name = 'W-' + i, SerialNumber = 'W-' + i, AccountId = patient.Id,
                                  Status = 'Installed', Wi_Fi_Network__c = net.Id));
        }

        Test.startTest();
        insert devices;
        Test.stopTest();

        Assert.areEqual(20, aws.bodies.size(), '200 devices at Devices_Per_Callout__c = 10');
        Assert.areEqual(200, [SELECT COUNT() FROM Asset WHERE Provisioning_Status__c = 'Provisioned'],
            'Every device is provisioned');
    }

    @IsTest
    static void reprovisionButtonStartsOneJob() {
        DeviceTestSettings.use();
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Asset device = newDevice('ESP32-T4');
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        update new Asset(Id = device.Id, Thing_ARN__c = 'arn:aws:iot:ca-central-1:1:thing/ESP32-T4',
                         Certificate_Id__c = 'cert-old', Provisioning_Status__c = 'Provisioned');
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        DeviceProvisioningService.reprovision(new List<Id>{ device.Id });
        Assert.areEqual(1, Limits.getQueueableJobs(), 'One background job');
        Test.stopTest();

        Asset saved = [SELECT Certificate_Id__c, Provisioning_Status__c FROM Asset WHERE Id = :device.Id];
        Assert.areEqual('cert-ESP32-T4', saved.Certificate_Id__c, 'The certificate was replaced');
        Assert.areEqual('Provisioned', saved.Provisioning_Status__c, 'Provisioned');
    }
}
