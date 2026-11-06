/*
 * DeviceLiveController.cls
 *
 * Server side of the live card on a device's record page (lwc/deviceLiveCard).
 * Each call is one callout to the device API's POST /device-live:
 *
 *   start   tells the board to send a reading every couple of seconds for the
 *           next 15 minutes, and returns a signed WebSocket link, valid 15
 *           minutes, that lets this one card receive them from AWS IoT.
 *   latest  only the newest stored reading and the patient's state.
 *
 * The readings themselves never pass through Salesforce: the browser takes
 * them straight from AWS IoT. Watching a board so costs Salesforce one call
 * when the card opens and one every 10 minutes while it stays open, and
 * creates no records.
 *
 * Both answers carry the Asset's own connection fields as well, so the card
 * can show a connect or disconnect that happened after the page loaded.
 */
public with sharing class DeviceLiveController {

    @AuraEnabled
    public static Map<String, Object> start(Id assetId) {
        return ask(assetId, 'start');
    }

    @AuraEnabled
    public static Map<String, Object> latest(Id assetId) {
        return ask(assetId, 'latest');
    }

    private static Map<String, Object> ask(Id assetId, String mode) {
        Asset device = deviceFor(assetId);
        String thingName = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
        if (thingName == null) {
            throw refusal('This device has no AWS IoT Thing yet. Provision it first.');
        }

        DeviceApiClient.Result result = new DeviceApiClient().post('device-live',
            new Map<String, Object>{ 'thingName' => thingName, 'mode' => mode });
        if (!result.succeeded()) {
            throw refusal(failureMessage(result));
        }

        // The answer of a start holds the signed link, so it is never logged,
        // and an answer that cannot be read is not quoted back either.
        Map<String, Object> answer;
        try {
            answer = (Map<String, Object>) JSON.deserializeUntyped(result.body);
        } catch (Exception e) {
            answer = null;
        }
        if (answer == null) {
            throw refusal('The device API answered HTTP ' + result.statusCode + ' with something the card cannot read. '
                + 'Deploy the current queue-relay stack.');
        }
        answer.put('connection', new Map<String, Object>{
            'status'               => device.Connection_Status__c,
            'since'                => device.Connection_Since__c,
            'lastDisconnectReason' => device.Last_Disconnect_Reason__c
        });
        return answer;
    }

    private static Asset deviceFor(Id assetId) {
        List<Asset> devices;
        try {
            // User mode: a device, or a field, this user may not see is not read.
            devices = [
                SELECT Id, Thing_ARN__c, Connection_Status__c, Connection_Since__c, Last_Disconnect_Reason__c
                FROM Asset
                WHERE Id = :assetId
                WITH USER_MODE
                LIMIT 1
            ];
        } catch (QueryException e) {
            // User mode refuses the whole query when any field in it is hidden from the user.
            throw refusal('You need read access to this device\'s Thing ARN and connection fields. '
                + 'Ask an admin for the Device Platform Admin permission set.');
        }
        if (devices.isEmpty()) {
            throw refusal('This device no longer exists, or you do not have access to it.');
        }
        return devices[0];
    }

    // What the person looking at the card can do about a failed call. The
    // summary carries the API's own reason; a failed answer holds no link.
    private static String failureMessage(DeviceApiClient.Result result) {
        String advice;
        if (result.statusCode == 0) {
            advice = 'Salesforce could not reach the device API. If the reason mentions the credential, '
                + 'ask an admin for access to the AWS_IoT_Relay external credential.';
        } else if (result.statusCode == 404) {
            advice = 'The device API has no device-live route yet: deploy the current queue-relay stack.';
        } else if (result.statusCode == 401 || result.statusCode == 403) {
            advice = 'AWS refused the AWS_IoT_Relay credential. Check the named credential and its IAM role.';
        } else if (result.isTransient()) {
            advice = 'AWS is busy or unreachable. Reload the page in a minute.';
        } else {
            advice = 'The device API refused the request.';
        }
        return 'Live status is unavailable. ' + advice + ' (' + result.summary() + ')';
    }

    private static AuraHandledException refusal(String message) {
        AuraHandledException e = new AuraHandledException(message);
        // Without this, getMessage() says "Script-thrown exception" in tests and logs.
        e.setMessage(message);
        return e;
    }
}
