/*
 * ProcedureSearchAgentActionTest.cls
 *
 * The agent's Find Procedure action: one POST /find-procedure per question,
 * the passages back with what the agent cites, personal data masked again,
 * a plain answer when nothing matches, and advice an admin can act on for
 * each way the call can fail. DeviceApiMock plays procedure-search.
 */
@IsTest
private class ProcedureSearchAgentActionTest {

    private static DeviceApiMock useApi() {
        DeviceTestSettings.use();
        DeviceApiMock api = new DeviceApiMock();
        Test.setMock(HttpCalloutMock.class, api);
        return api;
    }

    private static ProcedureSearchAgentAction.ProcedureRequest ask(String question, Integer passageCount) {
        ProcedureSearchAgentAction.ProcedureRequest req = new ProcedureSearchAgentAction.ProcedureRequest();
        req.question = question;
        req.passageCount = passageCount;
        return req;
    }

    private static ProcedureSearchAgentAction.ProcedureResult one(ProcedureSearchAgentAction.ProcedureRequest req) {
        List<ProcedureSearchAgentAction.ProcedureResult> results =
            ProcedureSearchAgentAction.findProcedure(new List<ProcedureSearchAgentAction.ProcedureRequest>{ req });
        Assert.areEqual(1, results.size(), 'one result per request');
        return results[0];
    }

