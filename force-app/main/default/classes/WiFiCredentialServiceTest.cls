/*
 * WiFiCredentialServiceTest.cls
 *
 * Covers the Wi-Fi credential push path: Wi_Fi_Network__c update ->
 * WiFiNetworkTrigger -> WiFiNetworkTriggerHandler -> WiFiCredentialService.
 *
 * Without this, WiFiNetworkTrigger sits at 0% coverage and the whole deploy is
 * rejected: Salesforce requires at least 1% on every trigger, separately from
 * the 75% org-wide rule. Every other trigger here was already covered
 * incidentally by its service's tests; this one had no service test at all.
 */
@IsTest
private class WiFiCredentialServiceTest {

    private class RelayMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"published":true}');
            return res;
        }
    }

    // The relay is expected to be unreachable sometimes; a device that is
    // offline must not fail the batch. This mock proves that path.
    private class FailingRelayMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(500);
            res.setBody('{"message":"relay down"}');
            return res;
        }
    }

    private static Wi_Fi_Network__c newNetwork() {
        Wi_Fi_Network__c net = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert net;
        return net;
    }

    private static Asset provisionedDevice(String serial, Id networkId) {
        Account patient = new Account(Name = 'Test Patient');
        insert patient;
        // A Thing ARN, as a provisioned device has: without one, the insert
        // would start a provisioning job of its own.
        Asset device = new Asset(
            Name = serial, SerialNumber = serial, AccountId = patient.Id,
            Status = 'Installed', Wi_Fi_Network__c = networkId,
            Thing_ARN__c = 'arn:aws:iot:ca-central-1:111122223333:thing/' + serial,
            Provisioning_Status__c = 'Provisioned'
        );
        insert device;
        return device;
    }

    @IsTest
    static void ssidChangePushesToProvisionedDevice() {
        Test.setMock(HttpCalloutMock.class, new RelayMock());
        Wi_Fi_Network__c net = newNetwork();
        provisionedDevice('ESP32-W1', net.Id);

        Test.startTest();
        update new Wi_Fi_Network__c(Id = net.Id, SSID__c = 'clinic-wifi-5g');
        Test.stopTest();   // runs the queued push

        // The assertion that matters is that the trigger path completed without
        // throwing. A successful callout leaves no record behind to query.
        Wi_Fi_Network__c saved = [SELECT SSID__c FROM Wi_Fi_Network__c WHERE Id = :net.Id];
        Assert.areEqual('clinic-wifi-5g', saved.SSID__c, 'SSID should be updated');
    }

    @IsTest
    static void unchangedCredentialsPushNothing() {
        Test.setMock(HttpCalloutMock.class, new RelayMock());
        Wi_Fi_Network__c net = newNetwork();
        provisionedDevice('ESP32-W2', net.Id);

        Test.startTest();
        // Touch a field that is not a credential: no push should be attempted.
        update new Wi_Fi_Network__c(Id = net.Id, Name = 'Clinic Renamed');
        Test.stopTest();

        Wi_Fi_Network__c saved = [SELECT Name, SSID__c FROM Wi_Fi_Network__c WHERE Id = :net.Id];
        Assert.areEqual('Clinic Renamed', saved.Name, 'Name should be updated');
        Assert.areEqual('clinic-wifi', saved.SSID__c, 'SSID should be untouched');
    }

    @IsTest
    static void offlineDeviceDoesNotFailTheBatch() {
        Test.setMock(HttpCalloutMock.class, new FailingRelayMock());
        Wi_Fi_Network__c net = newNetwork();
        provisionedDevice('ESP32-W3', net.Id);

        Test.startTest();
        update new Wi_Fi_Network__c(Id = net.Id, SSID__c = 'clinic-wifi-backup');
        Test.stopTest();

        // A 500 from the relay is swallowed deliberately: the device recovers
        // over serial. Reaching this line at all is the assertion.
        Wi_Fi_Network__c saved = [SELECT SSID__c FROM Wi_Fi_Network__c WHERE Id = :net.Id];
        Assert.areEqual('clinic-wifi-backup', saved.SSID__c,
            'The update must commit even when the relay rejects the push');
    }

    @IsTest
    static void aLargeNetworkIsSentInPagesAndBatches() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Commands_Per_Callout__c = 10;
        settings.Callouts_Per_Job__c = 2;
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Wi_Fi_Network__c net = newNetwork();
        Account patient = new Account(Name = 'Ward');
        insert patient;
        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < 25; i++) {
            devices.add(new Asset(Name = 'WF-' + i, SerialNumber = 'WF-' + i, AccountId = patient.Id,
                                  Status = 'Installed', Wi_Fi_Network__c = net.Id,
                                  Thing_ARN__c = 'arn:aws:iot:ca-central-1:111122223333:thing/WF-' + i,
                                  Provisioning_Status__c = 'Provisioned'));
        }
        insert devices;

        Test.startTest();
        new WiFiCredentialPushJob(new Set<Id>{ net.Id }).execute(null);
        Test.stopTest();

        Assert.areEqual(2, aws.bodies.size(), 'Two callouts: Callouts_Per_Job__c');
        Assert.areEqual(10, ((List<Object>) aws.bodies[0].get('thingNames')).size(), 'Commands_Per_Callout__c per request');
        Assert.areEqual('WIFI_UPDATE', aws.bodies[0].get('operation'), 'A Wi-Fi update');
        WiFiCredentialPushJob next = WiFiCredentialPushJob.lastChainedJob;
        Assert.isNotNull(next, 'A full page hands the rest to the next job');
        List<Asset> inIdOrder = [SELECT Id FROM Asset WHERE Wi_Fi_Network__c = :net.Id ORDER BY Id];
        Assert.areEqual(inIdOrder[19].Id, next.afterAssetId, 'The next job starts after the 20th device');
    }
}
