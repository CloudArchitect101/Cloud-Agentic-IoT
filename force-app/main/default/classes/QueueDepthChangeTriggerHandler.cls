/*
 * QueueDepthChangeTriggerHandler.cls
 *
 * Subscribes to Queue_Depth_Change__e and hands each batch to the relay.
 * Deliberately thin: an Agentforce agent, a Flow, or an LWC dashboard can
 * subscribe to the same event without this class knowing or changing.
 */
public with sharing class QueueDepthChangeTriggerHandler extends TriggerHandler {

    protected override void handleAfterInsert() {
        QueueDepthRelayQueueable.relayToDevices((List<Queue_Depth_Change__e>) Trigger.new);
    }
}
