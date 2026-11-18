/*
 * DeviceApiMock.cls
 *
 * Plays the AWS device API in tests. It answers the way the Lambdas do: one
 * result per device, HTTP 207 when some of them failed, and the status a test
 * asks for (429, 500, 403...) when a test wants the whole request to fail.
 * POST /device-live gets what the device-live Lambda answers for one device.
 */
@IsTest
public class DeviceApiMock implements HttpCalloutMock {

    public Integer statusCode = 200;
    public Set<String> refusedThingNames = new Set<String>();
    public Set<String> busyThingNames = new Set<String>();
    /** Leftover Things the mock keeps, as AWS does one that has a certificate. */
    public Set<String> keptThingNames = new Set<String>();
    public List<String> paths = new List<String>();
    public List<Map<String, Object>> bodies = new List<Map<String, Object>>();
    /**
     * How long each bundle link is. A real one is signed with a Lambda's
     * temporary credentials, so it carries their session token and runs to
     * well over a thousand characters. A test can make it longer still.
     */
    public Integer bundleUrlLength = 1500;

    public HttpResponse respond(HttpRequest request) {
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(request.getBody());
        paths.add(request.getEndpoint().substringAfterLast('/'));
        bodies.add(body);

        HttpResponse response = new HttpResponse();
        response.setHeader('Content-Type', 'application/json');
        if (statusCode != 200) {
            response.setStatusCode(statusCode);
            response.setBody('{"message":"mock answered ' + statusCode + '"}');
            return response;
        }
        if (request.getEndpoint().endsWith('/device-live')) {
            response.setStatusCode(200);
            response.setBody(JSON.serialize(liveAnswer(body)));
            return response;
        }

        List<Object> results = new List<Object>();
        Boolean anyFailed = false;
        for (Map<String, Object> device : devicesIn(body)) {
            String thingName = (String) device.get('thingName');
            Map<String, Object> result = new Map<String, Object>{ 'thingName' => thingName };
            if (refusedThingNames.contains(thingName)) {
                result.putAll(new Map<String, Object>{ 'ok' => false, 'deleted' => false,
                    'error' => 'InvalidRequestException: refused by the mock' });
                anyFailed = true;
            } else if (busyThingNames.contains(thingName)) {
                result.putAll(new Map<String, Object>{ 'ok' => false, 'deleted' => false, 'retryable' => true,
                    'error' => 'ThrottlingException: Rate exceeded' });
                anyFailed = true;
            } else if (keptThingNames.contains(thingName)) {
                result.putAll(new Map<String, Object>{ 'deleted' => false, 'kept' => true,
                    'reason' => thingName + ' has a certificate, so it may be another device\'s.' });
            } else {
                result.putAll(new Map<String, Object>{
                    'ok' => true, 'deleted' => true, 'published' => true,
                    'thingArn' => 'arn:aws:iot:ca-central-1:111122223333:thing/' + thingName,
                    'certificateId' => 'cert-' + thingName,
                    'thingGroup' => device.get('thingGroup'),
                    'bundleUrl' => bundleUrl(thingName)
                });
            }
            results.add(result);
        }
        response.setStatusCode(anyFailed ? 207 : 200);
        response.setBody(JSON.serialize(new Map<String, Object>{ 'results' => results, 'historyPreserved' => true }));
        return response;
    }

    /**
     * The newest stored reading and the patient's state, and for mode start a
     * live session too. The link only looks like a signed one.
     */
    private static Map<String, Object> liveAnswer(Map<String, Object> body) {
        String thingName = (String) body.get('thingName');
        Map<String, Object> answer = new Map<String, Object>{
            'thingName' => thingName,
            'latest'    => new Map<String, Object>{
                'temperature' => 22.5, 'humidity' => 41, 'at' => '2026-11-06T05:29:30.000Z'
            },
            'state'     => new Map<String, Object>{
                'patientState' => 'STABLE', 'riskScore' => 0.12, 'updatedAt' => '2026-11-06T05:00:00.000Z'
            }
        };
        if ((String) body.get('mode') == 'start') {
            answer.put('live', new Map<String, Object>{
                'url'              => 'wss://example-ats.iot.us-east-2.amazonaws.com/mqtt?X-Amz-Signature=' + '0'.repeat(64),
                'clientId'         => 'live-' + thingName + '-1a2b3c4d',
                'topic'            => 'device/' + thingName + '/live',
                'expiresAt'        => '2026-11-06T05:45:00.000Z',
                'seconds'          => 2,
                'minutes'          => 15,
                'commandPublished' => true
            });
        }
        return answer;
    }

    private String bundleUrl(String thingName) {
        String link = 'https://bundles.s3.us-east-2.amazonaws.com/provisioning/' + thingName
            + '.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=' + '0'.repeat(64)
            + '&X-Amz-Security-Token=';
        return link + 'A'.repeat(Math.max(0, bundleUrlLength - link.length()));
    }

    /** Every device a request names, whichever shape it uses. */
    public static List<Map<String, Object>> devicesIn(Map<String, Object> body) {
        List<Map<String, Object>> devices = new List<Map<String, Object>>();
        if (body.get('devices') != null) {
            for (Object device : (List<Object>) body.get('devices')) {
                devices.add((Map<String, Object>) device);
            }
        } else if (body.get('thingNames') != null || body.get('leftoverThingNames') != null) {
            for (String listName : new List<String>{ 'thingNames', 'leftoverThingNames' }) {
                if (body.get(listName) == null) {
                    continue;
                }
                for (Object thingName : (List<Object>) body.get(listName)) {
                    devices.add(new Map<String, Object>{ 'thingName' => thingName });
                }
            }
        } else if (body.get('commands') != null) {
            for (Object command : (List<Object>) body.get('commands')) {
                devices.add(new Map<String, Object>{ 'thingName' => ((Map<String, Object>) command).get('deviceId') });
            }
        }
        return devices;
    }

    public Integer devicesSent() {
        Integer total = 0;
        for (Map<String, Object> body : bodies) {
            total += devicesIn(body).size();
        }
        return total;
    }
}
