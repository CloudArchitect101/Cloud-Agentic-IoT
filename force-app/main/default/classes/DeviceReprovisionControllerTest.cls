@IsTest
private class DeviceReprovisionControllerTest {

    /** A device with its trigger kept out of the way, provisioned when a Thing ARN is given. */
    private static Asset device(String serial, String thingArn) {
        Account patient = TestAccounts.patient('Test Patient');
        insert patient;
        Wi_Fi_Network__c net = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert net;
        Asset device = new Asset(
            Name = serial, SerialNumber = serial, AccountId = patient.Id,
            Status = 'Installed', Wi_Fi_Network__c = net.Id
        );
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        if (thingArn != null) {
            update new Asset(Id = device.Id, Thing_ARN__c = thingArn,
                             Certificate_Id__c = 'cert-old', Provisioning_Status__c = 'Provisioned');
        }
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    private static String refusalFor(Id assetId) {
        try {
            DeviceReprovisionController.reprovision(assetId);
        } catch (AuraHandledException e) {
            return e.getMessage();
        }
        return null;
    }

    @IsTest
    static void provisionedDeviceGetsANewCertificate() {
        DeviceTestSettings.use();
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
        Asset device = device('ESP32-R1', 'arn:aws:iot:us-east-2:1:thing/ESP32-R1');

        Test.startTest();
        DeviceReprovisionController.reprovision(device.Id);
        Assert.areEqual(1, Limits.getQueueableJobs(), 'One background job');
        Test.stopTest();

        Asset saved = [SELECT Certificate_Id__c, Provisioning_Status__c, Thing_ARN__c FROM Asset WHERE Id = :device.Id];
        Assert.areEqual('cert-ESP32-R1', saved.Certificate_Id__c, 'The certificate was replaced');
        Assert.areEqual('Provisioned', saved.Provisioning_Status__c, 'Provisioned');
        Assert.areEqual('arn:aws:iot:us-east-2:1:thing/ESP32-R1', saved.Thing_ARN__c, 'Same Thing');
    }

    @IsTest
    static void neverProvisionedDeviceIsRefusedAtOnce() {
        Asset device = device('ESP32-R2', null);

        Test.startTest();
        String refusal = refusalFor(device.Id);
        Assert.areEqual(0, Limits.getQueueableJobs(), 'No background job');
        Test.stopTest();

        Assert.isNotNull(refusal, 'Refused');
        Assert.isTrue(refusal.contains('never provisioned'), refusal);
    }

    @IsTest
    static void aThingArnThatNamesAnotherThingIsRefusedAtOnce() {
        Asset device = device('ESP32-R4', 'arn:aws:iot:us-east-2:1:thing/ESP32-OTHER');

        Test.startTest();
        String refusal = refusalFor(device.Id);
        Assert.areEqual(0, Limits.getQueueableJobs(), 'No background job');
        Test.stopTest();

        Assert.isNotNull(refusal, 'Refused');
        Assert.isTrue(refusal.contains('ESP32-OTHER') && refusal.contains('ESP32-R4'), refusal);
    }

    @IsTest
    static void deletedDeviceIsRefused() {
        Asset device = device('ESP32-R3', null);
        TriggerHandler.bypass('AssetTriggerHandler');
        delete device;
        TriggerHandler.clearBypass('AssetTriggerHandler');

        String refusal = refusalFor(device.Id);

        Assert.isNotNull(refusal, 'Refused');
        Assert.isTrue(refusal.contains('no longer exists'), refusal);
    }
}