    /** No answer at all: a timeout, or a credential Salesforce could not use. */
    private class Unreachable implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            throw new CalloutException('Read timed out');
        }
    }

    @IsTest
    static void passagesComeBackWithWhatTheAgentCites() {
        DeviceApiMock api = useApi();
        Test.startTest();
        ProcedureSearchAgentAction.ProcedureResult res = one(ask('  The room reads 31 C, what do I do?  ', null));
        Test.stopTest();

        Assert.areEqual(new List<String>{ 'find-procedure' }, api.paths, 'one POST /find-procedure');
        Assert.areEqual('The room reads 31 C, what do I do?', api.bodies[0].get('query'), 'the question, trimmed');
        Assert.areEqual(ProcedureSearchAgentAction.DEFAULT_PASSAGES, api.bodies[0].get('maxResults'), 'three when not asked');

        Assert.isTrue(res.success, res.message);
        Assert.areEqual(2, res.passagesReturned);
        Assert.areEqual('SOP-WARD-001', res.topProcedureId);
        Assert.areEqual('Room temperature excursion', res.topProcedureTitle);
        Assert.areEqual('SOP-WARD-001 v1.2', res.citations, 'one citation per SOP version, however many passages');
        Assert.isTrue(res.passages.startsWith('[SOP-WARD-001 v1.2, Room temperature excursion, section "Steps"]\n1. Take the Case'),
            res.passages);
        Assert.isTrue(res.passages.contains('\n\n[SOP-WARD-001 v1.2, Room temperature excursion, section "When this applies"]'),
            'passages in the order AWS ranked them');
        Assert.isTrue(res.message.contains('Cite the SOP ID and version'), res.message);
        Assert.isTrue(res.notice.contains('not clinical advice'), res.notice);
    }

    @IsTest
    static void passageCountIsClampedAndLongQuestionsAreCut() {
        DeviceApiMock api = useApi();
        Test.startTest();
        ProcedureSearchAgentAction.findProcedure(new List<ProcedureSearchAgentAction.ProcedureRequest>{
            ask('room temperature', 9), ask('room temperature', 0), ask('x'.repeat(800), 2)
        });
        Test.stopTest();
        Assert.areEqual(ProcedureSearchAgentAction.MAX_PASSAGES, api.bodies[0].get('maxResults'));
        Assert.areEqual(ProcedureSearchAgentAction.DEFAULT_PASSAGES, api.bodies[1].get('maxResults'));
        Assert.areEqual(2, api.bodies[2].get('maxResults'));
        Assert.areEqual(ProcedureSearchAgentAction.MAX_QUESTION_CHARS, ((String) api.bodies[2].get('query')).length());
    }

    @IsTest
    static void personalDataInAPassageIsMaskedHereToo() {
        DeviceApiMock api = useApi();
        api.procedurePassages = new List<Object>{ new Map<String, Object>{
            'sopId' => 'SOP-WARD-002', 'title' => 'Medication storage humidity out of range', 'version' => '1.0',
            'section' => 'Steps', 'text' => 'Email pharmacy.lead@example.com or call 416-555-0199.'
        } };
        Test.startTest();
        ProcedureSearchAgentAction.ProcedureResult res = one(ask('humidity in the medication store', 1));
        Test.stopTest();
        Assert.isTrue(res.success, res.message);
        Assert.isFalse(res.passages.contains('pharmacy.lead@example.com'), res.passages);
        Assert.isFalse(res.passages.contains('416-555-0199'), res.passages);
        Assert.isTrue(res.passages.contains('[EMAIL_1]'), res.passages);
        Assert.areEqual('SOP-WARD-002 v1.0', res.citations);
    }

    @IsTest
    static void noMatchIsAPlainAnswerNotAGuess() {
        DeviceApiMock api = useApi();
        api.procedurePassages = new List<Object>();
        Test.startTest();
        ProcedureSearchAgentAction.ProcedureResult res = one(ask('zebra xylophone', null));
        Test.stopTest();
        Assert.isTrue(res.success, 'the search worked; it found nothing');
        Assert.areEqual(0, res.passagesReturned);
        Assert.areEqual(ProcedureSearchAgentAction.NO_MATCH, res.message);
        Assert.areEqual('', res.passages);
        Assert.areEqual('', res.citations);
        Assert.isNull(res.topProcedureId);
    }

    @IsTest
    static void blankQuestionsAndTooManyQuestionsMakeNoCallout() {
        DeviceApiMock api = useApi();
        List<ProcedureSearchAgentAction.ProcedureRequest> requests = new List<ProcedureSearchAgentAction.ProcedureRequest>{
            null, ask(null, null), ask('  ', null), ask('hi', null)
        };
        for (Integer i = 0; i < ProcedureSearchAgentAction.MAX_QUESTIONS_PER_CALL + 1; i++) {
            requests.add(ask('room temperature ' + i, null));
        }
        Test.startTest();
        List<ProcedureSearchAgentAction.ProcedureResult> results = ProcedureSearchAgentAction.findProcedure(requests);
        Test.stopTest();

        Assert.areEqual(requests.size(), results.size(), 'a result for every request, in order');
        for (Integer i = 0; i < 4; i++) {
            Assert.isFalse(results[i].success);
            Assert.isTrue(results[i].message.startsWith('Say what you need'), results[i].message);
        }
        Assert.areEqual(ProcedureSearchAgentAction.MAX_QUESTIONS_PER_CALL, api.paths.size(), 'one callout per question, up to the cap');
        ProcedureSearchAgentAction.ProcedureResult last = results[results.size() - 1];
        Assert.isFalse(last.success);
        Assert.isTrue(last.message.startsWith('Too many questions'), last.message);

        Assert.areEqual(0, ProcedureSearchAgentAction.findProcedure(null).size());
    }

    @IsTest
    static void eachFailureSaysWhatToDo() {
        DeviceApiMock api = useApi();
        // status, body (null for the mock's own), what the message must say
        List<List<Object>> cases = new List<List<Object>>{
            new List<Object>{ 503, '{"reason":"no-index","error":"x"}', 'scripts/index-sops.sh' },
            new List<Object>{ 502, '{"reason":"bedrock-denied"}', 'Amazon Bedrock' },
            new List<Object>{ 429, '{"reason":"bedrock-busy"}', 'busy' },
            new List<Object>{ 502, '{"reason":"embedding-failed"}', 'rephrase' },
            new List<Object>{ 502, '{"reason":"index-unreadable"}', 'procedure-search log' },
            new List<Object>{ 400, '{"reason":"bad-request"}', 'plain text' },
            new List<Object>{ 404, '{"message":"Not Found"}', 'no find-procedure route' },
            new List<Object>{ 403, '{"message":"Forbidden"}', 'AWS_IoT_Relay credential' },
            new List<Object>{ 401, null, 'AWS_IoT_Relay credential' },
            new List<Object>{ 503, 'Placeholder - the deploy pipeline replaces this', 'placeholder code' },
            new List<Object>{ 500, 'Internal Server Error', 'Try again in a minute' },
            new List<Object>{ 418, '[]', 'HTTP 418' },
            new List<Object>{ 200, 'not json', 'cannot read' },
            new List<Object>{ 200, '{"passages":"nope"}', 'cannot read' }
        };
        Test.startTest();
        for (List<Object> c : cases) {
            api.procedureStatus = (Integer) c[0];
            api.procedureBody = (String) c[1];
            ProcedureSearchAgentAction.ProcedureResult res = one(ask('room temperature', null));
            Assert.isFalse(res.success, String.valueOf(c));
            Assert.isTrue(res.message.contains((String) c[2]), c[0] + ' ' + c[1] + ' -> ' + res.message);
            Assert.areEqual(0, res.passagesReturned);
        }
        Test.stopTest();
    }

    @IsTest
    static void unreachableAwsPointsAtTheCredential() {
        DeviceTestSettings.use();
        Test.setMock(HttpCalloutMock.class, new Unreachable());
        Test.startTest();
        ProcedureSearchAgentAction.ProcedureResult res = one(ask('room temperature', null));
        Test.stopTest();
        Assert.isFalse(res.success);
        Assert.isTrue(res.message.contains('AWS_IoT_Relay_Callers'), res.message);
    }

    @IsTest
    static void passagesThatAreNotObjectsAreSkipped() {
        DeviceApiMock api = useApi();
        api.procedurePassages = new List<Object>{ 'not a passage', new Map<String, Object>{
            'sopId' => 'SOP-WARD-003', 'title' => 'Room monitor offline', 'version' => '1.1', 'section' => 'Steps', 'text' => null
        } };
        Test.startTest();
        ProcedureSearchAgentAction.ProcedureResult res = one(ask('monitor offline', null));
        Test.stopTest();
        Assert.isTrue(res.success, res.message);
        Assert.areEqual(1, res.passagesReturned);
        Assert.areEqual('SOP-WARD-003', res.topProcedureId);
        Assert.isTrue(res.message.startsWith('1 passage from SOP-WARD-003 v1.1'), res.message);
    }

    @IsTest
    static void thePatientCareAgentPermissionSetOpensTheAction() {
        Id classId = [SELECT Id FROM ApexClass WHERE Name = 'ProcedureSearchAgentAction'].Id;
        Integer grants = [
            SELECT COUNT() FROM SetupEntityAccess
            WHERE Parent.Name = 'Patient_Care_Agent' AND SetupEntityId = :classId
        ];
        Assert.areEqual(1, grants, 'Patient_Care_Agent must give its users the Find Procedure action');
    }
}
