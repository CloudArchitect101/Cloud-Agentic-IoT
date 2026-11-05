/*
 * DeviceApiMock.cls
 *
 * Plays the AWS device API in tests. It answers the way the Lambdas do: one
 * result per device, HTTP 207 when some of them failed, and the status a test
 * asks for (429, 500, 403...) when a test wants the whole request to fail.
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
                    'bundleUrl' => 'https://bundles.s3.amazonaws.com/' + thingName + '?signed'
                });
            }
            results.add(result);
        }
        response.setStatusCode(anyFailed ? 207 : 200);
        response.setBody(JSON.serialize(new Map<String, Object>{ 'results' => results, 'historyPreserved' => true }));
        return response;
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
