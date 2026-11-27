/*
 * DeviceHistoryAgentAction.cls
 *
 * The Patient Care Agent's Get Device History action: how a monitored
 * device's temperature has run over the last days, from Data Cloud. It
 * answers the questions the latest reading cannot: "has Test8 been running
 * hot this week, or is today a one-off?", "how long was it at or above
 * 30 C yesterday?", "when did Test7 last send anything?".
 *
 * Three Data Cloud ANSI SQL queries per device, all read-only, through the
 * same Querier the Home page's Data Cloud value card uses:
 *
 *   Room_Out_Of_Range_Daily__cio  per day: readings and minutes at or above
 *                                 the temperature alert threshold, and the
 *                                 highest of them (refreshed every 6 hours)
 *   Room_Readings__dlm            the raw readings of the last 24 hours,
 *                                 counted in the query
 *   Room_Device_Silence__cio      the device's last reading (hourly)
 *
 * The numbers come from SQL, never from the model adding readings up, so
 * they are exact. docs/DATA-CLOUD.md, "How the agent reads it", explains
 * the design and why this is a query, not a vector search.
 *
 * Security:
 *   - The Asset is looked up first, as the person talking to the agent
 *     ("with sharing", WITH USER_MODE). A device they cannot see gets the
 *     same answer as one that does not exist, and no Data Cloud query.
 *   - The Query API takes no bind variables, so the serial number must
 *     match SERIAL_PATTERN before it is written into the SQL, and the
 *     start times are written by Apex, never taken from the request.
 *   - Only the device serial number and numbers come back; nothing from
 *     the Person Account.
 *
 * Its own class because Apex allows one @InvocableMethod per class.
 */
