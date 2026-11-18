/*
 * QueueDepthRelayQueueable.cls
 *
 * Relays Queue_Depth_Change__e events out to AWS, which republishes them to
 * each board's MQTT command topic on IoT Core as QUEUE_DEPTH.
 *
 * One event per queue. The boards that follow it are the one its binding
 * names (Device_Id__c, when set) and, for the Internal Device Queue, every
 * Internal Device board (DeviceRoles.followingThingNames). When one batch
 * holds several events for a queue, only the newest is sent: the depth is a
 * state, and two in flight could arrive in either order.
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
        // The newest event of each queue: events arrive in publish order.
        Map<String, Queue_Depth_Change__e> newestByQueue = new Map<String, Queue_Depth_Change__e>();
        for (Queue_Depth_Change__e event : events) {
            String queueKey = event.Queue_Developer_Name__c == null ? '' : event.Queue_Developer_Name__c.toLowerCase();
            newestByQueue.put(queueKey, event);
        }

        String internalQueue = CaseQueueMonitorService.internalDeviceQueue();
        List<String> internalBoards = null;
        List<DeviceQueueCommand> deviceCommands = new List<DeviceQueueCommand>();
        for (Queue_Depth_Change__e event : newestByQueue.values()) {
            Set<String> boards = new Set<String>();
            if (String.isNotBlank(event.Device_Id__c)) {
                boards.add(event.Device_Id__c);
            }
            if (internalQueue != null && internalQueue.equalsIgnoreCase(event.Queue_Developer_Name__c)) {
                if (internalBoards == null) {
                    internalBoards = DeviceRoles.followingThingNames();
                }
                boards.addAll(internalBoards);
            }
            for (String board : boards) {
                DeviceQueueCommand deviceCommand = command(board, event.Queue_Developer_Name__c,
                    event.Open_Case_Count__c == null ? 0 : event.Open_Case_Count__c.intValue(),
                    event.Intensity__c == null ? 0 : event.Intensity__c.intValue());
                deviceCommand.motorState = event.Motor_State__c;
                deviceCommands.add(deviceCommand);
            }
        }
        enqueue(deviceCommands);
    }

    /** One board's QUEUE_DEPTH. */
    public static DeviceQueueCommand command(String deviceId, String queueDeveloperName, Integer openCaseCount, Integer intensity) {
        DeviceQueueCommand deviceCommand = new DeviceQueueCommand();
        deviceCommand.deviceId           = deviceId;
        deviceCommand.queueDeveloperName = queueDeveloperName;
        deviceCommand.openCaseCount      = openCaseCount;
        deviceCommand.intensity          = intensity;
        deviceCommand.motorState         = intensity > 0 ? 'ACTIVE' : 'IDLE';
        return deviceCommand;
    }

    /**
     * Starts the job that sends these, when there are any and the
     * transaction has a Queueable left; otherwise logs what was not sent.
     */
    public static void enqueue(List<DeviceQueueCommand> deviceCommands) {
        if (deviceCommands == null || deviceCommands.isEmpty()) {
            return;
        }
        if (Limits.getLimitQueueableJobs() > Limits.getQueueableJobs()) {
            System.enqueueJob(new QueueDepthRelayQueueable(deviceCommands));
        } else {
            System.debug(LoggingLevel.ERROR, 'No Queueable left in this transaction: queue depth not sent to '
                + deviceCommands.size() + ' device(s)');
        }
    }
}
