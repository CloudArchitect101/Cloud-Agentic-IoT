/*
 * DeviceProvisioningJob.cls
 *
 * Provisions, re-provisions or tears down devices in AWS, in the background,
 * for any number of devices at once.
 *
 * The code this replaces made one callout per device inside one @future. A
 * transaction may make 100 callouts, so the 101st device in a single save
 * threw a LimitException, which cannot be caught: every device in that save
 * stayed unprovisioned and nothing said why. This job instead
 *
 *   - sends Devices_Per_Callout__c devices in each request,
 *   - stops while it is still inside Salesforce's callout limits (and
 *     Callouts_Per_Job__c) and hands the rest to a new job,
 *   - tries a device again Retry_Delay_Minutes__c later when AWS was busy
 *     (HTTP 429 or 5xx, or no answer), up to Max_Callout_Attempts__c times in
 *     all, and only then marks it Failed, with the reason in
 *     Provisioning_Error__c.
 *
 * Every one of those numbers is in Device_Platform_Setting__mdt.
 *
 * DeviceProvisioningBatch runs the same work over every device still waiting,
 * which is how a bulk load of devices is provisioned.
 */
public with sharing class DeviceProvisioningJob implements Queueable, Database.AllowsCallouts {

    // TEARDOWN removes provisioned devices: their certificates, then their
    // Things. TEARDOWN_LEFTOVER is for deleted devices that never got a Thing
    // ARN: AWS deletes the Thing named after the serial number only while it
    // has no certificate and is in no Thing Group, and keeps any other. Both
    // keep, without a callout, a Thing a remaining Asset still uses (see
    // ThingsInUse).
    public enum Action { PROVISION, REPROVISION, TEARDOWN, TEARDOWN_LEFTOVER }

    private static final Map<Action, String> PATH_BY_ACTION = new Map<Action, String>{
        Action.PROVISION         => 'provision-device',
        Action.REPROVISION       => 'reprovision-device',
        Action.TEARDOWN          => 'teardown-device',
        Action.TEARDOWN_LEFTOVER => 'teardown-device'
    };

    // How many Thing names one ThingsInUse query asks about.
    private static final Integer THING_NAMES_PER_QUERY = 50;

    @TestVisible
    private final Action kind;

    // Asset Ids for PROVISION and REPROVISION. Thing names for the two
    // teardowns: by the time they run the Assets are deleted, so there is
    // nothing to query.
    @TestVisible
    private final List<String> keys;

    // How many times each key has already been tried and found AWS busy.
    @TestVisible
    private final Map<String, Integer> attemptsByKey;

    // A test cannot chain one job to another, so in a test the job that would
    // have been started is kept here for the test to inspect.
    @TestVisible
    private static DeviceProvisioningJob lastChainedJob;
    @TestVisible
    private static Integer lastChainDelayMinutes;

    public DeviceProvisioningJob(Action kind, List<String> keys) {
        this(kind, keys, new Map<String, Integer>());
    }

    @TestVisible
    private DeviceProvisioningJob(Action kind, List<String> keys, Map<String, Integer> attemptsByKey) {
        this.kind = kind;
        this.keys = keys == null ? new List<String>() : keys;
        this.attemptsByKey = attemptsByKey == null ? new Map<String, Integer>() : attemptsByKey;
    }

    /**
     * Starts one job for all of these devices. Returns null, and logs, when
     * this transaction has no background job left to start: the devices then
     * stay Not Provisioned, where DeviceProvisioningBatch finds them.
     */
    public static Id start(Action kind, List<String> keys) {
        if (keys == null || keys.isEmpty()) {
            return null;
        }
        if (Limits.getQueueableJobs() >= Limits.getLimitQueueableJobs()) {
            System.debug(LoggingLevel.ERROR, 'No background job left in this transaction for '
                + kind + ' of ' + keys.size() + ' device(s): ' + String.join(keys, ', ').abbreviate(500));
            return null;
        }
        return System.enqueueJob(new DeviceProvisioningJob(kind, keys));
    }

    public void execute(QueueableContext context) {
        Run run = process(kind, keys);

        // Devices this job had no room for go first; devices AWS was busy for
        // go last, so a retry never holds up work that has not been tried.
        List<String> nextKeys = new List<String>(run.notReached);
        Map<String, Integer> nextAttempts = new Map<String, Integer>();
        for (String key : run.notReached) {
            if (attemptsByKey.containsKey(key)) {
                nextAttempts.put(key, attemptsByKey.get(key));
            }
        }
        Integer maxAttempts = DevicePlatformSettings.maxCalloutAttempts();
        Boolean retrying = false;
        for (String key : run.busy) {
            Integer attempts = (attemptsByKey.containsKey(key) ? attemptsByKey.get(key) : 0) + 1;
            if (attempts >= maxAttempts) {
                run.fail(key, 'AWS was busy on all ' + attempts + ' attempts. Last answer: ' + run.busyReasonByKey.get(key));
            } else {
                nextKeys.add(key);
                nextAttempts.put(key, attempts);
                retrying = true;
            }
        }
        run.save();

        if (!nextKeys.isEmpty()) {
            // Only retries left: wait, so a throttled AWS account gets room to
            // recover instead of being hit again at once.
            Integer delayMinutes = run.notReached.isEmpty() && retrying
                ? DevicePlatformSettings.retryDelayMinutes() : 0;
            chain(new DeviceProvisioningJob(kind, nextKeys, nextAttempts), delayMinutes);
        }
    }

    /**
     * Does as much of the work as fits in this transaction, and says what is
     * left. Saving the outcome is left to the caller (run.save()), so a caller
     * can decide what to do with devices that were not reached.
     */
    public static Run process(Action kind, List<String> keys) {
        Run run = new Run(kind);
        if (isTeardown(kind)) {
            keys = run.withoutThingsStillInUse(keys);
        }
        DeviceApiClient api = new DeviceApiClient();
        Integer perCallout = DevicePlatformSettings.devicesPerCallout();
        Map<String, Asset> assetsByKey = isTeardown(kind) ? null : loadAssets(keys);

        Integer index = 0;
        while (index < keys.size() && api.canCall()) {
            List<String> batch = new List<String>();
            while (index < keys.size() && batch.size() < perCallout) {
                batch.add(keys[index]);
                index++;
            }
            run.send(api, batch, assetsByKey);
        }
        while (index < keys.size()) {
            run.notReached.add(keys[index]);
            index++;
        }
        return run;
    }

    private static Map<String, Asset> loadAssets(List<String> assetIds) {
        Map<String, Asset> byKey = new Map<String, Asset>();
        for (Asset device : [
            SELECT Id, SerialNumber, Thing_ARN__c, Thing_Group__c, Wi_Fi_Network__c,
                   Wi_Fi_Network__r.SSID__c, Wi_Fi_Network__r.Passphrase__c
            FROM Asset
            WHERE Id IN :assetIds
        ]) {
            byKey.put(String.valueOf(device.Id), device);
        }
        return byKey;
    }

    private static Boolean isTeardown(Action kind) {
        return kind == Action.TEARDOWN || kind == Action.TEARDOWN_LEFTOVER;
    }

    /**
     * The Thing names, in lower case, that a remaining Asset still uses.
     *
     * An Asset whose Thing ARN names the Thing holds it, for example a copy
     * of the deleted record with the Thing ARN copied. For a leftover, an
     * Asset with that serial number counts too: nothing stops two records
     * sharing one, and its own provisioning may be using that Thing. Not for
     * a full teardown: that Thing still has the deleted device's certificate,
     * and provisioning never hands a Thing with a certificate to another
     * record, so keeping it would leave a retired device able to connect.
     *
     * Deleted records are in the Recycle Bin, which queries leave out, and a
     * restored one counts again. Without sharing, since an Asset this user
     * cannot see uses its Thing all the same. Asked in the job, not the
     * trigger: on a large Asset table a trigger may not run a query like
     * this. Case is ignored, which can only keep more Things, never delete
     * more.
     *
     * SOQL documents a list bind for IN but not for LIKE, so each Thing ARN
     * pattern gets a bind of its own, THING_NAMES_PER_QUERY names to a query
     * so that no WHERE clause grows long. A LIKE wildcard in a name, such as
     * an underscore, can only match more Assets, and only the names those
     * Assets really use are kept.
     */
    private without sharing class ThingsInUse {
        public Set<String> among(List<String> thingNames, Boolean bySerialNumberToo) {
            Set<String> inUse = new Set<String>();
            for (Integer first = 0; first < thingNames.size(); first += THING_NAMES_PER_QUERY) {
                List<String> names = new List<String>();
                List<String> matches = new List<String>();
                Map<String, Object> binds = new Map<String, Object>();
                for (Integer i = first; i < Math.min(first + THING_NAMES_PER_QUERY, thingNames.size()); i++) {
                    names.add(thingNames[i]);
                    binds.put('arn' + i, '%:thing/' + thingNames[i]);
                    matches.add('Thing_ARN__c LIKE :arn' + i);
                }
                if (bySerialNumberToo) {
                    binds.put('names', names);
                    matches.add('SerialNumber IN :names');
                }
                List<Asset> devices = Database.queryWithBinds(
                    'SELECT SerialNumber, Thing_ARN__c FROM Asset WHERE ' + String.join(matches, ' OR '),
                    binds, AccessLevel.SYSTEM_MODE);
                for (Asset device : devices) {
                    if (bySerialNumberToo && String.isNotBlank(device.SerialNumber)) {
                        inUse.add(device.SerialNumber.toLowerCase());
                    }
                    String provisionedAs = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
                    if (provisionedAs != null) {
                        inUse.add(provisionedAs.toLowerCase());
                    }
                }
            }
            return inUse;
        }
    }

    private static void chain(DeviceProvisioningJob next, Integer delayMinutes) {
        if (Test.isRunningTest()) {
            lastChainedJob = next;
            lastChainDelayMinutes = delayMinutes;
            return;
        }
        try {
            if (delayMinutes > 0) {
                System.enqueueJob(next, delayMinutes);
            } else {
                System.enqueueJob(next);
            }
        } catch (AsyncException e) {
            // Developer Edition and trial orgs stop a chain at five jobs. What
            // is left stays Not Provisioned for DeviceProvisioningBatch; a
            // teardown that is left is logged, since nothing else holds it.
            System.debug(LoggingLevel.ERROR, 'Could not continue ' + next.kind + ' for '
                + next.keys.size() + ' device(s) (' + e.getMessage() + '): '
                + String.join(next.keys, ', ').abbreviate(500));
        }
    }

    /** What one transaction's worth of callouts achieved, and what it left. */
    public class Run {
        private final Action kind;
        private final Integer bundleTtlMinutes;
        private final String defaultThingGroup;

        /** Keys this transaction had no callout left for. */
        public final List<String> notReached = new List<String>();
        /** Keys AWS was too busy for. */
        public final List<String> busy = new List<String>();
        public final Map<String, String> busyReasonByKey = new Map<String, String>();
        /** Assets to update, by Id. Empty for the teardowns. */
        public final Map<String, Asset> outcomeByKey = new Map<String, Asset>();
        public Integer succeeded = 0;
        public Integer failed = 0;

        Run(Action kind) {
            this.kind = kind;
            this.bundleTtlMinutes = DevicePlatformSettings.bundleTtlMinutes();
            this.defaultThingGroup = DevicePlatformSettings.defaultThingGroup();
        }

        /**
         * The Thing names no remaining Asset uses. The others are kept in
         * AWS, since tearing one down would take the identity of the device
         * that uses it, and they count as done.
         */
        List<String> withoutThingsStillInUse(List<String> thingNames) {
            Set<String> inUse = new ThingsInUse().among(thingNames, kind == Action.TEARDOWN_LEFTOVER);
            List<String> free = new List<String>();
            for (String thingName : thingNames) {
                if (!inUse.contains(thingName.toLowerCase())) {
                    free.add(thingName);
                    continue;
                }
                succeeded++;
                System.debug(kind == Action.TEARDOWN ? LoggingLevel.WARN : LoggingLevel.INFO,
                    'Kept in AWS: a remaining Asset still uses ' + thingName + '.');
            }
            return free;
        }

        void send(DeviceApiClient api, List<String> batch, Map<String, Asset> assetsByKey) {
            Map<String, String> keyByThingName = new Map<String, String>();
            List<Map<String, Object>> devices = new List<Map<String, Object>>();

            for (String key : batch) {
                if (isTeardown(kind)) {
                    keyByThingName.put(key, key);
                    continue;
                }
                Asset device = assetsByKey.get(key);
                if (device == null) {
                    continue;   // deleted since the job was queued: nothing to do
                }
                if (kind == Action.PROVISION && String.isNotBlank(device.Thing_ARN__c)) {
                    continue;   // provisioned meanwhile, by another job or the batch
                }
                String problem = problemWith(device);
                if (problem == null && keyByThingName.containsKey(device.SerialNumber)) {
                    problem = 'Another device in the same request has Serial Number ' + device.SerialNumber + '.';
                }
                if (problem != null) {
                    fail(key, problem);
                    continue;
                }
                keyByThingName.put(device.SerialNumber, key);
                devices.add(requestFor(device));
            }
            if (keyByThingName.isEmpty()) {
                return;
            }

            Map<String, Object> body;
            if (kind == Action.TEARDOWN) {
                body = new Map<String, Object>{ 'thingNames' => new List<String>(keyByThingName.keySet()) };
            } else if (kind == Action.TEARDOWN_LEFTOVER) {
                body = new Map<String, Object>{ 'leftoverThingNames' => new List<String>(keyByThingName.keySet()) };
            } else {
                body = new Map<String, Object>{ 'devices' => devices, 'ttlMinutes' => bundleTtlMinutes };
            }
            DeviceApiClient.Result result = api.post(PATH_BY_ACTION.get(kind), body);

            if (result.isTransient()) {
                for (String key : keyByThingName.values()) {
                    markBusy(key, result.summary());
                }
                return;
            }
            if (!result.succeeded()) {
                for (String key : keyByThingName.values()) {
                    fail(key, result.summary());
                }
                return;
            }
            readResults(result, keyByThingName);
        }

        // 200 when every device succeeded, 207 when some did not: either way
        // the body has one entry per device.
        private void readResults(DeviceApiClient.Result result, Map<String, String> keyByThingName) {
            List<Object> entries;
            try {
                entries = (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(result.body)).get('results');
            } catch (Exception e) {
                entries = null;
            }
            if (entries == null) {
                for (String key : keyByThingName.values()) {
                    fail(key, 'Unreadable answer from AWS. ' + result.summary());
                }
                return;
            }

            Set<String> answered = new Set<String>();
            for (Object raw : entries) {
                Map<String, Object> entry = (Map<String, Object>) raw;
                String thingName = (String) entry.get('thingName');
                String key = keyByThingName.get(thingName);
                if (key == null) {
                    continue;
                }
                answered.add(thingName);
                // A leftover AWS kept, because it has a certificate, is the
                // answer asked for, not a failure to retry.
                Boolean ok = isTeardown(kind)
                    ? entry.get('deleted') == true || entry.get('kept') == true
                    : entry.get('ok') == true;
                String error = entry.get('error') == null ? 'AWS reported a failure without a reason.' : String.valueOf(entry.get('error'));
                if (ok) {
                    succeed(key, entry);
                } else if (entry.get('retryable') == true) {
                    markBusy(key, error);
                } else {
                    fail(key, error);
                }
            }
            for (String thingName : keyByThingName.keySet()) {
                if (!answered.contains(thingName)) {
                    fail(keyByThingName.get(thingName), 'AWS returned no result for ' + thingName + '.');
                }
            }
        }

        private String problemWith(Asset device) {
            if (String.isBlank(device.SerialNumber)) {
                return 'Serial Number is required: it becomes the AWS IoT Thing name.';
            }
            if (kind == Action.PROVISION && device.Wi_Fi_Network__c == null) {
                return 'A Wi-Fi Network must be set before provisioning.';
            }
            if (kind == Action.REPROVISION && String.isBlank(device.Thing_ARN__c)) {
                return 'This device was never provisioned, so it has no certificate to replace.';
            }
            // AWS is asked for the Thing named after the serial number, so a
            // Thing ARN that names another Thing means one of the two is wrong,
            // and going ahead would replace that other Thing's certificate.
            if (kind == Action.REPROVISION
                    && !device.SerialNumber.equals(DeviceProvisioningService.thingNameIn(device.Thing_ARN__c))) {
                return 'Its Thing ARN does not name the Thing ' + device.SerialNumber
                    + ', so Re-provision would replace the certificate of another Thing. Correct the Serial Number or the Thing ARN first.';
            }
            return null;
        }

        private Map<String, Object> requestFor(Asset device) {
            Map<String, Object> request = new Map<String, Object>{
                'thingName'  => device.SerialNumber,
                'ssid'       => device.Wi_Fi_Network__r == null ? null : device.Wi_Fi_Network__r.SSID__c,
                'passphrase' => device.Wi_Fi_Network__r == null ? null : device.Wi_Fi_Network__r.Passphrase__c
            };
            if (kind == Action.PROVISION) {
                request.put('thingGroup',
                    String.isBlank(device.Thing_Group__c) ? defaultThingGroup : device.Thing_Group__c);
            }
            return request;
        }

        private void succeed(String key, Map<String, Object> entry) {
            succeeded++;
            if (isTeardown(kind)) {
                System.debug(LoggingLevel.INFO, entry.get('kept') == true
                    ? 'Kept in AWS: ' + String.valueOf(entry.get('reason'))
                    : 'Torn down in AWS: ' + key);
                return;
            }
            Asset outcome = new Asset(
                Id                          = key,
                Certificate_Id__c           = (String) entry.get('certificateId'),
                Provisioning_Bundle_Link__c = (String) entry.get('bundleUrl'),
                Provisioning_Expires_At__c  = System.now().addMinutes(bundleTtlMinutes),
                Provisioning_Status__c      = 'Provisioned',
                Provisioning_Error__c       = null
            );
            if (kind == Action.PROVISION) {
                outcome.Thing_ARN__c = (String) entry.get('thingArn');
                if (entry.get('thingGroup') != null) {
                    outcome.Thing_Group__c = (String) entry.get('thingGroup');
                }
            }
            outcomeByKey.put(key, outcome);
        }

        public void fail(String key, String reason) {
            failed++;
            if (kind == Action.TEARDOWN) {
                // The record is already deleted, so there is nothing to mark.
                // Logged loudly: an orphaned Thing blocks its serial number
                // from ever being registered again.
                System.debug(LoggingLevel.ERROR, 'AWS teardown FAILED for ' + key
                    + ' - this Thing may block re-registration: ' + reason);
                return;
            }
            if (kind == Action.TEARDOWN_LEFTOVER) {
                // An empty Thing blocks nothing: provisioning reuses it.
                System.debug(LoggingLevel.WARN, 'Could not remove the Thing ' + key
                    + ' that a failed provisioning may have left: ' + reason);
                return;
            }
            outcomeByKey.put(key, new Asset(
                Id                     = key,
                Provisioning_Status__c = 'Failed',
                Provisioning_Error__c  = reason == null ? null : reason.abbreviate(255)
            ));
        }

        private void markBusy(String key, String reason) {
            busy.add(key);
            busyReasonByKey.put(key, reason);
        }

        /**
         * One update for every device this run decided about.
         *
         * A device AWS provisioned or re-provisioned whose outcome cannot be
         * saved is marked Failed instead, with the reason, so it does not look
         * as if nothing happened. It keeps the Thing ARN, Thing Group and
         * certificate id AWS reported, so Re-provision can issue a new bundle
         * once the cause is fixed, and deleting the device tears the Thing
         * down. If that update fails too, for example because the device was
         * deleted meanwhile, only the debug log says so, with the Thing and
         * certificate to look for in AWS IoT.
         */
        public void save() {
            if (outcomeByKey.isEmpty()) {
                return;
            }
            List<Asset> outcomes = outcomeByKey.values();
            List<Asset> fallbacks = new List<Asset>();
            List<Database.SaveResult> saves = Database.update(outcomes, false);
            for (Integer i = 0; i < saves.size(); i++) {
                if (saves[i].isSuccess()) {
                    continue;
                }
                String error = withoutLinks(saves[i].getErrors()[0].getMessage());
                if (outcomes[i].Provisioning_Status__c == 'Provisioned') {
                    fallbacks.add(failedSave(outcomes[i], error));
                } else {
                    // Marking it Failed is the update that just did not go through.
                    logUnsaved(outcomes[i], error);
                }
            }
            if (fallbacks.isEmpty()) {
                return;
            }
            List<Database.SaveResult> retries = Database.update(fallbacks, false);
            for (Integer i = 0; i < retries.size(); i++) {
                if (!retries[i].isSuccess()) {
                    logUnsaved(fallbacks[i], withoutLinks(retries[i].getErrors()[0].getMessage()));
                }
            }
        }

        // What to save for a device AWS finished with when its outcome could
        // not be saved. Only what AWS reported is copied: a field left unset on
        // the outcome, such as a re-provisioned device's Thing ARN, stays unset
        // here too, since a field set to null would be cleared.
        private Asset failedSave(Asset outcome, String error) {
            Asset fallback = new Asset(
                Id                     = outcome.Id,
                Provisioning_Status__c = 'Failed',
                Provisioning_Error__c  = ('AWS finished, but Salesforce could not save the result. Fix the cause, '
                    + 'then use Re-provision for a new bundle link. Cause: ' + error).abbreviate(255)
            );
            if (outcome.Thing_ARN__c != null) {
                fallback.Thing_ARN__c = outcome.Thing_ARN__c;
            }
            if (outcome.Thing_Group__c != null) {
                fallback.Thing_Group__c = outcome.Thing_Group__c;
            }
            if (outcome.Certificate_Id__c != null) {
                fallback.Certificate_Id__c = outcome.Certificate_Id__c;
            }
            return fallback;
        }

        private void logUnsaved(Asset outcome, String error) {
            System.debug(LoggingLevel.ERROR, 'Could not record the ' + kind + ' outcome on ' + outcome.Id
                + (outcome.Thing_ARN__c == null ? '' : ', which AWS provisioned as ' + outcome.Thing_ARN__c)
                + (outcome.Certificate_Id__c == null ? '' : ' with certificate ' + outcome.Certificate_Id__c)
                + ': ' + error);
        }

        // A save error can quote the value it refused, and a bundle link is a
        // credential until it expires, so no link is logged or kept as text.
        private String withoutLinks(String message) {
            return message == null ? null : message.replaceAll('https?://\\S+', '(link removed)');
        }
    }
}
