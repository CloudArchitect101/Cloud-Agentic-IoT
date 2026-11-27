@IsTest
private class DataCloudValueControllerTest {

    /** Answers each insight's query from a list, or fails for one insight. */
    private class FakeQuerier implements DataCloudValueController.Querier {
        Map<String, List<Map<String, Object>>> answers = new Map<String, List<Map<String, Object>>>();
        String failFor;
        List<String> asked = new List<String>();

        public List<Map<String, Object>> query(String sql) {
            asked.add(sql);
            for (String insight : answers.keySet()) {
                if (sql.contains('FROM ' + insight + ' ')) {
                    if (insight == failFor) {
                        throw new CalloutException('Data Cloud is not set up in this org');
                    }
                    return answers.get(insight);
                }
            }
            return new List<Map<String, Object>>();
        }
    }

    private static FakeQuerier useFake() {
        FakeQuerier fake = new FakeQuerier();
        fake.answers.put(DataCloudValueController.OUT_OF_RANGE, new List<Map<String, Object>>{
            new Map<String, Object>{
                'device_id__c' => 'Test8', 'reading_day__c' => Datetime.newInstanceGmt(2026, 11, 19),
                'readings_out_of_range__c' => 40, 'minutes_out_of_range__c' => 20.0, 'max_temperature_c__c' => 34.5 }
        });
        fake.answers.put(DataCloudValueController.SILENCE, new List<Map<String, Object>>{
            // Upper case on purpose: the field is still found.
            new Map<String, Object>{
                'DEVICE_ID__C' => 'Test8', 'last_reading_ts__c' => Datetime.newInstanceGmt(2026, 11, 19, 20, 5, 0),
                'readings__c' => 1200 }
        });
        DataCloudValueController.querier = fake;
        ValueSnapshotService.testAssumption = new Value_Assumption__mdt(
            DeveloperName = 'Default', Manual_Check_Minutes__c = 3, Manual_Checks_Per_Device_Day__c = 12,
            Baseline_Minutes_To_Respond__c = 60, Staff_Hourly_Rate__c = 55,
            Data_Cloud_Credits_Per_Month__c = 2000, Data_Cloud_Price_Per_Credit__c = 0.005);
        return fake;
    }

    @IsTest
    static void readsBothInsightsAndThePrices() {
        FakeQuerier fake = useFake();

        Map<String, Object> answer = DataCloudValueController.read();

        Assert.areEqual(2, fake.asked.size(), 'one query per insight, nothing more');
        Map<String, Object> outOfRange = (Map<String, Object>) answer.get('outOfRange');
        Assert.isNull(outOfRange.get('error'));
        Map<String, Object> day = (Map<String, Object>) ((List<Object>) outOfRange.get('rows'))[0];
        Assert.areEqual('Test8', day.get('device_id__c'));
        Assert.areEqual('2026-11-19T00:00:00.000Z', day.get('reading_day__c'), 'times go out as ISO text in UTC');
        Assert.areEqual(20.0, day.get('minutes_out_of_range__c'));

        Map<String, Object> silence = (Map<String, Object>) answer.get('silence');
        Map<String, Object> device = (Map<String, Object>) ((List<Object>) silence.get('rows'))[0];
        Assert.areEqual('Test8', device.get('device_id__c'), 'a field in another case is still read');
        Assert.areEqual('2026-11-19T20:05:00.000Z', device.get('last_reading_ts__c'));

        Map<String, Object> prices = (Map<String, Object>) answer.get('assumptions');
        Assert.areEqual(2000, ((Decimal) prices.get('dataCloudCreditsPerMonth')).intValue());
        Assert.areEqual(0.005, (Decimal) prices.get('dataCloudPricePerCredit'));
        Assert.areEqual(55, ((Decimal) prices.get('staffHourlyRate')).intValue());
    }

