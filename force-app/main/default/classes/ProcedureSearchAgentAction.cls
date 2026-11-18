/*
 * ProcedureSearchAgentAction.cls
 *
 * The Patient Care Agent's Find Procedure action: the ward standard operating
 * procedure passages that answer a question, each with the SOP ID, version
 * and title the agent cites. The procedures live in the repo
 * (knowledge/sops), are embedded into an index on every AWS deploy, and are
 * searched by the procedure-search function behind the device API's
 * POST /find-procedure. docs/SOP-GROUNDING.md explains the design.
 *
 * One callout per question, through DeviceApiClient and the AWS_IoT_Relay
 * Named Credential, as the person talking to the agent: they need the
 * AWS_IoT_Relay_Callers permission set, like everyone whose actions reach
 * AWS. AWS masks personal data in the passages before they leave; they are
 * masked again here with PiiMaskingService, so nothing depends on one side
 * alone. Read-only: no record is read or written, so no DML stands in the
 * way of the callout.
 *
 * Its own class because Apex allows one @InvocableMethod per class.
 */
public with sharing class ProcedureSearchAgentAction {

    /** Passages returned when the agent does not say how many. */
    @TestVisible
    private static final Integer DEFAULT_PASSAGES = 3;

    /** The most procedure-search returns for one question. */
    @TestVisible
    private static final Integer MAX_PASSAGES = 5;

    /** Each question is one callout, so one call asks at most this many. */
    @TestVisible
    private static final Integer MAX_QUESTIONS_PER_CALL = 5;

    /** What procedure-search accepts; a longer question is cut to this. */
    @TestVisible
    private static final Integer MAX_QUESTION_CHARS = 500;

    @TestVisible
    private static final String NO_MATCH = 'No ward procedure matches that question. Say so plainly, do not answer '
        + 'from memory, and suggest asking the charge nurse.';

    // What to tell the person, by the reason code procedure-search sends.
    private static final Map<String, String> ADVICE = new Map<String, String>{
        'no-index'         => 'No ward procedures are indexed yet. An admin runs scripts/index-sops.sh, or scripts/deploy-aws.sh, for this environment.',
        'bedrock-denied'   => 'AWS could not use the embedding model the procedure search needs. An admin checks Amazon Bedrock in the AWS account.',
        'bedrock-busy'     => 'The procedure search is busy. Try again in a minute.',
        'embedding-failed' => 'The procedure search could not read the question. Try again, or rephrase it.',
        'index-unreadable' => 'The procedure search could not read its index. An admin checks the cloud-agentic-iot-procedure-search log.',
        'bad-request'      => 'The procedure search did not take the question. Ask it in a few words of plain text.'
    };

    public class ProcedureRequest {
        @InvocableVariable(required=true label='Question'
            description='What the user needs a procedure for, in their words, for example "room reads 31 C" or "SOP-WARD-003".')
        public String question;

        @InvocableVariable(label='Number of Passages'
            description='How many passages to return, best first. 3 if empty, at most 5.')
        public Integer passageCount;
    }

    public class ProcedureResult {
        @InvocableVariable(label='Success') public Boolean success;
        @InvocableVariable(label='Message') public String message;
        @InvocableVariable(label='Passages'
            description='The passages, best first. Each starts with its SOP ID, version, title and section in square brackets.')
        public String passages;
        @InvocableVariable(label='Citations'
            description='The SOP ID and version of each passage, for example SOP-WARD-001 v1.2, in the order given.')
        public String citations;
        @InvocableVariable(label='Top Procedure ID') public String topProcedureId;
        @InvocableVariable(label='Top Procedure Title') public String topProcedureTitle;
        @InvocableVariable(label='Passages Returned') public Integer passagesReturned;
        @InvocableVariable(label='Notice') public String notice;
    }

    @InvocableMethod(
        label='Find Procedure'
        description='Finds the ward standard operating procedure passages that answer a question, with the SOP ID, version and title of each to cite.'
        category='Patient Care')
    public static List<ProcedureResult> findProcedure(List<ProcedureRequest> requests) {
        List<ProcedureResult> results = new List<ProcedureResult>();
        DeviceApiClient client;
        Integer asked = 0;
        for (ProcedureRequest req : requests == null ? new List<ProcedureRequest>() : requests) {
            ProcedureResult res = new ProcedureResult();
            res.success = false;
            res.passagesReturned = 0;
            results.add(res);

            String question = (req == null || req.question == null) ? '' : req.question.trim();
            if (question.length() < 3) {
                res.message = 'Say what you need a procedure for, in a few words.';
                continue;
            }
            if (asked >= MAX_QUESTIONS_PER_CALL) {
                res.message = 'Too many questions in one request; ask at most ' + MAX_QUESTIONS_PER_CALL + '.';
                continue;
            }
            if (client == null) {
                client = new DeviceApiClient();
            }
            if (!client.canCall()) {
                res.message = 'This request has no callout left for the procedure search. Ask again.';
                continue;
            }
            asked++;
            DeviceApiClient.Result result = client.post('find-procedure', new Map<String, Object>{
                'query'      => question.left(MAX_QUESTION_CHARS),
                'maxResults' => clamp(req.passageCount)
            });
            describe(res, result);
        }
        return results;
    }

    private static void describe(ProcedureResult res, DeviceApiClient.Result result) {
        Map<String, Object> body = readJson(result.body);
        if (!result.succeeded()) {
            res.message = adviceFor(result, body);
            return;
        }
        if (body == null || !(body.get('passages') instanceof List<Object>)) {
            res.message = 'The procedure search answered with something this action cannot read. '
                + 'An admin deploys the current AWS code (scripts/deploy-aws.sh).';
            return;
        }
        res.success = true;
        if (body.get('notice') != null) {
            res.notice = String.valueOf(body.get('notice'));
        }

        List<String> blocks = new List<String>();
        List<String> cited = new List<String>();
        for (Object item : (List<Object>) body.get('passages')) {
            if (!(item instanceof Map<String, Object>)) {
                continue;
            }
            Map<String, Object> passage = (Map<String, Object>) item;
            String sopId = text(passage.get('sopId'));
            String version = text(passage.get('version'));
            String title = text(passage.get('title'));
            if (res.topProcedureId == null) {
                res.topProcedureId = sopId;
                res.topProcedureTitle = title;
            }
            String citation = sopId + ' v' + version;
            if (!cited.contains(citation)) {
                cited.add(citation);
            }
            blocks.add('[' + citation + ', ' + title + ', section "' + text(passage.get('section')) + '"]\n'
                + PiiMaskingService.mask(text(passage.get('text'))).maskedText);
        }
        res.passagesReturned = blocks.size();
        if (blocks.isEmpty()) {
            res.message = NO_MATCH;
            res.passages = '';
            res.citations = '';
            return;
        }
        res.passages = String.join(blocks, '\n\n');
        res.citations = String.join(cited, '; ');
        res.message = blocks.size() + ' passage' + (blocks.size() == 1 ? '' : 's') + ' from ' + res.citations
            + ', best first. Cite the SOP ID and version of each passage you use. '
            + 'These are sample procedures, not clinical advice.';
    }

    private static String adviceFor(DeviceApiClient.Result result, Map<String, Object> body) {
        Integer status = result.statusCode;
        Object reason = body == null ? null : body.get('reason');
        if (reason != null && ADVICE.containsKey(String.valueOf(reason))) {
            return ADVICE.get(String.valueOf(reason));
        } else if (status == 0) {
            return 'Salesforce could not reach the procedure search. If this keeps happening, ask an admin for '
                + 'access to the AWS_IoT_Relay external credential (the AWS_IoT_Relay_Callers permission set).';
        } else if (status == 404) {
            return 'The device API has no find-procedure route yet. An admin deploys the current AWS stacks (scripts/deploy-aws.sh).';
        } else if (status == 401 || status == 403) {
            return 'AWS refused the AWS_IoT_Relay credential. An admin checks the named credential and its IAM role.';
        } else if (status == 503 && result.body != null && result.body.contains('Placeholder')) {
            return 'The procedure search still runs placeholder code. An admin runs scripts/deploy-aws.sh.';
        } else if (result.isTransient()) {
            return 'The procedure search did not answer. Try again in a minute.';
        }
        return 'The procedure search refused the question (HTTP ' + status + ').';
    }

    private static Integer clamp(Integer requested) {
        if (requested == null || requested < 1) {
            return DEFAULT_PASSAGES;
        }
        return Math.min(requested, MAX_PASSAGES);
    }

    private static String text(Object value) {
        return value == null ? '' : String.valueOf(value);
    }

    private static Map<String, Object> readJson(String body) {
        try {
            Object parsed = JSON.deserializeUntyped(body);
            return parsed instanceof Map<String, Object> ? (Map<String, Object>) parsed : null;
        } catch (Exception e) {
            return null;
        }
    }
}
