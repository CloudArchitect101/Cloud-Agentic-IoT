/*
 * DeviceConnectionService.cls
 *
 * Shows on a device's Asset whether its board is connected to AWS IoT now:
 * Connection_Status__c (Online or Offline), Connection_Since__c and
 * Last_Disconnect_Reason__c.
 *
 * AWS IoT announces every connect and disconnect on its lifecycle topics. The
 * device-presence Lambda collects them for a few seconds, keeps the newest
 * event per board, and calls this action once per batch as the integration
 * user. That is one API call and one update per batch, however many boards
 * changed in it, and no new records.
 *
 * Lifecycle events can arrive late, out of order and twice, so a change is
 * applied only when it is at least as new as what the Asset already shows:
 * an old disconnect never overwrites the connect that followed it.
 * Connection_Since__c keeps whole seconds, so two events within one second
 * apply in the order they arrive.
 *
 * Without sharing: a board's connection is a fact about its Thing, so every
 * Asset with that Thing ARN must show it, whoever owns the Asset and whatever
 * the integration user may see. Only Device_Integration may run this class.
 */
public without sharing class DeviceConnectionService {

    public static final String ONLINE = 'Online';
    public static final String OFFLINE = 'Offline';

    private static final String ASSET_HANDLER = 'AssetTriggerHandler';

    /** One connect or disconnect, as the device-presence Lambda sends it. */
    public class Change {
        @InvocableVariable(required=true label='Thing ARN')
        public String thingArn;

        @InvocableVariable(required=true label='Status' description='Online or Offline.')
        public String status;

        @InvocableVariable(required=true label='Changed At (ms)'
                           description='When AWS IoT saw the connect or disconnect, in milliseconds since 1970-01-01 UTC.')
        public Long changedAtMillis;

        @InvocableVariable(label='Disconnect Reason'
                           description='The reason AWS IoT gave for a disconnect, such as CONNECTION_LOST. Empty for Online.')
        public String disconnectReason;
    }

    /** What one Change did: how many Assets it updated, or why it updated none. */
    public class Outcome {
        @InvocableVariable public String thingArn;
        @InvocableVariable public Integer assetsUpdated;
        @InvocableVariable public String skipped;
    }

    /**
     * Applies each change to every Asset whose Thing ARN is exactly the
     * change's, and returns one Outcome per change, in order.
     *
     * A change that cannot apply is skipped, with the reason in its Outcome,
     * and never throws: an exception here would fail every board in the
     * batch, and AWS would send the whole batch again.
     */
    @InvocableMethod(label='Record Device Connection'
                     description='Sets Connection, Connection Since and Last Disconnect Reason on every Asset with the Thing ARN, unless the Asset already shows a newer event.'
                     category='Device Platform')
    public static List<Outcome> record(List<Change> changes) {
        List<Outcome> outcomes = new List<Outcome>();
        if (changes == null) {
            return outcomes;
        }
        Map<String, List<Asset>> assetsByThingArn = assetsFor(changes);

        // Each Asset is saved once, however many changes touch it, and each
        // change keeps the Ids of the Assets it changed, to count what saved.
        Map<Id, Asset> changedAssets = new Map<Id, Asset>();
        List<List<Id>> assetIdsByChange = new List<List<Id>>();

        for (Change change : changes) {
            Outcome outcome = new Outcome();
            outcome.thingArn = change == null ? null : change.thingArn;
            outcome.assetsUpdated = 0;
            outcomes.add(outcome);
            List<Id> assetIds = new List<Id>();
            assetIdsByChange.add(assetIds);

            outcome.skipped = problemWith(change);
            if (outcome.skipped != null) {
                continue;
            }
            List<Asset> devices = assetsByThingArn.get(change.thingArn);
            if (devices == null) {
                outcome.skipped = 'No Asset has this Thing ARN.';
                continue;
            }

            Datetime changedAt = Datetime.newInstance(change.changedAtMillis);
            Datetime newerShown = null;
            for (Asset device : devices) {
                if (device.Connection_Since__c != null && changedAt < device.Connection_Since__c) {
                    newerShown = device.Connection_Since__c;
                    continue;
                }
                apply(change, changedAt, device);
                changedAssets.put(device.Id, device);
                assetIds.add(device.Id);
            }
            if (assetIds.isEmpty()) {
                outcome.skipped = 'An older event: the Asset already shows one from '
                    + newerShown.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'') + '.';
            }
        }

        Map<Id, String> errorsById = save(changedAssets.values());
        for (Integer i = 0; i < outcomes.size(); i++) {
            for (Id assetId : assetIdsByChange[i]) {
                String error = errorsById.get(assetId);
                if (error == null) {
                    outcomes[i].assetsUpdated = outcomes[i].assetsUpdated + 1;
                } else {
                    outcomes[i].skipped = 'Not saved: ' + error;
                }
            }
        }
        return outcomes;
    }

    private static String problemWith(Change change) {
        if (change == null) {
            return 'An empty change.';
        }
        if (String.isBlank(change.thingArn)) {
            return 'No Thing ARN.';
        }
        // equals, not ==: Apex compares strings with == regardless of case,
        // and the picklist takes exactly these two values.
        if (!ONLINE.equals(change.status) && !OFFLINE.equals(change.status)) {
            return 'Status must be Online or Offline, not ' + change.status + '.';
        }
        if (change.changedAtMillis == null) {
            return 'No changedAtMillis, so this event cannot be ordered against the others.';
        }
        return null;
    }

    /**
     * The Assets each Thing ARN names, matched exactly. SOQL compares text
     * regardless of case, while AWS IoT Thing names are case-sensitive: Test7
     * and test7 are two boards. A Set or Map of Strings is case-sensitive, so
     * a change only ever reaches the Assets whose Thing ARN is exactly its own.
     */
    private static Map<String, List<Asset>> assetsFor(List<Change> changes) {
        Set<String> thingArns = new Set<String>();
        for (Change change : changes) {
            if (change != null && String.isNotBlank(change.thingArn)) {
                thingArns.add(change.thingArn);
            }
        }
        Map<String, List<Asset>> assetsByThingArn = new Map<String, List<Asset>>();
        if (thingArns.isEmpty()) {
            return assetsByThingArn;
        }
        // System mode, in a class without sharing: the integration user's own
        // access must not decide which Assets learn that their board is online.
        // Locked, because two device-presence calls can carry one board's
        // disconnect and reconnect at once: the second waits for the first to
        // save, then compares its change with what the first saved, so an
        // older change never lands last. A lock it cannot get in time fails
        // the call, and the Lambda sends the batch again.
        for (Asset device : [
            SELECT Id, Thing_ARN__c, Connection_Status__c, Connection_Since__c, Last_Disconnect_Reason__c
            FROM Asset
            WHERE Thing_ARN__c IN :thingArns
            WITH SYSTEM_MODE
            FOR UPDATE
        ]) {
            if (!thingArns.contains(device.Thing_ARN__c)) {
                continue;   // the same ARN in another case: another Thing
            }
            List<Asset> devices = assetsByThingArn.get(device.Thing_ARN__c);
            if (devices == null) {
                devices = new List<Asset>();
                assetsByThingArn.put(device.Thing_ARN__c, devices);
            }
            devices.add(device);
        }
        return assetsByThingArn;
    }

    // Changes the Asset in memory, so a later change to the same Thing in
    // this batch is compared with this one rather than with what was queried.
    private static void apply(Change change, Datetime changedAt, Asset device) {
        device.Connection_Status__c = change.status;
        device.Connection_Since__c = changedAt;
        // Online keeps the last reason: it still says why the board was away.
        if (OFFLINE.equals(change.status)) {
            device.Last_Disconnect_Reason__c = String.isBlank(change.disconnectReason)
                ? null : change.disconnectReason.abbreviate(80);
        }
    }

    /**
     * One update for the whole batch, and the error of each Asset it could
     * not save, by Id. The Asset trigger is bypassed around it: presence never
     * affects provisioning, so the trigger has nothing to do here.
     */
    private static Map<Id, String> save(List<Asset> devices) {
        Map<Id, String> errorsById = new Map<Id, String>();
        if (devices.isEmpty()) {
            return errorsById;
        }
        // Only the three connection fields are written. The Thing ARN was
        // queried too, and is left exactly as it is.
        List<Asset> rows = new List<Asset>();
        for (Asset device : devices) {
            rows.add(new Asset(
                Id                        = device.Id,
                Connection_Status__c      = device.Connection_Status__c,
                Connection_Since__c       = device.Connection_Since__c,
                Last_Disconnect_Reason__c = device.Last_Disconnect_Reason__c
            ));
        }

        // A caller, or the Integration_Control__c setting, may have bypassed
        // the handler already; that is left as it was found.
        Boolean bypassHere = !TriggerHandler.isBypassed(ASSET_HANDLER);
        if (bypassHere) {
            TriggerHandler.bypass(ASSET_HANDLER);
        }
        List<Database.SaveResult> saves;
        try {
            saves = Database.update(rows, false);
        } finally {
            if (bypassHere) {
                TriggerHandler.clearBypass(ASSET_HANDLER);
            }
        }

        for (Integer i = 0; i < saves.size(); i++) {
            if (!saves[i].isSuccess()) {
                String error = saves[i].getErrors()[0].getMessage();
                errorsById.put(rows[i].Id, error);
                System.debug(LoggingLevel.ERROR, 'Could not record the connection of ' + rows[i].Id + ': ' + error);
            }
        }
        return errorsById;
    }
}
