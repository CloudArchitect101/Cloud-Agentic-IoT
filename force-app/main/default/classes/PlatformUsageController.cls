/*
 * PlatformUsageController.cls
 *
 * Server side of the usage card on the Cloud Agentic IoT app's Home page
 * (lwc/platformUsageCard). The card calls each method once when the page
 * loads and never again until the next load: nothing here polls.
 *
 *   awsSpend          this month's AWS spend and its limit: one callout to
 *                     the device API's POST /aws-spend. When AWS does not
 *                     answer, it adds the last spend AWS did report.
 *   salesforceLimits  the org's limits (System.OrgLimits), its usage-based
 *                     entitlements, and what this request used of the
 *                     per-request limits (System.Limits).
 *
 * Two methods, so AWS being unreachable never blanks the Salesforce half.
 * Costs are for admins: both refuse anyone without the View_Platform_Usage
 * custom permission AND View Setup and Configuration. Every run of 12 digits
 * that comes back from AWS is masked: the card never shows an account ID.
 */
public with sharing class PlatformUsageController {

    private static final String VIEW_PERMISSION = 'View_Platform_Usage';

    // What the admin can do, by the reason code the aws-spend function sends.
    private static final Map<String, String> ADVICE = new Map<String, String>{
        'budgets-denied' => 'AWS would not show budgets to the aws-spend function. Check AwsSpendRole in the queue-relay stack.',
        'budgets-error'  => 'AWS Budgets refused the request. See the cloud-agentic-iot-aws-spend log in CloudWatch.',
        'aws-busy'       => 'AWS Budgets is busy. Reload the page in a minute.',
        'misconfigured'  => 'The aws-spend function is missing a setting: deploy the current queue-relay stack.',
        'bad-request'    => 'The device API did not take the request: deploy the current Salesforce code.'
    };

    /*
     * Returns { answer, error, lastKnown }: what POST /aws-spend said (null
     * when it failed), what to do about a failure (null when none), and the
     * last spend AWS did report (only with an error).
     */
    @AuraEnabled
    public static Map<String, Object> awsSpend() {
        requireViewer();
        DeviceApiClient.Result result = new DeviceApiClient().post('aws-spend', new Map<String, Object>());
        Map<String, Object> body = readJson(result.body);
        String error;
        if (!result.succeeded()) {
            error = adviceFor(result, body) + ' (' + withoutAccountIds(result.summary()) + ')';
        } else if (body == null) {
            // An answer that cannot be read is refused, and not quoted back.
            error = 'AWS answered HTTP ' + result.statusCode + ' with something the card cannot read. '
                + 'Deploy the current queue-relay stack.';
        } else {
            remember(body); // after the callout: Salesforce allows no callout after DML
        }
        return new Map<String, Object>{
            'answer'    => error == null ? body : null,
            'error'     => error,
            'lastKnown' => error == null ? null : lastKnown()
        };
    }

    @AuraEnabled
    public static Map<String, Object> salesforceLimits() {
        requireViewer();
        List<Map<String, Object>> orgWide = new List<Map<String, Object>>();
        for (System.OrgLimit item : System.OrgLimits.getAll()) {
            orgWide.add(usage(item.getName(), item.getValue(), item.getLimit()));
        }
        Map<String, Object> answer = new Map<String, Object>{
            'asOf'         => Datetime.now(),
            'orgLimits'    => orgWide,
            'entitlements' => entitlements()
        };
        answer.put('thisRequest', thisRequest()); // last, so it counts everything above
        return answer;
    }

    /*
     * CPU time and heap exist only per transaction: Salesforce keeps no total
     * for the org. So these are what this request used, against the limits
     * every synchronous request has. The card shows them as text, not bars.
     */
    private static List<Map<String, Object>> thisRequest() {
        return new List<Map<String, Object>>{
            usage('CpuTimeMs',     Limits.getCpuTime(),       Limits.getLimitCpuTime()),
            usage('HeapBytes',     Limits.getHeapSize(),      Limits.getLimitHeapSize()),
            usage('SoqlQueries',   Limits.getQueries(),       Limits.getLimitQueries()),
            usage('QueryRows',     Limits.getQueryRows(),     Limits.getLimitQueryRows()),
            usage('DmlStatements', Limits.getDMLStatements(), Limits.getLimitDMLStatements()),
            usage('Callouts',      Limits.getCallouts(),      Limits.getLimitCallouts())
        };
    }

    /*
     * Usage-based entitlements, as Setup shows them under Company
     * Information: the nearest thing to credits that Apex can read for free.
     * A string query, so the class deploys to an org without the object.
     * Returns { rows, error }: error names the exception when it fails.
     */
    private static Map<String, Object> entitlements() {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        try {
            for (SObject row : Database.query(
                    'SELECT MasterLabel, Frequency, AmountUsed, CurrentAmountAllowed FROM TenantUsageEntitlement LIMIT 100',
                    AccessLevel.USER_MODE)) {
                Map<String, Object> entry = usage((String) row.get('MasterLabel'), row.get('AmountUsed'), row.get('CurrentAmountAllowed'));
                entry.put('frequency', row.get('Frequency'));
                rows.add(entry);
            }
        } catch (Exception e) {
            return new Map<String, Object>{ 'rows' => rows, 'error' => e.getTypeName() };
        }
        return new Map<String, Object>{ 'rows' => rows, 'error' => null };
    }

    // The last spend AWS reported, so the card has a figure when AWS stops answering.
    private static void remember(Map<String, Object> answer) {
        Map<String, Object> spent = (Map<String, Object>) answer.get('spent');
        if (spent == null || spent.get('amount') == null) {
            return;
        }
        Map<String, Object> awsLimit = (Map<String, Object>) answer.get('limit');
        Aws_Spend_Snapshot__c snapshot = Aws_Spend_Snapshot__c.getOrgDefaults();
        snapshot.SetupOwnerId  = UserInfo.getOrganizationId();
        snapshot.Month__c      = (String) answer.get('month');
        snapshot.Spent_Usd__c  = decimalOf(spent.get('amount'));
        snapshot.Limit_Usd__c  = awsLimit == null ? null : decimalOf(awsLimit.get('amount'));
        snapshot.Limit_Name__c = awsLimit == null ? null : String.valueOf(awsLimit.get('name')).abbreviate(80);
        snapshot.Read_At__c    = Datetime.now();
        upsert snapshot;
    }

    private static Map<String, Object> lastKnown() {
        Aws_Spend_Snapshot__c snapshot = Aws_Spend_Snapshot__c.getOrgDefaults();
        if (snapshot == null || snapshot.Read_At__c == null) {
            return null;
        }
        return new Map<String, Object>{
            'month' => snapshot.Month__c, 'spent' => snapshot.Spent_Usd__c,
            'limit' => snapshot.Limit_Usd__c, 'limitName' => snapshot.Limit_Name__c,
            'readAt' => snapshot.Read_At__c
        };
    }

    // Admins only: the custom permission, and View Setup and Configuration
    // from the profile or any permission set (the profile's own permission
    // set is one of the user's assignments).
    private static void requireViewer() {
        Boolean allowed = FeatureManagement.checkPermission(VIEW_PERMISSION)
            && [SELECT COUNT() FROM PermissionSetAssignment
                WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSet.PermissionsViewSetup = true] > 0;
        if (!allowed) {
            throw refusal('Costs and limits are for admins. Ask an admin for the Platform Usage Viewer permission set.');
        }
    }

    private static String adviceFor(DeviceApiClient.Result result, Map<String, Object> body) {
        Integer status = result.statusCode;
        Object reason = body == null ? null : body.get('reason');
        if (status == 0) {
            return 'Salesforce could not reach AWS. If the reason mentions the credential, '
                + 'you need access to the AWS_IoT_Relay external credential.';
        } else if (reason != null && ADVICE.containsKey(String.valueOf(reason))) {
            return ADVICE.get(String.valueOf(reason));
        } else if (status == 404) {
            return 'The device API has no aws-spend route yet: deploy the current queue-relay stack.';
        } else if (status == 401 || status == 403) {
            return 'AWS refused the AWS_IoT_Relay credential. Check the named credential and its IAM role.';
        } else if (status == 503 && result.body != null && result.body.contains('Placeholder')) {
            return 'The aws-spend function still runs placeholder code: run scripts/deploy-aws.sh.';
        } else if (status == 429) {
            return 'API Gateway throttled the request. Reload the page in a minute.';
        } else if (result.isTransient()) {
            return 'AWS did not answer. An AWS project near its spend limit stops running Lambda functions: '
                + 'check AWS Settings, or reload the page in a minute.';
        }
        return 'The device API refused the request.';
    }

    private static Map<String, Object> readJson(String text) {
        try {
            return (Map<String, Object>) JSON.deserializeUntyped(withoutAccountIds(text));
        } catch (Exception e) {
            return null;
        }
    }

    private static Map<String, Object> usage(String name, Object used, Object max) {
        return new Map<String, Object>{ 'name' => name, 'used' => used, 'max' => max };
    }

    private static Decimal decimalOf(Object value) {
        return value == null ? null : Decimal.valueOf(String.valueOf(value));
    }

    // An AWS account ID is 12 digits, and the card must never show one.
    private static String withoutAccountIds(String text) {
        return text == null ? null : text.replaceAll('[0-9]{12}', '[account]');
    }

    private static AuraHandledException refusal(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message); // otherwise getMessage() says "Script-thrown exception"
        return e;
    }
}
