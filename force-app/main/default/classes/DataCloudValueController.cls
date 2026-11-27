/*
 * DataCloudValueController.cls
 *
 * Server side of the Data Cloud value card on the Cloud Agentic IoT app's
 * Home page (lwc/dataCloudValueCard). It reads the two calculated insights
 * the room readings feed (datacloud/calculated-insights.json) with Data
 * Cloud's ANSI SQL query, and the prices in Value_Assumption__mdt.Default.
 * The card works out the tiles and charts (value.js) and keeps the answer
 * for 10 minutes, so a page load does not cost a query each time.
 *
 *   Room_Out_Of_Range_Daily__cio  per device and day: readings and minutes
 *                                 at or above the temperature alert
 *                                 threshold, and the day's highest reading
 *   Room_Device_Silence__cio      per device: its last reading's time and
 *                                 its reading count
 *
 * Each insight is read on its own, so one that is missing or empty never
 * blanks the other. Data Cloud's answer is data, never quoted back whole.
 */
public with sharing class DataCloudValueController {

    public static final String OUT_OF_RANGE = 'Room_Out_Of_Range_Daily__cio';
    public static final String SILENCE = 'Room_Device_Silence__cio';
    // A ward is tens of devices; 31 days of them stays well under this.
    private static final Integer MAX_ROWS = 2000;

    /** Runs one SQL query against Data Cloud. Replaced in tests. */
    public interface Querier {
        List<Map<String, Object>> query(String sql);
    }

    public class ConnectQuerier implements Querier {
        public List<Map<String, Object>> query(String sql) {
            ConnectApi.CdpQueryInput input = new ConnectApi.CdpQueryInput();
            input.sql = sql;
            ConnectApi.CdpQueryOutput output = ConnectApi.CdpQuery.queryAnsiSql(input);
            if (output == null || output.data == null) return new List<Map<String, Object>>();
            // Rows are read straight from output.data, a map of column to
            // value each. Not through JSON: in a real org JSON.serialize of
            // the output throws "Attempt to de-reference a null object", and
            // of output.data "Type unsupported in JSON: LinkedTreeMap", so a
            // round trip answered every query, even COUNT(*), with no rows
            // (Nov 27, docs/TROUBLESHOOTING.md).
            return copyRows(output.data);
        }
    }

    /**
     * Each row as a plain Map of column to value, through JSON one row at a
     * time. A row that is not a map is skipped; a value that is not a primitive becomes its text, so no
     * platform map type travels further than this.
     */
    @TestVisible
    private static List<Map<String, Object>> copyRows(List<Object> data) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        for (Object row : data == null ? new List<Object>() : data) {
            if (row == null || !(row instanceof Map<String, Object>)) continue;
            // A real org hands back its own internal map: instanceof Map is
            // true, but get(), keySet() and new Map(row) all fail inside the
            // platform ("Made lookup for method that does not exist ...
            // Map.keySet()"). One row serializes cleanly, though, and comes
            // back as a real Apex map (Nov 27, test-cloudarchitect101).
            Map<String, Object> source;
            try {
                source = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(row));
            } catch (Exception e) {
                continue;
            }
            Map<String, Object> copy = new Map<String, Object>();
            for (String column : source.keySet()) {
                Object value = source.get(column);
                copy.put(column, value == null || value instanceof String || value instanceof Decimal
                    || value instanceof Integer || value instanceof Long || value instanceof Double
                    || value instanceof Boolean || value instanceof Datetime || value instanceof Date
                    ? value : String.valueOf(value));
            }
            rows.add(copy);
        }
        return rows;
    }

    /*
     * The query answer as JSON: { "data": [...], "metadata": { column:
     * { "placeInOrder": n, ... } } }. A row arrives as a map of column to
     * value, or as a list of values in metadata order; both become a map.
     * Anything else is skipped.
     */
    @TestVisible
    private static List<Map<String, Object>> fromJson(String body) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        Object parsed = String.isBlank(body) ? null : JSON.deserializeUntyped(body);
        if (!(parsed instanceof Map<String, Object>)) return rows;
        Map<String, Object> answer = (Map<String, Object>) parsed;

        Map<Integer, String> columnAt = new Map<Integer, String>();
        Object metadata = answer.get('metadata');
        if (metadata instanceof Map<String, Object>) {
            Map<String, Object> columns = (Map<String, Object>) metadata;
            Integer next = 0;
            for (String column : columns.keySet()) {
                Object item = columns.get(column);
                Object place = item instanceof Map<String, Object>
                    ? ((Map<String, Object>) item).get('placeInOrder') : null;
                columnAt.put(place instanceof Integer ? (Integer) place : next, column);
                next++;
            }
        }

        Object data = answer.get('data');
        if (!(data instanceof List<Object>)) return rows;
        for (Object row : (List<Object>) data) {
            if (row instanceof Map<String, Object>) {
                rows.add((Map<String, Object>) row);
            } else if (row instanceof List<Object>) {
                List<Object> values = (List<Object>) row;
                Map<String, Object> named = new Map<String, Object>();
                for (Integer i = 0; i < values.size(); i++) {
                    if (columnAt.containsKey(i)) named.put(columnAt.get(i), values[i]);
                }
                rows.add(named);
            }
        }
        return rows;
    }

    @TestVisible
    private static Querier querier = new ConnectQuerier();

    /*
     * Returns { asOf, outOfRange: {rows, error}, silence: {rows, error},
     * assumptions }. A row is a map of the insight's fields; times are ISO
     * 8601 text in UTC.
     */
    @AuraEnabled
    public static Map<String, Object> read() {
        return new Map<String, Object>{
            'asOf'        => Datetime.now(),
            'outOfRange'  => readInsight(
                'SELECT device_id__c, reading_day__c, readings_out_of_range__c, minutes_out_of_range__c, '
                + 'max_temperature_c__c FROM ' + OUT_OF_RANGE + ' LIMIT ' + MAX_ROWS,
                new List<String>{ 'device_id__c', 'reading_day__c', 'readings_out_of_range__c',
                    'minutes_out_of_range__c', 'max_temperature_c__c' }),
            'silence'     => readInsight(
                'SELECT device_id__c, last_reading_ts__c, readings__c FROM ' + SILENCE + ' LIMIT ' + MAX_ROWS,
                new List<String>{ 'device_id__c', 'last_reading_ts__c', 'readings__c' }),
            'assumptions' => assumptions()
        };
    }

    private static Map<String, Object> readInsight(String sql, List<String> fields) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        try {
            for (Map<String, Object> row : querier.query(sql)) {
                Map<String, Object> kept = new Map<String, Object>();
                for (String field : fields) {
                    kept.put(field, plain(valueOf(row, field)));
                }
                rows.add(kept);
            }
        } catch (Exception e) {
            // The type and a short message: enough to act on, nothing more.
            return new Map<String, Object>{ 'rows' => rows, 'error' => e.getTypeName() + ': ' + e.getMessage().left(200) };
        }
        return new Map<String, Object>{ 'rows' => rows, 'error' => null };
    }

    // Data Cloud may answer a field under its name in any case.
    private static Object valueOf(Map<String, Object> row, String field) {
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

    // Times as ISO 8601 text in UTC, numbers and text as they are.
    @TestVisible
    private static Object plain(Object value) {
        // A Date is also instanceof Datetime in Apex, but a Datetime is not
        // instanceof Date, so the Date check goes first (checked in the org,
        // Nov 27).
        if (value instanceof Date) {
            return String.valueOf((Date) value);
        }
        if (value instanceof Datetime) {
            return ((Datetime) value).formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'');
        }
        return value;
    }

    private static Map<String, Object> assumptions() {
        Value_Assumption__mdt a = ValueSnapshotService.assumptions();
        return new Map<String, Object>{
            'manualCheckMinutes'        => a.Manual_Check_Minutes__c,
            'manualChecksPerDeviceDay'  => a.Manual_Checks_Per_Device_Day__c,
            'baselineMinutesToRespond'  => a.Baseline_Minutes_To_Respond__c,
            'staffHourlyRate'           => a.Staff_Hourly_Rate__c,
            'dataCloudCreditsPerMonth'  => a.Data_Cloud_Credits_Per_Month__c,
            'dataCloudPricePerCredit'   => a.Data_Cloud_Price_Per_Credit__c
        };
    }
}
