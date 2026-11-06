@IsTest
private class PlatformUsageControllerTest {

    /**
     * One person for one test, so a test needs one spare Salesforce license
     * at a time. A viewer holds Platform_Usage_Viewer. A null profile name
     * means the profile of whoever runs the tests: an admin's in every
     * deploy, so it has View Setup and Configuration.
     */
    private static User newUser(String profileName, Boolean viewer) {
        Id profileId = profileName == null
            ? UserInfo.getProfileId()
            : [SELECT Id FROM Profile WHERE Name = :profileName].Id;
        // Usernames are unique across every org, so each carries the org's Id
        // and a random part, in case tests run side by side.
        String who = 'usage-' + (viewer ? 'viewer' : 'outsider') + '-'
            + EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(8);
        User person = new User(
            Username          = who + '@' + UserInfo.getOrganizationId() + '.example.com',
            Email             = who + '@example.com',
            LastName          = who,
            Alias             = 'usage',
            ProfileId         = profileId,
            TimeZoneSidKey    = UserInfo.getTimeZone().getID(),
            LocaleSidKey      = UserInfo.getLocale(),
            LanguageLocaleKey = UserInfo.getLanguage(),
            EmailEncodingKey  = 'UTF-8'
        );
        insert person;
        if (viewer) {
            insert new PermissionSetAssignment(
                AssigneeId      = person.Id,
                PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Platform_Usage_Viewer'].Id
            );
        }
        return person;
    }

