/*
 * One trigger per object. Routing lives in the handler, logic in the relay.
 */
trigger QueueDepthChangeTrigger on Queue_Depth_Change__e (after insert) {
    new QueueDepthChangeTriggerHandler().run();
}
