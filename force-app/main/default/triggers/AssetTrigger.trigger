/*
 * One trigger per object. Context routing lives in the handler, business
 * logic in the service - see TriggerHandler.
 */
trigger AssetTrigger on Asset (after insert, after update, after delete, after undelete) {
    new AssetTriggerHandler().run();
}
