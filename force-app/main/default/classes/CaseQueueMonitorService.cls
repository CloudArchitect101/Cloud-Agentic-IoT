/*
 * CaseQueueMonitorService.cls
 *
 * Watches Case queue depth and publishes a Platform Event whenever the number
 * of open cases in a monitored queue changes. ESP32 boards consume those
 * events (via AWS IoT Core, QUEUE_DEPTH) and spin while work is waiting.
 *
 * Which boards follow a queue:
 *
 *   - Every Internal Device board (DeviceRoles) follows the Internal Device
 *     Queue (Device_Platform_Setting__mdt.Internal_Device_Queue__c,
 *     Care_Team_Queue as shipped). Every open Case the queue owns counts,
 *     whichever device it is on, or none. Making a board internal is a change
 *     to its Asset's record type, not to metadata.
 *   - Device_Queue_Binding__mdt adds the rest: a binding watches its queue,
 *     says how depth maps to motor intensity (Full_Speed_Depth__c), and may
 *     name one more board (Device_Id__c). The binding of the Internal Device
 *     Queue sets the internal boards' Full_Speed_Depth__c too; without one
 *     they run at DEFAULT_FULL_SPEED_DEPTH.
 *
 * One event per queue. QueueDepthRelayQueueable, its subscriber, works out
 * which boards follow that queue and sends each its QUEUE_DEPTH.
 *
 * A board that was offline is sent the depth again when it comes back
 * (resyncAfterReconnect, from DeviceConnectionService), and a board whose
 * role changed is told at once (sendQueueStateTo, from DeviceRoles).
 *
 * Without sharing: whoever saves the Case, every open Case of the queue must
 * count, or the motor would stop while Cases still wait. It only counts and
 * publishes.
 *
 * Demonstrates: event-driven architecture, Platform Events, configuration-
 * driven integration design, agents/systems taking action on business state.
 */
