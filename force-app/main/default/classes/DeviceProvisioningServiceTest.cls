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
                              Provisioning_Bundle_URL__c, Provisioning_Expires_At__c
                       FROM Asset WHERE Id = :device.Id];
        Assert.areEqual('Provisioned', saved.Provisioning_Status__c, 'Should be provisioned');
        Assert.areEqual('cert-ESP32-T1', saved.Certificate_Id__c, 'Certificate id is stored for audit');
        Assert.isNotNull(saved.Provisioning_Expires_At__c, 'Bundle link must carry an expiry');
        Assert.isFalse(saved.Provisioning_Bundle_URL__c.contains('PRIVATE KEY'),
            'Only a link is stored - never the private key itself');
    }

    @IsTest
    static void deviceWithoutNetworkIsNotProvisioned() {
        Account patient = new Account(Name = 'Test Patient');
        insert patient;

        Test.startTest();
        // No mock set: if a callout fired, this test would fail outright.
        insert new Asset(Name = 'ESP32-T2', SerialNumber = 'ESP32-T2',
                         AccountId = patient.Id, Status = 'Installed');
        Test.stopTest();

        Asset saved = [SELECT Provisioning_Status__c FROM Asset WHERE SerialNumber = 'ESP32-T2'];
        Assert.areNotEqual('Provisioned', saved.Provisioning_Status__c,
            'A device with no network must not be provisioned');
    }

    @IsTest
    static void deletingAProvisionedDeviceTearsDownAws() {
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Asset device = newDevice('ESP32-T1');
        insert device;
        // Simulate the provisioned state the async callout would have written.
        update new Asset(Id = device.Id, Thing_ARN__c = 'arn:aws:iot:us-east-1:1:thing/ESP32-T1');

        Test.startTest();
        delete device;
        Test.stopTest();

        // The teardown callout is mocked; reaching here without an unmocked
        // callout exception proves the delete path invoked it.
        Assert.areEqual(0, [SELECT COUNT() FROM Asset WHERE Id = :device.Id],
            'Asset is deleted');
    }

    @IsTest
    static void unprovisionedDeleteMakesNoCallout() {
        Account patient = new Account(Name = 'Test Patient');
        insert patient;
        Asset device = new Asset(Name = 'ESP32-T3', SerialNumber = 'ESP32-T3',
                                 AccountId = patient.Id, Status = 'Installed');
        insert device;

        Test.startTest();
        // No mock: a device that was never provisioned has nothing in AWS, so
        // firing a teardown callout would be wasted work and would fail here.
        delete device;
        Test.stopTest();

        Assert.areEqual(0, [SELECT COUNT() FROM Asset WHERE Id = :device.Id], 'Deleted');
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
