/*
 * VitalAlertCaseServiceTest.cls
 *
 * Covers Patient_Vital_Alert__e -> PatientVitalAlertTrigger ->
 * VitalAlertCaseService: a CRITICAL_VITALS alert opens one Case per device,
 * on its Asset and in the escalation queue; a warning, an unknown device,
 * an Internal Device and a device whose Case is still open get none.
 */
@IsTest
private class VitalAlertCaseServiceTest {

    private static final String QUEUE = 'VitalAlertTestQueue';

    @TestSetup
    static void queue() {
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Group caseQueue = new Group(Name = 'Vital Alert Test Queue', DeveloperName = QUEUE, Type = 'Queue');
            insert caseQueue;
            insert new QueueSobject(QueueId = caseQueue.Id, SobjectType = 'Case');
        }
    }

    private static void settings() {
        Device_Platform_Setting__mdt settings = DeviceTestSettings.use();
        settings.Escalation_Case_Queue__c = QUEUE;
        Test.setMock(HttpCalloutMock.class, new DeviceApiMock());
    }

    private static Asset device(String serial, Id recordTypeId) {
        Account patient = new Account(Name = 'Vital Alert Patient ' + serial);
        insert patient;
        Asset device = new Asset(Name = 'Device ' + serial, SerialNumber = serial, AccountId = patient.Id, Status = 'Installed');
        if (recordTypeId != null) {
            device.RecordTypeId = recordTypeId;
        }
        TriggerHandler.bypass('AssetTriggerHandler');
        insert device;
        TriggerHandler.clearBypass('AssetTriggerHandler');
        return device;
    }

    private static Patient_Vital_Alert__e alert(String deviceId, String alertType) {
        return new Patient_Vital_Alert__e(
            Patient_Device_Id__c = deviceId, Alert_Type__c = alertType, Patient_State__c = 'CRITICAL',
            Risk_Score__c = 90, Heart_Rate__c = 150, SpO2__c = 84, Temperature__c = 36.9,
            Message__c = 'CRITICAL: Patient device ' + deviceId + ' has abnormal vitals'
        );
    }

    private static void deliver(List<Patient_Vital_Alert__e> alerts) {
        Test.startTest();
        EventBus.publish(alerts);
        Test.getEventBus().deliver();
        Test.stopTest();
    }

    private static List<Case> casesOf(Id assetId) {
        return [SELECT Id, OwnerId, Origin, Priority, Subject, Description FROM Case WHERE AssetId = :assetId];
    }

    @IsTest
    static void aCriticalAlertOpensOneCaseOnTheAssetInTheQueue() {
        settings();
        Asset test8 = device('VitalTest8', null);

        deliver(new List<Patient_Vital_Alert__e>{ alert('VitalTest8', 'CRITICAL_VITALS'), alert('VitalTest8', 'CRITICAL_VITALS') });

        List<Case> cases = casesOf(test8.Id);
        System.assertEquals(1, cases.size(), 'two alerts in one batch make one Case');
        System.assertEquals(VitalAlertCaseService.ORIGIN, cases[0].Origin);
        System.assertEquals('High', cases[0].Priority);
        System.assertEquals('Critical vitals on VitalTest8', cases[0].Subject);
        System.assertEquals([SELECT Id FROM Group WHERE DeveloperName = :QUEUE].Id, cases[0].OwnerId);
        System.assert(cases[0].Description.contains('Risk score: 90'), cases[0].Description);
    }

    @IsTest
    static void aDeviceWithAnOpenVitalAlertCaseGetsNoSecondOne() {
        settings();
        Asset test8 = device('VitalTest8', null);
        insert new Case(AssetId = test8.Id, Origin = VitalAlertCaseService.ORIGIN, Subject = 'Earlier alert');

        deliver(new List<Patient_Vital_Alert__e>{ alert('VitalTest8', 'CRITICAL_VITALS') });

        System.assertEquals(1, casesOf(test8.Id).size());
    }

    @IsTest
    static void aWarningAnUnknownDeviceAndAnInternalDeviceOpenNothing() {
        settings();
        Asset patient = device('VitalTest8', null);
        Asset ward = device('VitalTest7', DeviceRoles.internalRecordTypeId());

        deliver(new List<Patient_Vital_Alert__e>{
            alert('VitalTest8', 'ABNORMAL_TREND'), alert('NoSuchDevice', 'CRITICAL_VITALS'), alert('VitalTest7', 'CRITICAL_VITALS')
        });

        System.assertEquals(0, casesOf(patient.Id).size(), 'a warning opens no Case');
        System.assertEquals(0, casesOf(ward.Id).size(), 'an Internal Device opens no Case');
        System.assertEquals(0, [SELECT COUNT() FROM Case WHERE Origin = :VitalAlertCaseService.ORIGIN]);
    }

    @IsTest
    static void nothingToDoCostsNothing() {
        VitalAlertCaseService.openCasesFor(null);
        VitalAlertCaseService.openCasesFor(new List<Patient_Vital_Alert__e>{ alert(null, 'CRITICAL_VITALS') });
        System.assertEquals(0, Limits.getQueries());
    }
}