public without sharing class CaseQueueMonitorService {

    /** Internal boards' Full_Speed_Depth__c when their queue has no binding. */
    @TestVisible
    private static final Decimal DEFAULT_FULL_SPEED_DEPTH = 5;

    /**
     * Recalculates open-case depth for any monitored queue touched by this
     * transaction and publishes a Queue_Depth_Change__e for each.
     *
     * @param ownerIdsTouchedByTransaction Case OwnerIds from the trigger; a mix of Users and Queues
     */
    // Called from the trigger with every OwnerId the transaction touched.
    // A trigger here is like a Django post_save/post_delete signal, except it
    // receives up to 200 records at once - so everything below works on
    // collections, never one record at a time.
    public static void refreshQueueDepthFor(Set<Id> ownerIdsTouchedByTransaction) {
        if (ownerIdsTouchedByTransaction == null || ownerIdsTouchedByTransaction.isEmpty()) {
            return;
        }

        // Polymorphic key: Case.OwnerId can point at a User OR a Group (a
        // queue is a Group with Type='Queue'). getSobjectType() on an Id tells
        // you which table it points to - there is no isinstance() here, the
        // 3-character Id prefix encodes the type.
        Set<Id> queueIdsTouchedByThisTransaction = new Set<Id>();
        for (Id ownerId : ownerIdsTouchedByTransaction) {
            if (ownerId != null && ownerId.getSobjectType() == Group.SObjectType) {
                queueIdsTouchedByThisTransaction.add(ownerId);
            }
        }
        if (queueIdsTouchedByThisTransaction.isEmpty()) {
            return;
        }

        Map<String, Device_Queue_Binding__mdt> bindingByQueueName = loadActiveDeviceQueueBindings();
        Set<String> monitored = new Set<String>(bindingByQueueName.keySet());
        String internalQueue = internalDeviceQueue();
        if (internalQueue != null) {
            monitored.add(internalQueue);
        }
        if (monitored.isEmpty()) {
            return;
        }

        Map<Id, Group> queuesById = new Map<Id, Group>([
            SELECT Id, DeveloperName
            FROM Group
            WHERE Type = 'Queue'
              AND Id IN :queueIdsTouchedByThisTransaction
              AND DeveloperName IN :monitored
        ]);
        if (queuesById.isEmpty()) {
            return;
        }

        Map<Id, Integer> openCaseCountByQueueId = countOpenCasesByQueueId(queuesById.keySet());

        List<Queue_Depth_Change__e> events = new List<Queue_Depth_Change__e>();
        for (Id queueId : queuesById.keySet()) {
            Group queue = queuesById.get(queueId);
            Device_Queue_Binding__mdt binding = bindingFor(bindingByQueueName, queue.DeveloperName);
            Integer openCount = openCaseCountByQueueId.get(queueId);
            // The one board the binding names, if any. The relay adds every
            // Internal Device board when this is their queue.
            String boundDevice = null;
            if (binding != null && String.isNotBlank(binding.Device_Id__c)) {
                boundDevice = binding.Device_Id__c;
            }

            events.add(new Queue_Depth_Change__e(
                Queue_Developer_Name__c = queue.DeveloperName,
                Device_Id__c            = boundDevice,
                Open_Case_Count__c      = openCount,
                Intensity__c            = scaleDepthToMotorIntensity(openCount, fullSpeedDepthOf(binding)),
                Motor_State__c          = openCount > 0 ? 'ACTIVE' : 'IDLE'
            ));
        }

        publishQueueDepthEvents(events);
    }

    /* ------------------------------------------------ internal boards */

    /**
     * The queue Internal Device boards follow, or null when the setting
     * cannot be read: a Case must save whatever happens here.
     */
    public static String internalDeviceQueue() {
        try {
            return DevicePlatformSettings.internalDeviceQueue();
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Internal Device Queue not read, so no internal board follows a queue: '
                + e.getMessage());
            return null;
        }
    }

    /** The intensity Internal Device boards run at for this many open Cases. */
    public static Integer internalIntensityFor(Integer openCount) {
        String queueName = internalDeviceQueue();
        Device_Queue_Binding__mdt binding = null;
        if (queueName != null) {
            binding = bindingFor(loadActiveDeviceQueueBindings(), queueName);
        }
        return scaleDepthToMotorIntensity(openCount, fullSpeedDepthOf(binding));
    }

    /**
     * DeviceConnectionService, once these Assets are saved Online: each
     * Internal Device board among them is sent the queue's depth now, since
     * a QUEUE_DEPTH published while it was away never reached it. Patient
     * devices are sent nothing. Never throws.
     */
    public static void resyncAfterReconnect(List<Asset> onlineDevices) {
        if (onlineDevices == null || onlineDevices.isEmpty()) {
            return;
        }
        List<Asset> internal = new List<Asset>();
        try {
            for (Asset device : onlineDevices) {
                if (DeviceRoles.isInternal(device)) {
                    internal.add(device);
                }
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Queue depth not sent again after reconnect: ' + e.getMessage());
            return;
        }
        sendQueueStateTo(internal);
    }

    /**
     * Tells each board where its queue motor should be now: an Internal
     * Device board the Internal Device Queue's depth, any other board 0 (the
     * motor stops). One Group query and one count for the lot, and one
     * Queueable for the callouts. Never throws.
     */
    public static void sendQueueStateTo(List<Asset> devices) {
        if (devices == null || devices.isEmpty()) {
            return;
        }
        try {
            QueueDepthRelayQueueable.enqueue(queueStateCommands(devices));
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Queue depth not sent to ' + devices.size() + ' device(s): ' + e.getMessage());
        }
    }

    private static List<QueueDepthRelayQueueable.DeviceQueueCommand> queueStateCommands(List<Asset> devices) {
        String queueName = internalDeviceQueue();
        Integer openCount = null;
        Integer intensity = 0;
        List<QueueDepthRelayQueueable.DeviceQueueCommand> commands = new List<QueueDepthRelayQueueable.DeviceQueueCommand>();
        Set<String> seen = new Set<String>();
        for (Asset device : devices) {
            String thingName = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
            if (thingName == null || !seen.add(thingName)) {
                continue;
            }
            if (DeviceRoles.isInternal(device) && queueName != null) {
                if (openCount == null) {
                    openCount = openCasesIn(queueName);
                    intensity = internalIntensityFor(openCount);
                }
                commands.add(QueueDepthRelayQueueable.command(thingName, queueName, openCount, intensity));
            } else {
                commands.add(QueueDepthRelayQueueable.command(thingName, queueName, 0, 0));
            }
        }
        return commands;
    }

    private static Integer openCasesIn(String queueName) {
        List<Group> queues = [SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = :queueName LIMIT 1];
        if (queues.isEmpty()) {
            System.debug(LoggingLevel.WARN, 'No queue named ' + queueName + ', so internal boards show 0 Cases');
            return 0;
        }
        return countOpenCasesByQueueId(new Set<Id>{ queues[0].Id }).get(queues[0].Id);
    }

    /* ------------------------------------------------------- shared */

    /**
     * Scales raw queue depth to a 0-100 intensity the device uses for speed.
     * Depth at or above the binding's Full_Speed_Depth__c pins to 100.
     */
    @TestVisible
    private static Integer scaleDepthToMotorIntensity(Integer openCount, Decimal fullSpeedDepth) {
        if (openCount == null || openCount <= 0) {
            return 0;
        }
        if (fullSpeedDepth == null || fullSpeedDepth <= 0) {
            return 100;
        }
        Decimal ratio = Decimal.valueOf(openCount) / fullSpeedDepth;
        return ratio >= 1 ? 100 : (ratio * 100).setScale(0, RoundingMode.HALF_UP).intValue();
    }

    private static Decimal fullSpeedDepthOf(Device_Queue_Binding__mdt binding) {
        if (binding == null || binding.Full_Speed_Depth__c == null) {
            return DEFAULT_FULL_SPEED_DEPTH;
        }
        return binding.Full_Speed_Depth__c;
    }

    // DeveloperNames are unique regardless of case, and an admin may type
    // one in either case.
    private static Device_Queue_Binding__mdt bindingFor(Map<String, Device_Queue_Binding__mdt> bindings, String queueName) {
        for (String name : bindings.keySet()) {
            if (name.equalsIgnoreCase(queueName)) {
                return bindings.get(name);
            }
        }
        return null;
    }

    /**
     * Custom metadata rows cannot be inserted by a test, so tests inject their
     * own bindings here rather than depending on what happens to be deployed.
     */
    @TestVisible
    private static List<Device_Queue_Binding__mdt> testBindingOverride;

    private static Map<String, Device_Queue_Binding__mdt> loadActiveDeviceQueueBindings() {
        List<Device_Queue_Binding__mdt> source = testBindingOverride != null
            ? testBindingOverride
            : Device_Queue_Binding__mdt.getAll().values();

        Map<String, Device_Queue_Binding__mdt> byQueueName =
            new Map<String, Device_Queue_Binding__mdt>();
        for (Device_Queue_Binding__mdt binding : source) {
            if (binding.Active__c == true && String.isNotBlank(binding.Queue_Developer_Name__c)) {
                byQueueName.put(binding.Queue_Developer_Name__c, binding);
            }
        }
        return byQueueName;
    }

    /**
     * Queues with zero open cases produce no AggregateResult row, so seed every
     * monitored queue at zero first — "the queue just emptied" is exactly the
     * event that has to reach the device.
     */
    private static Map<Id, Integer> countOpenCasesByQueueId(Set<Id> queueIds) {
        Map<Id, Integer> countByQueueId = new Map<Id, Integer>();
        for (Id queueId : queueIds) {
            countByQueueId.put(queueId, 0);
        }
        // SOQL aggregate - same shape as
        //   Case.objects.filter(...).values('owner').annotate(n=Count('id'))
        // in Django. The gotcha (documented above) is that zero-count groups
        // produce NO row at all, hence pre-seeding the map with zeros.
        for (AggregateResult row : [
            SELECT OwnerId ownerId, COUNT(Id) openCount
            FROM Case
            WHERE OwnerId IN :queueIds
              AND IsClosed = false
            GROUP BY OwnerId
        ]) {
            countByQueueId.put((Id) row.get('ownerId'), (Integer) row.get('openCount'));
        }
        return countByQueueId;
    }

    /** What the last publish sent, for tests. */
    @TestVisible
    private static List<Queue_Depth_Change__e> lastPublished;

    private static void publishQueueDepthEvents(List<Queue_Depth_Change__e> events) {
        if (events.isEmpty()) {
            return;
        }
        // EventBus.publish = producing to a topic (think Kafka/SNS). Fire and
        // forget: subscribers (the AWS relay, the LWC dashboard, an agent) are
        // invisible to this code, which is exactly why new consumers can be
        // added without touching it.
        lastPublished = events;
        List<Database.SaveResult> results = EventBus.publish(events);
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                for (Database.Error err : results[i].getErrors()) {
                    System.debug(LoggingLevel.ERROR,
                        'Queue_Depth_Change__e publish failed for '
                        + events[i].Queue_Developer_Name__c + ': ' + err.getMessage());
                }
            }
        }
    }
}
