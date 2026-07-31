/*
 * QueueDepthRelayQueueable.cls
 *
 * Relays Queue_Depth_Change__e events out to AWS, which republishes them to
 * the device's MQTT command topic on IoT Core.
 *
 * Platform Event triggers run asynchronously but still cannot make callouts
 * directly, so the relay hops through a Queueable. Auth is a Named Credential
 * (AWS_IoT_Relay) — no keys or endpoints in code.
 *
 * Demonstrates: REST integration, OAuth/Named Credential auth, async Apex,
 * bridging Salesforce business events to external systems.
 */
public with sharing class QueueDepthRelayQueueable implements Queueable, Database.AllowsCallouts {

    private final List<DeviceQueueCommand> deviceCommands;

    public class DeviceQueueCommand {
        public String deviceId;
        public String queueDeveloperName;
        public Integer openCaseCount;
        public Integer intensity;
        public String motorState;
    }

    public QueueDepthRelayQueueable(List<DeviceQueueCommand> deviceCommands) {
        this.deviceCommands = deviceCommands;
    }

    public void execute(QueueableContext context) {
        for (DeviceQueueCommand deviceCommand : deviceCommands) {
            sendCommandToDevice(deviceCommand);
        }
    }

    private void send(Payload payload) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint('callout:AWS_IoT_Relay/queue-depth');
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setTimeout(10000);
        request.setBody(JSON.serialize(payload));

        try {
            HttpResponse response = new Http().send(request);
            if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
                System.debug(LoggingLevel.ERROR,
                    'Queue depth relay failed for device ' + deviceCommand.deviceId
                    + ' (HTTP ' + response.getStatusCode() + '): ' + response.getBody());
            }
        } catch (Exception e) {
            // A device being unreachable must never roll back the Case change
            // that triggered it — log and move on.
            System.debug(LoggingLevel.ERROR,
                'Queue depth relay threw for device ' + deviceCommand.deviceId + ': ' + e.getMessage());
        }
    }

    /**
     * Builds relay payloads from published events and enqueues the callout.
     */
    public static void relayToDevices(List<Queue_Depth_Change__e> events) {
        List<DeviceQueueCommand> deviceCommands = new List<DeviceQueueCommand>();
        for (Queue_Depth_Change__e event : events) {
            DeviceQueueCommand deviceCommand = new DeviceQueueCommand();
            deviceCommand.deviceId           = event.Device_Id__c;
            deviceCommand.queueDeveloperName = event.Queue_Developer_Name__c;
            deviceCommand.openCaseCount      = Integer.valueOf(event.Open_Case_Count__c);
            deviceCommand.intensity          = Integer.valueOf(event.Intensity__c);
            deviceCommand.motorState         = event.Motor_State__c;
            deviceCommands.add(deviceCommand);
        }

        if (!deviceCommands.isEmpty() && !System.isFuture() && Limits.getLimitQueueableJobs() > Limits.getQueueableJobs()) {
            System.enqueueJob(new QueueDepthRelayQueueable(deviceCommands));
        }
    }
}
