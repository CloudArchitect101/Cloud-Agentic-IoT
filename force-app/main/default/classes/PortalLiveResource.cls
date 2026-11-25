/*
 * PortalLiveResource.cls
 *
 * POST /services/apexrest/portal/live   { "serialNumber": "Test8" }
 *
 * The patient portal's live view, the same one the device card on an Asset
 * uses (DeviceLiveController): one callout to POST /device-live (mode start),
 * which tells the board to send a reading every couple of seconds for 15
 * minutes and returns a signed WebSocket link, valid 15 minutes, to that one
 * board's live topic. The browser then takes the readings straight from AWS
 * IoT. They never pass through Salesforce.
 *
 * Why: the portal used to ask GET /portal/my-devices every 30 seconds, and
 * every one of those is a Salesforce API request: 120 an hour for each open
 * page, so 10,000 patients with the page open an hour a day would be 1.2
 * million a day, far over any org's limit. Now an open page costs one call
 * when it opens and one every 10 minutes while it stays visible, and nothing
 * while it is hidden (docs/SCALING.md, "Salesforce API calls per device").
 *
 * Only a patient, and only for a device on their own account
 * (PatientDeviceService decides, from the session alone): any other serial
 * number is 404, the same answer as one that does not exist. The link lets
 * whoever holds it watch that one board for 15 minutes and do nothing else
 * (device-live's session policy). It is never logged.
 */
@RestResource(urlMapping='/portal/live')
global with sharing class PortalLiveResource {

    @HttpPost
    global static void post() {
        RestResponse response = RestContext.response;
        response.addHeader('Content-Type', 'application/json');
        response.addHeader('Cache-Control', 'no-store');
        Answer answer = start(RestContext.request == null || RestContext.request.requestBody == null
            ? null : RestContext.request.requestBody.toString());
        response.statusCode = answer.status;
        response.responseBody = Blob.valueOf(JSON.serialize(answer.body, true));
    }

    @TestVisible
    private class Answer {
        public Integer status;
        public Map<String, Object> body;
        Answer(Integer status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }
    }

    @TestVisible
    private static Answer start(String requestBody) {
        PortalIdentityService.Identity who = PortalIdentityService.forCurrentUser();
        if (!who.isPatient()) {
            return refused(403, who.reason);
        }
        String serial = serialIn(requestBody);
        if (serial == null) {
            return refused(400, 'Say which of your devices to watch: { "serialNumber": "..." }.');
        }
        if (PatientDeviceService.devicesFor(who.accountId, serial, 1).isEmpty()) {
            return refused(404, 'No such device on your account.');
        }

        DeviceApiClient.Result result = new DeviceApiClient().post('device-live',
            new Map<String, Object>{ 'thingName' => serial, 'mode' => 'start' });
        if (!result.succeeded()) {
            // The summary can quote AWS, never the link: a failed answer holds none.
            System.debug(LoggingLevel.WARN, 'Portal live view of ' + serial + ' unavailable: HTTP ' + result.statusCode);
            return refused(502, 'Live readings are unavailable right now. The page shows the last saved ones.');
        }
        Map<String, Object> aws;
        try {
            aws = (Map<String, Object>) JSON.deserializeUntyped(result.body);
        } catch (Exception e) {
            aws = null;
        }
        Object live = aws == null ? null : aws.get('live');
        if (!(live instanceof Map<String, Object>)) {
            return refused(502, 'Live readings are unavailable right now. The page shows the last saved ones.');
        }
        // Only what the page needs: the link, and whether the alert is on now.
        Map<String, Object> link = (Map<String, Object>) live;
        Object state = aws.get('state');
        return new Answer(200, new Map<String, Object>{
            'serialNumber' => serial,
            'live' => new Map<String, Object>{
                'url'       => link.get('url'),
                'clientId'  => link.get('clientId'),
                'topic'     => link.get('topic'),
                'expiresAt' => link.get('expiresAt'),
                'seconds'   => link.get('seconds')
            },
            'temperatureAlert' => state instanceof Map<String, Object>
                && ((Map<String, Object>) state).get('temperatureAlert') == true
        });
    }

    private static String serialIn(String requestBody) {
        if (String.isBlank(requestBody)) {
            return null;
        }
        try {
            Object raw = ((Map<String, Object>) JSON.deserializeUntyped(requestBody)).get('serialNumber');
            String serial = raw instanceof String ? ((String) raw).trim() : null;
            return String.isBlank(serial) || serial.length() > 128 ? null : serial;
        } catch (Exception e) {
            return null;
        }
    }

    private static Answer refused(Integer status, String message) {
        return new Answer(status, new Map<String, Object>{ 'message' => message });
    }
}