    private static DeviceApiMock useApi() {
        DeviceTestSettings.use();
        DeviceApiMock api = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, api);
        return api;
    }

    private static String refusalOf(Boolean aws) {
        try {
            if (aws) {
                PlatformUsageController.awsSpend();
            } else {
                PlatformUsageController.salesforceLimits();
            }
        } catch (AuraHandledException e) {
            return e.getMessage();
        }
        return null;
    }

    /** No answer at all: a timeout, or a credential Salesforce could not use. */
    private class Unreachable implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            throw new CalloutException('Read timed out');
        }
    }

    @IsTest
    static void awsSpendReturnsTheAnswerAndKeepsASnapshot() {
        DeviceApiMock api = useApi();
        User viewer = newUser(null, true);
        Map<String, Object> result;
        System.runAs(viewer) {
            Test.startTest();
            result = PlatformUsageController.awsSpend();
            Test.stopTest();
        }
        Assert.areEqual(new List<String>{ 'aws-spend' }, api.paths, 'one POST /aws-spend');
        Assert.isTrue(api.bodies[0].isEmpty(), 'its body is {}');
        Map<String, Object> answer = (Map<String, Object>) result.get('answer');
        Map<String, Object> spent = (Map<String, Object>) answer.get('spent');
        Map<String, Object> awsLimit = (Map<String, Object>) answer.get('limit');
        Assert.areEqual(3.42, spent.get('amount'), 'spent this month');
        Assert.areEqual('name', awsLimit.get('chosenBy'), 'the budget named for the card');
        Assert.isNull(result.get('error'), 'no error');
        Assert.isNull(result.get('lastKnown'), 'no last known spend when AWS answered');
        Assert.isTrue(Aws_Spend_Snapshot__c.getOrgDefaults().Spent_Usd__c == 3.42, 'the snapshot keeps the spend');
    }

    @IsTest
    static void eachKindOfAwsFailureSaysWhatToDo() {
        DeviceApiMock api = useApi();
        User viewer = newUser(null, true);
        // status, body, advice the error must contain
        List<List<Object>> cases = new List<List<Object>>{
            new List<Object>{ 502, '{"reason":"budgets-denied"}', 'Check AwsSpendRole' },
            new List<Object>{ 502, '{"reason":"budgets-error"}', 'aws-spend log' },
            new List<Object>{ 503, '{"reason":"aws-busy"}', 'Budgets is busy' },
            new List<Object>{ 500, '{"reason":"misconfigured"}', 'missing a setting' },
            new List<Object>{ 400, '{"reason":"bad-request"}', 'current Salesforce code' },
            new List<Object>{ 404, '{"message":"Not Found"}', 'deploy the current queue-relay stack' },
            new List<Object>{ 403, '{"message":"Forbidden"}', 'Check the named credential and its IAM role' },
            new List<Object>{ 503, 'Placeholder - the deploy pipeline replaces this with the real bundle', 'placeholder code' },
            new List<Object>{ 429, '{"message":"Too Many Requests"}', 'throttled' },
            new List<Object>{ 500, '{"message":"Internal Server Error"}', 'near its spend limit' }
        };
        System.runAs(viewer) {
            Test.startTest();
            for (List<Object> failure : cases) {
                api.spendStatus = (Integer) failure[0];
                api.spendBody = (String) failure[1];
                Map<String, Object> result = PlatformUsageController.awsSpend();
                String error = (String) result.get('error');
                Assert.isNull(result.get('answer'), 'no answer for HTTP ' + failure[0]);
                Assert.isTrue(error.contains((String) failure[2]), 'HTTP ' + failure[0] + ': ' + error);
                Assert.isTrue(error.contains('(HTTP ' + failure[0] + ': '), 'the reason is quoted: ' + error);
            }
            Test.setMock(HttpCalloutMock.class, new Unreachable());
            Map<String, Object> unreachable = PlatformUsageController.awsSpend();
            String error = (String) unreachable.get('error');
            Assert.isNull(unreachable.get('answer'), 'no answer without a connection');
            Assert.isTrue(error.contains('could not reach AWS'), error);
            Assert.isTrue(error.contains('(HTTP 0: '), 'the reason is quoted: ' + error);
            Test.stopTest();
        }
    }

    @IsTest
    static void aFailureShowsTheLastKnownSpend() {
        DeviceApiMock api = useApi();
        User viewer = newUser(null, true);
        Map<String, Object> result;
        System.runAs(viewer) {
            Test.startTest();
            PlatformUsageController.awsSpend();
            // In an org these are two page loads. Here both run in one
            // transaction, so the second callout follows the snapshot's DML,
            // which Salesforce may refuse; the card shows the same either way.
            api.spendStatus = 500;
            api.spendBody = '{"message":"Internal Server Error"}';
            result = PlatformUsageController.awsSpend();
            Test.stopTest();
        }
        Assert.isNull(result.get('answer'), 'no answer');
        Assert.isNotNull(result.get('error'), 'the error');
        Map<String, Object> lastKnown = (Map<String, Object>) result.get('lastKnown');
        Assert.isTrue((Decimal) lastKnown.get('spent') == 3.42, 'the last spend AWS reported: ' + lastKnown);
        Assert.isTrue((Decimal) lastKnown.get('limit') == 20, 'and its limit: ' + lastKnown);
        Assert.areEqual('2026-11', lastKnown.get('month'), 'for its month');
        Assert.isNotNull(lastKnown.get('readAt'), 'with when it was read');
    }

    @IsTest
    static void anAwsAccountIdNeverReachesTheCard() {
        DeviceApiMock api = useApi();
        User viewer = newUser(null, true);
        Map<String, Object> refused;
        Map<String, Object> answered;
        System.runAs(viewer) {
            Test.startTest();
            // API Gateway refusing the signed call, quoting the caller's ARN as AWS does.
            api.spendStatus = 403;
            api.spendBody = '{"message":"User: arn:aws:sts::111122223333:assumed-role/SalesforceCallerRole/sf is not authorized"}';
            refused = PlatformUsageController.awsSpend();
            // Then a budget named after the account. The refusal comes first,
            // because no callout may follow the snapshot's DML.
            api.spendStatus = 200;
            api.spendBody = null;
            ((Map<String, Object>) api.spendAnswer.get('limit')).put('name', '111122223333-monthly');
            answered = PlatformUsageController.awsSpend();
            Test.stopTest();
        }
        String error = (String) refused.get('error');
        Assert.isFalse(error.contains('111122223333'), 'the error holds no account ID: ' + error);
        Assert.isTrue(error.contains('arn:aws:sts::[account]:'), 'the rest of the reason is kept: ' + error);

        Map<String, Object> answer = (Map<String, Object>) answered.get('answer');
        Assert.areEqual('[account]-monthly', ((Map<String, Object>) answer.get('limit')).get('name'), 'the budget name, masked');
        Assert.isFalse(JSON.serialize(answered).contains('111122223333'), 'the answer holds no account ID');
        Assert.areEqual('[account]-monthly', Aws_Spend_Snapshot__c.getOrgDefaults().Limit_Name__c, 'nor does the snapshot');
    }

    @IsTest
    static void anUnreadableAnswerIsRefusedWithoutQuotingIt() {
        DeviceApiMock api = useApi();
        api.spendBody = '<html>Service Unavailable</html>';
        User viewer = newUser(null, true);
        Map<String, Object> result;
        System.runAs(viewer) {
            Test.startTest();
            result = PlatformUsageController.awsSpend();
            Test.stopTest();
        }
        String error = (String) result.get('error');
        Assert.isNull(result.get('answer'), 'no answer');
        Assert.isTrue(error.contains('cannot read'), error);
        Assert.isFalse(error.contains('<html>'), 'the answer itself is not quoted: ' + error);
        Assert.isNull(Aws_Spend_Snapshot__c.getOrgDefaults().Read_At__c, 'no snapshot is written');
    }

    @IsTest
    static void salesforceLimitsListsTheOrgsLimitsAndWhatThisRequestUsed() {
        User viewer = newUser(null, true);
        Map<String, Object> answer;
        System.runAs(viewer) {
            Test.startTest();
            answer = PlatformUsageController.salesforceLimits();
            Test.stopTest();
        }
        Assert.isInstanceOfType(answer.get('asOf'), Datetime.class, 'when the limits were read');

        Set<String> names = new Set<String>();
        for (Map<String, Object> item : (List<Map<String, Object>>) answer.get('orgLimits')) {
            names.add((String) item.get('name'));
        }
        Assert.isTrue(names.contains('DailyApiRequests'), 'every org has DailyApiRequests: ' + names);

        List<String> perRequest = new List<String>();
        for (Map<String, Object> item : (List<Map<String, Object>>) answer.get('thisRequest')) {
            perRequest.add((String) item.get('name'));
            Assert.isTrue((Integer) item.get('max') > 0, 'a per-request limit: ' + item);
        }
        Assert.areEqual(new List<String>{ 'CpuTimeMs', 'HeapBytes', 'SoqlQueries', 'QueryRows', 'DmlStatements', 'Callouts' },
            perRequest, 'the six per-request limits');

        Map<String, Object> entitlements = (Map<String, Object>) answer.get('entitlements');
        Assert.isTrue(entitlements.get('rows') instanceof List<Map<String, Object>>, 'rows, empty or not: ' + entitlements);
        Assert.isTrue(entitlements.containsKey('error'), 'and the error that kept them back, if any: ' + entitlements);
    }

    @IsTest
    static void withoutThePermissionSetNeitherHalfIsShown() {
        DeviceApiMock api = useApi();
        User admin = newUser(null, false);
        List<String> refusals = new List<String>();
        System.runAs(admin) {
            Test.startTest();
            refusals.add(refusalOf(true));
            refusals.add(refusalOf(false));
            Test.stopTest();
        }
        for (String message : refusals) {
            Assert.isTrue(message != null && message.contains('for admins'), 'refused: ' + message);
        }
        Assert.isTrue(api.paths.isEmpty(), 'AWS is asked nothing for someone who may not see it');
    }

    @IsTest
    static void withoutViewSetupNeitherHalfIsShown() {
        DeviceApiMock api = useApi();
        User standard = newUser('Standard User', true);
        List<String> refusals = new List<String>();
        System.runAs(standard) {
            Test.startTest();
            refusals.add(refusalOf(true));
            refusals.add(refusalOf(false));
            Test.stopTest();
        }
        for (String message : refusals) {
            Assert.isTrue(message != null && message.contains('for admins'), 'refused: ' + message);
        }
        Assert.isTrue(api.paths.isEmpty(), 'AWS is asked nothing for someone who may not see it');
    }
}