public with sharing class DeviceHistoryAgentAction {

    public static final String DAILY = 'Room_Out_Of_Range_Daily__cio';
    public static final String RAW = 'Room_Readings__dlm';
    public static final String SILENCE = 'Room_Device_Silence__cio';

    /**
     * The temperature alert threshold and the boards' reading interval, the
     * same as datacloud/calculated-insights.json (roomTempAlertCelsius,
     * telemetrySeconds). test/config/data-cloud-insights.test.js fails when
     * they differ.
     */
    @TestVisible
    private static final Decimal ALERT_CELSIUS = 30.0;
    @TestVisible
    private static final Integer TELEMETRY_SECONDS = 30;

    /** Days of history when the agent does not say, and the most it may ask. */
    @TestVisible
    private static final Integer DEFAULT_DAYS = 7;
    @TestVisible
    private static final Integer MAX_DAYS = 30;

    /** Each device costs three queries, so one call reads at most this many. */
    @TestVisible
    private static final Integer MAX_DEVICES_PER_CALL = 5;

    /** What a serial number (AWS IoT Thing name) may hold before it goes into SQL. */
    @TestVisible
    private static final Pattern SERIAL_PATTERN = Pattern.compile('^[A-Za-z0-9_-]{1,64}$');

    @TestVisible
    private static final String NOTICE = 'From Data Cloud. Daily totals refresh about every 6 hours and readings are '
        + 'imported on a schedule, so the newest hour or two may be missing. For what the device reads right now, '
        + 'use Get Latest Device Readings. A day not listed had no reading at or above the threshold, or no readings.';

    @TestVisible
    private static DataCloudValueController.Querier querier = new DataCloudValueController.ConnectQuerier();

    /** Fixed in tests, so the start times in the SQL are known. */
    @TestVisible
    private static Datetime now = null;

    public class HistoryRequest {
        @InvocableVariable(required=true label='Device ID'
            description='The device serial number (Asset.SerialNumber), the same as its AWS IoT Thing name, for example Test8.')
        public String deviceId;

        @InvocableVariable(label='Days'
            description='How many days of history, counting today. 7 if empty, at most 30.')
        public Integer days;
    }

    public class HistoryResult {
        @InvocableVariable(label='Success') public Boolean success;
        @InvocableVariable(label='Message') public String message;
        @InvocableVariable(label='Device ID') public String deviceId;
        @InvocableVariable(label='Days' description='How many days of history this covers, counting today.')
        public Integer days;
        @InvocableVariable(label='Summary'
            description='One or two sentences with the numbers: days at or above the threshold, minutes, the highest reading, the last 24 hours and the newest reading. Use it as written in an escalation reason.')
        public String summary;
        @InvocableVariable(label='Daily Lines'
            description='One line per day that had readings at or above the threshold, newest first.')
        public String dailyLines;
        @InvocableVariable(label='Days With Alerts' description='Days in the period with at least one reading at or above the threshold.')
        public Integer daysWithAlerts;
        @InvocableVariable(label='Minutes At Or Above Threshold' description='About how many minutes in the period the device read at or above the threshold.')
        public Decimal minutesAtOrAbove;
        @InvocableVariable(label='Highest Temperature' description='The highest reading in C on those days.')
        public Decimal highestTemperature;
        @InvocableVariable(label='Last 24 Hours Readings' description='How many readings Data Cloud holds for the last 24 hours.')
        public Integer last24hReadings;
        @InvocableVariable(label='Last 24 Hours Minutes At Or Above Threshold' description='About how many of the last 24 hours, in minutes, the device read at or above the threshold.')
        public Decimal last24hMinutesAtOrAbove;
        @InvocableVariable(label='Last 24 Hours Highest Temperature' description='The highest reading in C in the last 24 hours.')
        public Decimal last24hHighest;
        @InvocableVariable(label='Last Reading At' description='The newest reading Data Cloud holds for the device.')
        public Datetime lastReadingAt;
        @InvocableVariable(label='Last Reading Age Minutes' description='How many minutes ago that newest reading was taken.')
        public Integer lastReadingAgeMinutes;
        @InvocableVariable(label='Threshold Celsius' description='The temperature alert threshold the history is counted against.')
        public Decimal thresholdCelsius;
        @InvocableVariable(label='Notice' description='How fresh the history is, and what a missing day means.')
        public String notice;
    }

    @InvocableMethod(
        label='Get Device History'
        description='Returns how a monitored device\'s temperature ran over the last days from Data Cloud: days and minutes at or above the alert threshold, the highest reading, the last 24 hours and its newest reading.'
        category='Patient Care')
    public static List<HistoryResult> getHistory(List<HistoryRequest> requests) {
        List<HistoryResult> results = new List<HistoryResult>();
        Set<String> wanted = new Set<String>();
        for (HistoryRequest req : requests == null ? new List<HistoryRequest>() : requests) {
            HistoryResult res = new HistoryResult();
            res.success = false;
            res.thresholdCelsius = ALERT_CELSIUS;
            results.add(res);
            String serial = (req == null || req.deviceId == null) ? '' : req.deviceId.trim();
            if (serial == '') {
                res.message = 'A device ID (the device serial number) is required.';
                continue;
            }
            if (!SERIAL_PATTERN.matcher(serial).matches()) {
                // Never echoed: it is not a serial number, and it may be anything.
                res.message = 'That is not a device serial number. Use letters, digits, - and _ only, for example Test8.';
                continue;
            }
            if (wanted.size() >= MAX_DEVICES_PER_CALL && !wanted.contains(serial)) {
                res.message = 'Too many devices in one request; ask for at most ' + MAX_DEVICES_PER_CALL + '.';
                continue;
            }
            res.deviceId = serial;
            res.days = clampDays(req.days);
            wanted.add(serial);
        }
        if (wanted.isEmpty()) {
            return results;
        }

        Map<String, Integer> found;
        try {
            found = assetsBySerial(wanted);
        } catch (QueryException e) {
            for (HistoryResult res : results) {
                if (res.deviceId != null) {
                    res.message = 'The device record could not be read with your access.';
                }
            }
            return results;
        }

        for (HistoryResult res : results) {
            if (res.deviceId == null) {
                continue;
            }
            Integer matches = found.containsKey(res.deviceId) ? found.get(res.deviceId) : 0;
            if (matches == 0) {
                res.message = 'No device with serial number ' + res.deviceId + ' that you have access to.';
                continue;
            }
            if (matches > 1) {
                res.message = matches + ' devices share serial number ' + res.deviceId
                    + '; the history cannot be tied to one of them. Ask an admin to fix the duplicate.';
                continue;
            }
            describe(res);
        }
        return results;
    }

    private static void describe(HistoryResult res) {
        Datetime at = current();
        List<String> failed = new List<String>();

        // Per day, from the 6-hourly insight. Day 1 is today (UTC).
        Date firstDay = at.dateGmt().addDays(1 - res.days);
        List<Map<String, Object>> days = run(
            'SELECT reading_day__c, readings_out_of_range__c, minutes_out_of_range__c, max_temperature_c__c'
            + ' FROM ' + DAILY
            + ' WHERE device_id__c = \'' + res.deviceId + '\''
            + ' AND reading_day__c >= TIMESTAMP \'' + literal(Datetime.newInstanceGmt(firstDay, Time.newInstance(0, 0, 0, 0))) + '\''
            + ' ORDER BY reading_day__c DESC LIMIT ' + (MAX_DAYS + 1),
            'daily totals', failed);

        // The last 24 hours, counted from the raw readings in the query.
        List<Map<String, Object>> recent = run(
            'SELECT COUNT(reading_id__c) AS readings__c,'
            + ' SUM(CASE WHEN temperature_c__c >= ' + ALERT_CELSIUS.toPlainString() + ' THEN 1 ELSE 0 END) AS readings_out_of_range__c,'
            + ' MAX(temperature_c__c) AS max_temperature_c__c,'
            + ' MAX(reading_ts__c) AS last_reading_ts__c'
            + ' FROM ' + RAW
            + ' WHERE device_id__c = \'' + res.deviceId + '\''
            + ' AND reading_ts__c >= TIMESTAMP \'' + literal(at.addHours(-24)) + '\'',
            'last 24 hours', failed);

        // The last reading ever, for a device that has been quiet longer than a day.
        List<Map<String, Object>> silence = run(
            'SELECT last_reading_ts__c FROM ' + SILENCE
            + ' WHERE device_id__c = \'' + res.deviceId + '\' LIMIT 1',
            'last reading', failed);

        if (failed.size() == 3) {
            res.message = 'The device history is unavailable right now: Data Cloud could not be queried. '
                + 'An admin checks that Data Cloud is set up and that this user may query it (docs/DATA-CLOUD.md).';
            return;
        }

        // Days.
        res.daysWithAlerts = 0;
        res.minutesAtOrAbove = 0;
        List<String> lines = new List<String>();
        for (Map<String, Object> row : days == null ? new List<Map<String, Object>>() : days) {
            Datetime day = toDatetime(valueOf(row, 'reading_day__c'));
            Decimal readings = toDecimal(valueOf(row, 'readings_out_of_range__c'));
            Decimal minutes = toDecimal(valueOf(row, 'minutes_out_of_range__c'));
            Decimal highest = toDecimal(valueOf(row, 'max_temperature_c__c'));
            if (day == null || readings == null || readings <= 0) {
                continue;
            }
            if (minutes == null) {
                minutes = readings * TELEMETRY_SECONDS / 60;
            }
            res.daysWithAlerts++;
            res.minutesAtOrAbove += minutes;
            if (highest != null && (res.highestTemperature == null || highest > res.highestTemperature)) {
                res.highestTemperature = highest;
            }
            lines.add(day.formatGmt('yyyy-MM-dd') + ': about ' + round(minutes) + ' minutes at or above '
                + ALERT_CELSIUS.toPlainString() + ' C (' + readings.intValue() + ' readings)'
                + (highest == null ? '' : ', highest ' + highest.setScale(1).toPlainString() + ' C'));
        }
        res.dailyLines = String.join(lines, '\n');

        // Last 24 hours.
        if (recent != null && !recent.isEmpty()) {
            Map<String, Object> row = recent[0];
            Decimal readings = toDecimal(valueOf(row, 'readings__c'));
            Decimal hot = toDecimal(valueOf(row, 'readings_out_of_range__c'));
            res.last24hReadings = readings == null ? 0 : readings.intValue();
            res.last24hMinutesAtOrAbove = hot == null ? 0 : hot * TELEMETRY_SECONDS / 60;
            res.last24hHighest = toDecimal(valueOf(row, 'max_temperature_c__c'));
            res.lastReadingAt = toDatetime(valueOf(row, 'last_reading_ts__c'));
        }

        // Newest reading: whichever source is fresher.
        if (silence != null && !silence.isEmpty()) {
            Datetime last = toDatetime(valueOf(silence[0], 'last_reading_ts__c'));
            if (last != null && (res.lastReadingAt == null || last > res.lastReadingAt)) {
                res.lastReadingAt = last;
            }
        }
        if (res.lastReadingAt != null) {
            res.lastReadingAgeMinutes = Math.max(0L, (at.getTime() - res.lastReadingAt.getTime()) / 60000L).intValue();
        }

        res.success = true;
        res.summary = summary(res, failed);
        res.notice = NOTICE;
        res.message = failed.isEmpty()
            ? 'History of device ' + res.deviceId + ' for the last ' + res.days + ' days.'
            : 'History of device ' + res.deviceId + ' without its ' + String.join(failed, ' or ')
                + ': Data Cloud could not answer that part. Say so; do not guess it.';
    }

    private static String summary(HistoryResult res, List<String> failed) {
        String threshold = ALERT_CELSIUS.toPlainString() + ' C';
        List<String> parts = new List<String>();
        if (!failed.contains('daily totals')) {
            parts.add(res.daysWithAlerts == 0
                ? res.deviceId + ', last ' + res.days + ' days: no reading at or above ' + threshold + '.'
                : res.deviceId + ', last ' + res.days + ' days: at or above ' + threshold + ' on ' + res.daysWithAlerts
                    + (res.daysWithAlerts == 1 ? ' day' : ' days') + ', about ' + round(res.minutesAtOrAbove) + ' minutes in all'
                    + (res.highestTemperature == null ? '' : ', highest ' + res.highestTemperature.setScale(1).toPlainString() + ' C') + '.');
        }
        if (!failed.contains('last 24 hours')) {
            parts.add(res.last24hReadings == null || res.last24hReadings == 0
                ? 'No readings in the last 24 hours.'
                : 'Last 24 hours: ' + res.last24hReadings + ' readings, about ' + round(res.last24hMinutesAtOrAbove)
                    + ' minutes at or above ' + threshold
                    + (res.last24hHighest == null ? '' : ', highest ' + res.last24hHighest.setScale(1).toPlainString() + ' C') + '.');
        }
        parts.add(res.lastReadingAt == null
            ? 'Data Cloud holds no reading for this device.'
            : 'Newest reading in Data Cloud: ' + res.lastReadingAt.formatGmt('yyyy-MM-dd HH:mm') + ' UTC ('
                + ago(res.lastReadingAgeMinutes) + ').');
        return String.join(parts, ' ');
    }

    /** Runs one query; a failure is noted by its name, never thrown. */
    private static List<Map<String, Object>> run(String sql, String part, List<String> failed) {
        try {
            return querier.query(sql);
        } catch (Exception e) {
            failed.add(part);
            return null;
        }
    }

    /** Matched case-sensitively, as DeviceReadingsAgentAction matches a device. */
    private static Map<String, Integer> assetsBySerial(Set<String> serials) {
        Map<String, Integer> counts = new Map<String, Integer>();
        for (Asset device : [
            SELECT Id, SerialNumber FROM Asset WHERE SerialNumber IN :serials WITH USER_MODE
        ]) {
            if (!serials.contains(device.SerialNumber)) {
                continue;   // the same serial number in another case
            }
            counts.put(device.SerialNumber, (counts.containsKey(device.SerialNumber) ? counts.get(device.SerialNumber) : 0) + 1);
        }
        return counts;
    }

    private static Datetime current() {
        return now == null ? Datetime.now() : now;
    }

    @TestVisible
    private static Integer clampDays(Integer requested) {
        if (requested == null || requested < 1) {
            return DEFAULT_DAYS;
        }
        return Math.min(requested, MAX_DAYS);
    }

    /** A timestamp literal's text: 'yyyy-MM-dd HH:mm:ss' in UTC, written by Apex only. */
    @TestVisible
    private static String literal(Datetime at) {
        return at.formatGmt('yyyy-MM-dd HH:mm:ss');
    }

    /** An age people read at a glance: minutes, then hours, then days. */
    @TestVisible
    private static String ago(Integer minutes) {
        if (minutes == null || minutes < 90) {
            return (minutes == null ? 0 : minutes) + ' minutes ago';
        }
        if (minutes < 48 * 60) {
            return 'about ' + Decimal.valueOf(minutes).divide(60, 0, System.RoundingMode.HALF_UP) + ' hours ago';
        }
        return 'about ' + Decimal.valueOf(minutes).divide(24 * 60, 0, System.RoundingMode.HALF_UP) + ' days ago';
    }

    private static String round(Decimal minutes) {
        return minutes == null ? '0' : String.valueOf(minutes.round(System.RoundingMode.HALF_UP));
    }

    // Data Cloud may answer a field under its name in any case.
    private static Object valueOf(Map<String, Object> row, String field) {
        if (row == null) {
            return null;
        }
        if (row.containsKey(field)) {
            return row.get(field);
        }
        for (String key : row.keySet()) {
            if (key != null && key.equalsIgnoreCase(field)) {
                return row.get(key);
            }
        }
        return null;
    }

    @TestVisible
    private static Decimal toDecimal(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof Decimal) {
            return (Decimal) raw;
        }
        try {
            return Decimal.valueOf(String.valueOf(raw));
        } catch (Exception e) {
            return null;
        }
    }

    /** A Datetime, or ISO 8601 text such as 2026-11-19T20:05:00.000Z or 2026-11-19 20:05:00. */
    @TestVisible
    private static Datetime toDatetime(Object raw) {
        if (raw == null) {
            return null;
        }
        // Date first: a Date is also instanceof Datetime in Apex.
        if (raw instanceof Date) {
            return Datetime.newInstanceGmt((Date) raw, Time.newInstance(0, 0, 0, 0));
        }
        if (raw instanceof Datetime) {
            return (Datetime) raw;
        }
        String text = String.valueOf(raw).trim().replace(' ', 'T');
        if (text.length() == 10) {
            text += 'T00:00:00';
        }
        if (!text.endsWith('Z') && !text.contains('+')) {
            text += 'Z';
        }
        try {
            return (Datetime) JSON.deserialize('"' + text + '"', Datetime.class);
        } catch (Exception e) {
            return null;
        }
    }
}
