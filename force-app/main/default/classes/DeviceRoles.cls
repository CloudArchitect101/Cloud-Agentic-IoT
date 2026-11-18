/*
 * DeviceRoles.cls
 *
 * What a board is for, read from its Asset's record type. Every board runs
 * the same patient-monitor firmware; Salesforce decides what it is told.
 *
 *   Patient_Device   A patient's board, on the patient's Account. Its
 *                    temperature readings feed the patient temperature alert,
 *                    which opens a Case. Its servo spins while its own
 *                    reading is 30 C or more (decided on the board), not for
 *                    Cases.
 *                    An Asset with no record type, which is every
 *                    Asset made before the record types existed, is one too.
 *   Internal_Device  A board of the ward itself, such as a nurse-station
 *                    indicator. Its servo turns while ANY open Case is owned
 *                    by the Internal Device Queue (Care_Team_Queue as shipped),
 *                    whichever device the Case is on, or none, and stops when
 *                    the queue is empty (CaseQueueMonitorService, QUEUE_DEPTH).
 *                    It gets no patient temperature Case.
 *                    Salesforce wants an Account or a Contact on every Asset,
 *                    so it sits on the ward's own Account, never a patient's.
 *
 * Changing an Asset's record type changes the role at once (rolesChanged):
 * a board that becomes internal takes the queue's depth, and one that becomes
 * a patient device stops following the queue.
 *
 * Without sharing: the queue relay runs as the Automated Process user, which
 * may see no Asset, and every internal board must still follow the queue.
 */
public without sharing class DeviceRoles {

    public static final String PATIENT_DEVICE = 'Patient_Device';
    public static final String INTERNAL_DEVICE = 'Internal_Device';

    /** At most this many internal boards follow the queue. A ward has a few. */
    @TestVisible
    private static final Integer MAX_INTERNAL_DEVICES = 2000;

    private static Map<String, Id> recordTypeIds;

    /** The Id of the Asset record type with this DeveloperName, or null when the org has none. */
    public static Id recordTypeId(String developerName) {
        if (recordTypeIds == null) {
            recordTypeIds = new Map<String, Id>();
            for (Schema.RecordTypeInfo info : Schema.SObjectType.Asset.getRecordTypeInfosByDeveloperName().values()) {
                recordTypeIds.put(info.getDeveloperName(), info.getRecordTypeId());
            }
        }
        return recordTypeIds.get(developerName);
    }

    public static Id internalRecordTypeId() {
        return recordTypeId(INTERNAL_DEVICE);
    }

    public static Id patientRecordTypeId() {
        return recordTypeId(PATIENT_DEVICE);
    }

    /**
     * Whether the Asset is an Internal Device. Anything else, no record type
     * included, is a patient device. The Asset must carry its RecordTypeId:
     * a query that reads Assets for this selects it.
     */
    public static Boolean isInternal(Asset device) {
        Id internal = internalRecordTypeId();
        return device != null && internal != null && device.RecordTypeId == internal;
    }

    /**
     * The Thing names of the internal boards that follow the queue: provisioned,
     * not revoked, and not known to be offline (one that is gets the depth
     * when it comes back, DeviceConnectionService). Sorted, so a batch always
     * goes in the same order.
     */
    public static List<String> followingThingNames() {
        Id internal = internalRecordTypeId();
        List<String> names = new List<String>();
        if (internal == null) {
            return names;
        }
        Set<String> seen = new Set<String>();
        // SOQL's != keeps the rows where the field is empty: a board whose
        // connection was never recorded still counts.
        for (Asset device : [
            SELECT Thing_ARN__c
            FROM Asset
            WHERE RecordTypeId = :internal
              AND Thing_ARN__c != null
              AND Provisioning_Status__c != 'Revoked'
              AND Connection_Status__c != 'Offline'
            ORDER BY Thing_ARN__c
            LIMIT :MAX_INTERNAL_DEVICES
        ]) {
            String thingName = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
            if (thingName != null && seen.add(thingName)) {
                names.add(thingName);
            }
        }
        return names;
    }

    /**
     * Asset after update. A device whose role changed is told at once: it is
     * sent the queue's depth (internal) or a stop (patient device). Never
     * throws; the service logs what fails.
     */
    public static void rolesChanged(List<Asset> devices, Map<Id, Asset> before) {
        if (devices == null || before == null) {
            return;
        }
        List<Asset> changed = new List<Asset>();
        for (Asset device : devices) {
            Asset previous = before.get(device.Id);
            if (previous != null && isInternal(device) != isInternal(previous)) {
                changed.add(device);
            }
        }
        if (changed.isEmpty()) {
            return;
        }
        CaseQueueMonitorService.sendQueueStateTo(changed);
    }
}