    @IsTest
    static void oneInsightFailingLeavesTheOther() {
        FakeQuerier fake = useFake();
        fake.failFor = DataCloudValueController.OUT_OF_RANGE;

        Map<String, Object> answer = DataCloudValueController.read();

        Map<String, Object> outOfRange = (Map<String, Object>) answer.get('outOfRange');
        Assert.isTrue(((String) outOfRange.get('error')).contains('Data Cloud is not set up'), (String) outOfRange.get('error'));
        Assert.areEqual(0, ((List<Object>) outOfRange.get('rows')).size());
        Map<String, Object> silence = (Map<String, Object>) answer.get('silence');
        Assert.isNull(silence.get('error'));
        Assert.areEqual(1, ((List<Object>) silence.get('rows')).size());
    }

    @IsTest
    static void eachQueryIsBoundedAndReadsOnlyItsInsight() {
        FakeQuerier fake = useFake();
        DataCloudValueController.read();
        for (String sql : fake.asked) {
            Assert.isTrue(sql.startsWith('SELECT '), sql);
            Assert.isTrue(sql.contains(' LIMIT '), 'every query is bounded: ' + sql);
            Assert.isTrue(sql.contains('__cio'), 'reads a calculated insight: ' + sql);
        }
    }

    @IsTest
    static void plainLeavesNumbersAndTextAsTheyAre() {
        Assert.areEqual(3, DataCloudValueController.plain(3));
        Assert.areEqual('x', DataCloudValueController.plain('x'));
        Assert.areEqual('2026-11-19', DataCloudValueController.plain(Date.newInstance(2026, 11, 19)));
        Assert.isNull(DataCloudValueController.plain(null));
    }

    @IsTest
    static void rowsArriveAsMapsOrAsListsInMetadataOrder() {
        String body = '{"data":[{"device_id__c":"Test8","readings__c":12},["Test7",3],"not a row"],'
            + '"metadata":{"readings__c":{"placeInOrder":1,"type":"DECIMAL"},'
            + '"device_id__c":{"placeInOrder":0,"type":"VARCHAR"}}}';
        List<Map<String, Object>> rows = DataCloudValueController.fromJson(body);
        Assert.areEqual(2, rows.size(), 'map and list rows are kept, anything else skipped');
        Assert.areEqual('Test8', rows[0].get('device_id__c'));
        Assert.areEqual('Test7', rows[1].get('device_id__c'), 'a list row is named by placeInOrder');
        Assert.areEqual(3, rows[1].get('readings__c'));
    }

    @IsTest
    static void anEmptyOrOddAnswerIsNoRows() {
        Assert.areEqual(0, DataCloudValueController.fromJson(null).size());
        Assert.areEqual(0, DataCloudValueController.fromJson('[]').size());
        Assert.areEqual(0, DataCloudValueController.fromJson('{"data":null}').size());
        // No placeInOrder: columns are taken in the order they are listed.
        List<Map<String, Object>> rows = DataCloudValueController.fromJson(
            '{"data":[["Test8"]],"metadata":{"device_id__c":{}}}');
        Assert.areEqual('Test8', rows[0].get('device_id__c'));
    }

    @IsTest
    static void rowsAreCopiedStraightFromTheQueryOutput() {
        List<Object> data = new List<Object>{
            new Map<String, Object>{ 'device_id__c' => 'Test8', 'readings__c' => 16739,
                'last_reading_ts__c' => '2026-11-21T20:45:06.818Z', 'nested' => new Map<String, Object>{ 'a' => 1 } },
            'not a row',
            null
        };

        List<Map<String, Object>> rows = DataCloudValueController.copyRows(data);

        Assert.areEqual(1, rows.size(), 'only rows that are maps');
        Assert.areEqual('Test8', rows[0].get('device_id__c'));
        Assert.areEqual(16739, rows[0].get('readings__c'));
        Assert.areEqual('2026-11-21T20:45:06.818Z', rows[0].get('last_reading_ts__c'));
        Assert.isTrue(rows[0].get('nested') instanceof String, 'a nested value becomes text');
        Assert.areEqual(0, DataCloudValueController.copyRows(null).size());
    }
}
