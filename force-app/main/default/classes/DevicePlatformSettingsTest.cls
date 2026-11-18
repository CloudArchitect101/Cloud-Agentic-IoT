@IsTest
private class DevicePlatformSettingsTest {

    @IsTest
    static void theDeployedRecordHasEveryValueTheCodeNeeds() {
        // Reads the real Default record: a blank or zero value would only
        // otherwise surface as a failed callout in production.
        Device_Platform_Setting__mdt deployed = Device_Platform_Setting__mdt.getInstance(DevicePlatformSettings.RECORD_NAME);
        Assert.isNotNull(deployed, 'Device_Platform_Setting__mdt.Default must ship with the project');

        Assert.isTrue(DevicePlatformSettings.endpoint('provision-device').startsWith('callout:'), 'Named Credential endpoint');
        Assert.isTrue(DevicePlatformSettings.calloutTimeoutMillis() <= 120000, 'Salesforce allows at most 120 seconds per callout');
        Assert.isTrue(DevicePlatformSettings.calloutsPerJob() <= 100, 'Salesforce allows 100 callouts per transaction');
        Assert.isTrue(DevicePlatformSettings.devicesPerCallout() >= 1, 'At least one device per callout');
        Assert.isTrue(DevicePlatformSettings.retryDelayMinutes() <= 10, 'A queued job can wait at most 10 minutes');
        Assert.isTrue(DevicePlatformSettings.bundleTtlMinutes() >= 1, 'Bundle links must live for some time');
        Assert.isFalse(String.isBlank(DevicePlatformSettings.defaultThingGroup()), 'Default thing group');
        Assert.isTrue(deployed.At_Risk_Score__c < deployed.Critical_Score__c, 'AT_RISK comes before CRITICAL');
    }

    @IsTest
    static void endpointUsesTheConfiguredNamedCredential() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Named_Credential__c = 'Other_Relay';
        Assert.areEqual('callout:Other_Relay/queue-depth', DevicePlatformSettings.endpoint('queue-depth'), 'Endpoint');
    }

    @IsTest
    static void aNonsensicalValueFailsWithTheFieldName() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Devices_Per_Callout__c = 0;
        try {
            DevicePlatformSettings.devicesPerCallout();
            Assert.fail('Zero devices per callout must not be accepted');
        } catch (DevicePlatformSettings.SettingException expected) {
            Assert.isTrue(expected.getMessage().contains('Devices_Per_Callout__c'), 'Names the field: ' + expected.getMessage());
        }
    }

    @IsTest
    static void aRetryDelayPastTenMinutesIsRefused() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Retry_Delay_Minutes__c = 11;
        try {
            DevicePlatformSettings.retryDelayMinutes();
            Assert.fail('Salesforce cannot delay a queued job by more than 10 minutes');
        } catch (DevicePlatformSettings.SettingException expected) {
            Assert.isTrue(expected.getMessage().contains('Retry_Delay_Minutes__c'), expected.getMessage());
        }
    }
}
