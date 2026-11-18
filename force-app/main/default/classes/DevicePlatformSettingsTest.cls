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

        // Where the Patient Care agent's Cases go, as the Default record ships it.
        Assert.areEqual('Agentforce', DevicePlatformSettings.escalationCaseOrigin(), 'Agent Case Origin');
        Assert.areEqual('Care_Team_Queue', DevicePlatformSettings.escalationCaseQueue(), 'Agent Case queue');

        // The room-temperature rule's settings, as the Default record ships them.
        Assert.areEqual('Room Temperature Rule', DevicePlatformSettings.roomTempCaseOrigin(), 'Room-temperature Case Origin');
        Assert.areEqual('Care_Team_Queue', DevicePlatformSettings.roomTempCaseQueue(), 'Room-temperature Case queue');
        Assert.isTrue(DevicePlatformSettings.roomTempDispense(), 'A new room-temperature Case requests a dose');
        Assert.areEqual(60, DevicePlatformSettings.roomTempDispenseCooldownMinutes(), 'Room-temperature dose cooldown');
    }

    @IsTest
    static void aBlankRoomTempOriginOrQueueIsRefused() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Room_Temp_Case_Origin__c = '';
        try {
            DevicePlatformSettings.roomTempCaseOrigin();
            Assert.fail('A blank Origin would make every Case look like the rule\'s own');
        } catch (DevicePlatformSettings.SettingException expected) {
            Assert.isTrue(expected.getMessage().contains('Room_Temp_Case_Origin__c'), expected.getMessage());
        }

        settings.Room_Temp_Case_Queue__c = ' ';
        try {
            DevicePlatformSettings.roomTempCaseQueue();
            Assert.fail('A blank queue name must not be accepted');
        } catch (DevicePlatformSettings.SettingException expected) {
            Assert.isTrue(expected.getMessage().contains('Room_Temp_Case_Queue__c'), expected.getMessage());
        }
    }

    @IsTest
    static void aBlankEscalationQueueIsRefused() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Escalation_Case_Queue__c = '';
        try {
            DevicePlatformSettings.escalationCaseQueue();
            Assert.fail('A blank queue name must not be accepted');
        } catch (DevicePlatformSettings.SettingException expected) {
            Assert.isTrue(expected.getMessage().contains('Escalation_Case_Queue__c'), expected.getMessage());
        }
    }

    @IsTest
    static void aZeroRoomTempCooldownIsRefused() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Room_Temp_Dispense_Cooldown_Minutes__c = 0;
        try {
            DevicePlatformSettings.roomTempDispenseCooldownMinutes();
            Assert.fail('A zero cooldown would let every new Case dose again');
        } catch (DevicePlatformSettings.SettingException expected) {
            Assert.isTrue(expected.getMessage().contains('Room_Temp_Dispense_Cooldown_Minutes__c'), expected.getMessage());
        }
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
