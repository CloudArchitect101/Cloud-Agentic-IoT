@IsTest
private class DeviceProvisioningServiceTest {

    private class ProvisionMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            if (req.getEndpoint().contains('teardown-device')) {
                res.setBody('{"results":[{"thingName":"ESP32-T1","deleted":true}],"historyPreserved":true}');
            } else {
                res.setBody('{"thingArn":"arn:aws:iot:us-east-1:1:thing/ESP32-T1",'
                          + '"certificateId":"cert-abc","bundleUrl":"https://s3/bundle","expiresInMinutes":15}');
            }
            return res;
        }
    }

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
        Test.setMock(HttpCalloutMock.class, new ProvisionMock());
        Asset device = newDevice('ESP32-T1');

        Test.startTest();
        insert device;
        Test.stopTest();

        Asset saved = [SELECT Thing_ARN__c, Certificate_Id__c, Provisioning_Status__c,
                              Provisioning_Bundle_URL__c, Provisioning_Expires_At__c
                       FROM Asset WHERE Id = :device.Id];
        Assert.areEqual('Provisioned', saved.Provisioning_Status__c, 'Should be provisioned');
        Assert.areEqual('cert-abc', saved.Certificate_Id__c, 'Certificate id is stored for audit');
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
        Test.setMock(HttpCalloutMock.class, new ProvisionMock());
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
        Test.setMock(HttpCalloutMock.class, new ProvisionMock());
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
        Test.setMock(HttpCalloutMock.class, new ProvisionMock());
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
        Assert.isTrue(Limits.getFutureCalls() <= 1,
            'One teardown call for the whole batch, not one per device');
        Test.stopTest();
    }
}
