/*
 * WiFiNetworkTriggerHandler.cls
 *
 * Routes Wi-Fi Network changes to the credential push service.
 */
public with sharing class WiFiNetworkTriggerHandler extends TriggerHandler {

    protected override void handleAfterUpdate() {
        WiFiCredentialService.pushChangedCredentialsToDevices(
            (List<Wi_Fi_Network__c>) Trigger.new,
            (Map<Id, Wi_Fi_Network__c>) Trigger.oldMap
        );
    }
}
