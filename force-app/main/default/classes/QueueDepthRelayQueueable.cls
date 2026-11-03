/*
 * QueueDepthRelayQueueable.cls
 *
 * Relays Queue_Depth_Change__e events out to AWS, which republishes them to
 * the device's MQTT command topic on IoT Core.
 *
 * Platform Event triggers run asynchronously but still cannot make callouts
 * directly, so the relay hops through a Queueable. Auth is the Named
 * Credential in Device_Platform_Setting__mdt (AWS_IoT_Relay): no keys or
 * endpoints in code.
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

    /**
     * Sends the commands Commands_Per_Callout__c at a time. The relay used to
     * make one callout per device, so a Queue_Depth_Change__e batch with more
     * than 100 bound devices hit the callout limit and none of them moved.
     */
    public void execute(QueueableContext context) {
        DeviceApiClient api = new DeviceApiClient();
        Integer perCallout = DevicePlatformSettings.commandsPerCallout();
        Integer index = 0;
        while (index < deviceCommands.size() && api.canCall()) {
            List<DeviceQueueCommand> batch = new List<DeviceQueueCommand>();
            while (index < deviceCommands.size() && batch.size() < perCallout) {
                batch.add(deviceCommands[index]);
                index++;
            }
            send(api, batch);
        }
        if (index < deviceCommands.size()) {
            List<DeviceQueueCommand> rest = new List<DeviceQueueCommand>();
            for (Integer i = index; i < deviceCommands.size(); i++) {
                rest.add(deviceCommands[i]);
            }
            if (Test.isRunningTest()) {
                lastChainedJob = new QueueDepthRelayQueueable(rest);
            } else {
                System.enqueueJob(new QueueDepthRelayQueueable(rest));
            }
        }
    }

    @TestVisible
    private static QueueDepthRelayQueueable lastChainedJob;

    private static void send(DeviceApiClient api, List<DeviceQueueCommand> batch) {
        DeviceApiClient.Result result = api.post('queue-depth', new Map<String, Object>{ 'commands' => batch });
        // A device being unreachable must never roll back the Case change
        // that triggered it - log and move on. 207: some devices were not
        // reached, and the body says which.
        if (!result.succeeded() || result.statusCode == 207) {
            System.debug(LoggingLevel.ERROR, 'Queue depth relay to ' + batch.size()
                + ' device(s) was not fully delivered: ' + result.summary());
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

        if (!deviceCommands.isEmpty() && Limits.getLimitQueueableJobs() > Limits.getQueueableJobs()) {
            System.enqueueJob(new QueueDepthRelayQueueable(deviceCommands));
        }
    }
}
