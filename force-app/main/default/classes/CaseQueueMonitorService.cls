/*
 * CaseQueueMonitorService.cls
 *
 * Watches Case queue depth and publishes a Platform Event whenever the number
 * of open cases in a monitored queue changes. A physical ESP32 indicator
 * consumes those events (via AWS IoT Core) and spins while work is waiting.
 *
 * Which queues are watched, which device each drives, and how depth maps to
 * motor intensity are all configuration, not code — see the
 * Device_Queue_Binding__mdt custom metadata type. Adding a second device to a
 * second queue is a metadata record, not a deployment.
 *
 * Demonstrates: event-driven architecture, Platform Events, configuration-
 * driven integration design, agents/systems taking action on business state.
 */
public with sharing class CaseQueueMonitorService {

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
        Map<String, Device_Queue_Binding__mdt> bindingByQueueName = loadActiveDeviceQueueBindings();
        if (bindingByQueueName.isEmpty() || ownerIdsTouchedByTransaction == null || ownerIdsTouchedByTransaction.isEmpty()) {
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

        Map<Id, Group> queuesById = new Map<Id, Group>([
            SELECT Id, DeveloperName
            FROM Group
            WHERE Type = 'Queue'
              AND Id IN :queueIdsTouchedByThisTransaction
              AND DeveloperName IN :bindingByQueueName.keySet()
        ]);
        if (queuesById.isEmpty()) {
            return;
        }

        Map<Id, Integer> openCaseCountByQueueId = countOpenCasesByQueueId(queuesById.keySet());

        List<Queue_Depth_Change__e> events = new List<Queue_Depth_Change__e>();
        for (Id queueId : queuesById.keySet()) {
            Group queue = queuesById.get(queueId);
            Device_Queue_Binding__mdt binding = bindingByQueueName.get(queue.DeveloperName);
            Integer openCount = openCaseCountByQueueId.get(queueId);

            events.add(new Queue_Depth_Change__e(
                Queue_Developer_Name__c = queue.DeveloperName,
                Device_Id__c            = binding.Device_Id__c,
                Open_Case_Count__c      = openCount,
                Intensity__c            = scaleDepthToMotorIntensity(openCount, binding.Full_Speed_Depth__c),
                Motor_State__c          = openCount > 0 ? 'ACTIVE' : 'IDLE'
            ));
        }

        publishQueueDepthEvents(events);
    }

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

    private static void publishQueueDepthEvents(List<Queue_Depth_Change__e> events) {
        if (events.isEmpty()) {
            return;
        }
        // EventBus.publish = producing to a topic (think Kafka/SNS). Fire and
        // forget: subscribers (the AWS relay, the LWC dashboard, an agent) are
        // invisible to this code, which is exactly why new consumers can be
        // added without touching it.
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
