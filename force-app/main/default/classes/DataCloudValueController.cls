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
            return output == null || output.data == null ? new List<Map<String, Object>>() : output.data;
        }
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
        if (value instanceof Datetime) {
            return ((Datetime) value).formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'');
        }
        if (value instanceof Date) {
            return String.valueOf((Date) value);
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
