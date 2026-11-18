/**
 * Measures what the platform did over the trailing window and what it is
 * worth, next to the as-is baseline, and saves it as one Value_Snapshot__c
 * per day for the Business Value dashboard.
 *
 * Measured from the org (no assumption):
 *  - active devices, and the share Online now (Asset)
 *  - alert Cases the platform opened itself (temperature rule + vital
 *    alerts) and the minutes from opening to closing them
 *  - patient chats (MessagingSession), nurse requests, and so the chats the
 *    agent handled alone (the deflection rate)
 *  - staff agent escalations
 *  - AWS month-to-date spend (the usage card's Aws_Spend_Snapshot__c)
 *
 * Turned into time and money with Value_Assumption__mdt.Default (the
 * customer's own as-is numbers and prices; the shipped ones are
 * illustrative). The values used are copied onto the record, so the
 * dashboard can always say where a number came from.
 *
 * Agentforce cost is an estimate (conversations x actions each x price per
 * action): the org exposes no per-conversation Flex Credit usage to Apex.
 */
public with sharing class ValueSnapshotService {

    public static final String RECORD_NAME = 'Default';

    @TestVisible
    private static Value_Assumption__mdt testAssumption;
    @TestVisible
    private static Integer testChats;      // MessagingSession is not creatable in a test
    @TestVisible
    private static Date testToday;

    public class ValueException extends Exception {}

    /** The pure money and time arithmetic, so it can be tested on its own. */
    public class Inputs {
        public Integer windowDays;
        public Integer activeDevices = 0;
        public Integer onlineDevices = 0;
        public Integer alertsOpened = 0;
        public Integer alertsClosed = 0;
        public Decimal avgMinutesToClose;
        public Integer chats = 0;
        public Integer nurseRequests = 0;
        public Integer staffEscalations = 0;
        public Decimal awsMonthToDate;
        public Integer dayOfMonth;
        public Integer daysInMonth;
    }

    public static Value_Assumption__mdt assumptions() {
        if (testAssumption != null) {
            return testAssumption;
        }
        Value_Assumption__mdt a = Value_Assumption__mdt.getInstance(RECORD_NAME);
        if (a == null) {
            throw new ValueException('Custom metadata record Value_Assumption__mdt.' + RECORD_NAME
                + ' is missing. It ships in force-app/main/default/customMetadata; deploy it.');
        }
        return a;
    }

    /** Measures, values and saves today's snapshot; returns it. */
    public static Value_Snapshot__c takeSnapshot() {
        Value_Assumption__mdt a = assumptions();
        Date today = testToday != null ? testToday : Date.today();
        Value_Snapshot__c snap = compute(measure(a, today), a, today);
        snap.Is_Latest__c = true;
        upsert as system snap Value_Snapshot__c.Snapshot_Key__c;
        List<Value_Snapshot__c> older = [
            SELECT Id FROM Value_Snapshot__c WHERE Is_Latest__c = true AND Id != :snap.Id
        ];
        for (Value_Snapshot__c o : older) {
            o.Is_Latest__c = false;
        }
        update as system older;
        return snap;
    }

    @TestVisible
    private static Inputs measure(Value_Assumption__mdt a, Date today) {
        Inputs i = new Inputs();
        i.windowDays = Integer.valueOf(a.Window_Days__c);
        Datetime since = Datetime.newInstanceGmt(today.addDays(-i.windowDays), Time.newInstance(0, 0, 0, 0));

        for (AggregateResult r : [
            SELECT Connection_Status__c status, COUNT(Id) n FROM Asset
            WHERE Provisioning_Status__c = 'Provisioned'
            GROUP BY Connection_Status__c
        ]) {
            Integer n = (Integer) r.get('n');
            i.activeDevices += n;
            if ((String) r.get('status') == 'Online') {
                i.onlineDevices += n;
            }
        }

        Set<String> alertOrigins = new Set<String>{ VitalAlertCaseService.ORIGIN };
        Device_Platform_Setting__mdt platform = DevicePlatformSettings.get();
        if (String.isNotBlank(platform.Room_Temp_Case_Origin__c)) {
            alertOrigins.add(platform.Room_Temp_Case_Origin__c);
        }
        Decimal minutes = 0;
        for (Case c : [
            SELECT CreatedDate, ClosedDate, IsClosed FROM Case
            WHERE Origin IN :alertOrigins AND CreatedDate >= :since
        ]) {
            i.alertsOpened++;
            if (c.IsClosed && c.ClosedDate != null) {
                i.alertsClosed++;
                minutes += (c.ClosedDate.getTime() - c.CreatedDate.getTime()) / 60000.0;
            }
        }
        i.avgMinutesToClose = i.alertsClosed == 0 ? null : (minutes / i.alertsClosed).setScale(1);

        String escalationOrigin = platform.Escalation_Case_Origin__c;
        if (String.isNotBlank(escalationOrigin)) {
            i.staffEscalations = [SELECT COUNT() FROM Case WHERE Origin = :escalationOrigin AND CreatedDate >= :since];
        }
        String nurseOrigin = nurseRequestOrigin();
        if (String.isNotBlank(nurseOrigin)) {
            i.nurseRequests = [SELECT COUNT() FROM Case WHERE Origin = :nurseOrigin AND CreatedDate >= :since];
        }
        i.chats = testChats != null ? testChats : countChats(since);

        Aws_Spend_Snapshot__c spend = Aws_Spend_Snapshot__c.getOrgDefaults();
        i.awsMonthToDate = spend == null ? null : spend.Spent_Usd__c;
        i.dayOfMonth = today.day();
        i.daysInMonth = Date.daysInMonth(today.year(), today.month());
        return i;
    }

    /** Turns measurements into the snapshot. No queries. */
    @TestVisible
    private static Value_Snapshot__c compute(Inputs i, Value_Assumption__mdt a, Date today) {
        Decimal rate = a.Staff_Hourly_Rate__c;
        Decimal perAction = a.Cost_Per_Agent_Action__c;
        Decimal actions = a.Agent_Actions_Per_Chat__c;

        Value_Snapshot__c s = new Value_Snapshot__c(
            Snapshot_Date__c = today,
            Snapshot_Key__c = String.valueOf(today),
            Phase__c = a.Phase__c == 'Baseline' ? 'Baseline' : 'After',
            Window_Days__c = i.windowDays,
            Active_Devices__c = i.activeDevices,
            Devices_Online_Pct__c = i.activeDevices == 0 ? null : pct(i.onlineDevices, i.activeDevices),
            Alerts_Auto_Opened__c = i.alertsOpened,
            Alerts_Closed__c = i.alertsClosed,
            Avg_Minutes_To_Close__c = i.avgMinutesToClose,
            Baseline_Minutes_To_Respond__c = a.Baseline_Minutes_To_Respond__c,
            Portal_Chats__c = i.chats,
            Nurse_Requests__c = i.nurseRequests,
            Staff_Escalations__c = i.staffEscalations
        );
        if (i.avgMinutesToClose != null && a.Baseline_Minutes_To_Respond__c > 0) {
            s.Response_Improvement_Pct__c = ((1 - i.avgMinutesToClose / a.Baseline_Minutes_To_Respond__c) * 100).setScale(1);
        }

        Integer handled = Math.max(i.chats - i.nurseRequests, 0);
        s.Chats_Agent_Handled__c = handled;
        s.Deflection_Rate_Pct__c = i.chats == 0 ? null : pct(handled, i.chats);
        // Agentforce runs on every chat; a handled chat saves one nurse visit.
        // Break-even: chats x actions x price = handled x nurse minutes / 60 x rate.
        Decimal nurseVisitValue = a.Nurse_Minutes_Per_Request__c / 60 * rate;
        if (nurseVisitValue > 0) {
            s.Break_Even_Deflection_Pct__c = (Math.min(actions * perAction / nurseVisitValue, 1) * 100).setScale(1);
        }

        // In the platform phase manual checks are replaced by monitoring. In
        // the baseline phase nothing is avoided yet: that is the point.
        Boolean live = s.Phase__c == 'After';
        Decimal checkHours = live
            ? i.activeDevices * a.Manual_Checks_Per_Device_Day__c * i.windowDays * a.Manual_Check_Minutes__c / 60
            : 0;
        Decimal nurseHours = live ? handled * a.Nurse_Minutes_Per_Request__c / 60 : 0;
        s.Manual_Check_Hours_Avoided__c = checkHours.setScale(1);
        s.Nurse_Hours_Avoided__c = nurseHours.setScale(1);
        s.Staff_Time_Value__c = ((checkHours + nurseHours) * rate).setScale(2);
        s.Agentforce_Cost__c = ((i.chats + i.staffEscalations) * actions * perAction).setScale(2);

        if (i.awsMonthToDate != null && i.dayOfMonth > 0) {
            Decimal perDay = i.awsMonthToDate / i.dayOfMonth;
            s.Aws_Cost__c = (perDay * i.windowDays).setScale(2);
            if (i.activeDevices > 0) {
                s.Aws_Cost_Per_Device_Month__c = (perDay * i.daysInMonth / i.activeDevices).setScale(2);
            }
        }
        s.Net_Value__c = (s.Staff_Time_Value__c - s.Agentforce_Cost__c - (s.Aws_Cost__c == null ? 0 : s.Aws_Cost__c)).setScale(2);

        s.Assumptions__c = 'Phase ' + a.Phase__c
            + '; window ' + i.windowDays + ' days'
            + '; manual check ' + a.Manual_Check_Minutes__c + ' min x ' + a.Manual_Checks_Per_Device_Day__c + '/device/day'
            + '; baseline response ' + a.Baseline_Minutes_To_Respond__c + ' min'
            + '; nurse ' + a.Nurse_Minutes_Per_Request__c + ' min per question'
            + '; staff rate ' + rate + '/h'
            + '; Agentforce ' + actions + ' actions x ' + perAction + ' per conversation (estimate)'
            + '; source Value_Assumption__mdt.' + RECORD_NAME + ' (illustrative unless the customer replaced them)';
        return s;
    }

    private static Decimal pct(Integer part, Integer whole) {
        return (Decimal.valueOf(part) * 100 / whole).setScale(1);
    }

    private static String nurseRequestOrigin() {
        try {
            return PatientPortalSettings.get().Nurse_Request_Origin__c;
        } catch (Exception e) {
            return null;   // the portal is not set up in this org
        }
    }

    /** Dynamic, so this compiles and runs in an org without Messaging. */
    private static Integer countChats(Datetime since) {
        try {
            return Database.countQueryWithBinds(
                'SELECT COUNT() FROM MessagingSession WHERE CreatedDate >= :since',
                new Map<String, Object>{ 'since' => since },
                AccessLevel.SYSTEM_MODE);
        } catch (Exception e) {
            return 0;
        }
    }
}
