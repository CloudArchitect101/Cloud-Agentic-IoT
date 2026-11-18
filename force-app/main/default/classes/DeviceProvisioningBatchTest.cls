@IsTest
private class DeviceProvisioningBatchTest {

    @IsTest
    static void provisionsWaitingDevicesAndLeavesTheRestAlone() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Sweep_Delay_Minutes__c = 0;
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);

        Account patient = TestAccounts.patient('Bulk Load');
        insert patient;
        Wi_Fi_Network__c network = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert network;
        List<Asset> devices = new List<Asset>();
        for (Integer i = 0; i < 30; i++) {
            devices.add(new Asset(Name = 'BL-' + i, SerialNumber = 'BL-' + i, AccountId = patient.Id,
                                  Status = 'Installed', Wi_Fi_Network__c = network.Id));
        }
        // Not waiting: one already provisioned, one that failed and needs a person.
        devices.add(new Asset(Name = 'BL-done', SerialNumber = 'BL-done', AccountId = patient.Id, Status = 'Installed',
                              Wi_Fi_Network__c = network.Id, Thing_ARN__c = 'arn:aws:iot:x:1:thing/BL-done',
                              Provisioning_Status__c = 'Provisioned'));
        devices.add(new Asset(Name = 'BL-failed', SerialNumber = 'BL-failed', AccountId = patient.Id, Status = 'Installed',
                              Wi_Fi_Network__c = network.Id, Provisioning_Status__c = 'Failed'));
        // The bulk-load path: triggers off while loading, as Integration
        // Control's Bypass All Triggers does for a migration user.
        TriggerHandler.bypass('AssetTriggerHandler');
        insert devices;
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        Database.executeBatch(new DeviceProvisioningBatch(), 200);
        Test.stopTest();

        Assert.areEqual(3, aws.bodies.size(), '30 waiting devices, 10 per callout');
        Assert.areEqual(31, [SELECT COUNT() FROM Asset WHERE Provisioning_Status__c = 'Provisioned'],
            'All 30 waiting devices, plus the one that already was');
        Assert.areEqual('Failed', [SELECT Provisioning_Status__c FROM Asset WHERE SerialNumber = 'BL-failed'].Provisioning_Status__c,
            'A failed device waits for a person, not for the sweep');
    }

    @IsTest
    static void aDeviceJustEditedIsLeftToItsOwnJob() {
        DeviceTestSettings.use();   // Sweep_Delay_Minutes__c = 15
        DeviceApiMock aws = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, aws);
        Account patient = TestAccounts.patient('Recent');
        insert patient;
        Wi_Fi_Network__c network = new Wi_Fi_Network__c(Name = 'Clinic', SSID__c = 'clinic-wifi');
        insert network;
        TriggerHandler.bypass('AssetTriggerHandler');
        insert new Asset(Name = 'NEW-1', SerialNumber = 'NEW-1', AccountId = patient.Id, Status = 'Installed',
                         Wi_Fi_Network__c = network.Id);
        TriggerHandler.clearBypass('AssetTriggerHandler');

        Test.startTest();
        Database.executeBatch(new DeviceProvisioningBatch(), 200);
        Test.stopTest();

        Assert.areEqual(0, aws.bodies.size(), 'Saved seconds ago: its trigger job owns it');
    }

    @IsTest
    static void canBeScheduled() {
        DeviceTestSettings.use();
        Test.startTest();
        Id jobId = System.schedule('Provision waiting devices (test)', '0 15 * * * ?', new DeviceProvisioningBatch());
        Test.stopTest();
        Assert.areEqual(1, [SELECT COUNT() FROM CronTrigger WHERE Id = :jobId], 'Scheduled');
        Assert.areEqual(500, DeviceProvisioningBatch.scopeSize(), 'Devices_Per_Callout__c x Callouts_Per_Job__c');
    }
}
