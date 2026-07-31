/*
 * One trigger per object. Routing in the handler, logic in the service.
 */
trigger WiFiNetworkTrigger on Wi_Fi_Network__c (after update) {
    new WiFiNetworkTriggerHandler().run();
}
