/*
 * DeviceApiClient.cls
 *
 * Every Salesforce to AWS callout goes through here: the device API behind the
 * Named Credential in Device_Platform_Setting__mdt, signed with SigV4.
 *
 * It also keeps a transaction inside Salesforce's callout limits, which is
 * what lets the jobs that use it handle any number of devices. A transaction
 * may make 100 callouts and spend 120 seconds in them; going past either
 * throws a LimitException that cannot be caught, and everything the
 * transaction did is lost. canCall() says no while there is still room for one
 * more full-length callout, and the job hands the rest of its work to the next
 * job instead.
 */
public with sharing class DeviceApiClient {

    // Salesforce's cumulative callout time per transaction.
    private static final Long TRANSACTION_CALLOUT_MILLIS = 120000;

    private final Integer timeoutMillis;
    private final Integer calloutCap;
    private Integer calloutsMade = 0;
    private Long millisSpent = 0;

    public class Result {
        public Integer statusCode;
        public String body;

        public Boolean succeeded() {
            return statusCode >= 200 && statusCode < 300;
        }

        /**
         * AWS was busy or unreachable: 429, a 5xx, or no answer at all
         * (statusCode 0). Worth trying again later. Anything else, such as a
         * 400 or a 403 from a misconfigured Named Credential, fails the same
         * way every time.
         */
        public Boolean isTransient() {
            return statusCode == 0 || statusCode == 429 || (statusCode >= 500 && statusCode != 501);
        }

        public String summary() {
            return 'HTTP ' + statusCode + ': ' + (body == null ? '' : body.abbreviate(200));
        }
    }

    public DeviceApiClient() {
        this.timeoutMillis = DevicePlatformSettings.calloutTimeoutMillis();
        this.calloutCap = DevicePlatformSettings.calloutsPerJob();
    }

    /** True while one more callout fits in this job and in this transaction. */
    public Boolean canCall() {
        return calloutsMade < calloutCap
            && Limits.getCallouts() < Limits.getLimitCallouts()
            && millisSpent + timeoutMillis <= TRANSACTION_CALLOUT_MILLIS;
    }

    public Integer calloutsMade() {
        return calloutsMade;
    }

    /** POSTs body as JSON to the device API. Never throws for a failed call: the Result says what happened. */
    public Result post(String path, Object body) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(DevicePlatformSettings.endpoint(path));
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setTimeout(timeoutMillis);
        request.setBody(JSON.serialize(body));

        Result result = new Result();
        Long started = System.currentTimeMillis();
        try {
            HttpResponse response = new Http().send(request);
            result.statusCode = response.getStatusCode();
            result.body = response.getBody();
        } catch (CalloutException e) {
            // A timeout or a connection that never opened.
            result.statusCode = 0;
            result.body = e.getMessage();
        }
        calloutsMade++;
        millisSpent += System.currentTimeMillis() - started;
        return result;
    }
}
