/*
 * PortalDevicesResource.cls
 *
 * GET /services/apexrest/portal/my-devices?readings=10
 *
 * The patient portal's dashboard: the signed-in patient's own devices and
 * their latest readings. Called through the React site's Data SDK
 * (sdk.fetch), as the patient. The account comes from the patient's User
 * row, so no parameter can widen it; staff and guests get 403.
 */
@RestResource(urlMapping='/portal/my-devices')
global with sharing class PortalDevicesResource {

    @TestVisible
    private class MyDevices {
        public Boolean patient;
        public String message;
        public List<PatientDeviceService.Device> devices;
    }

    @HttpGet
    global static void get() {
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.addHeader('Cache-Control', 'no-store');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(myDevices(), true));
    }

    @TestVisible
    private static MyDevices myDevices() {
        MyDevices body = new MyDevices();
        body.patient = false;
        body.devices = new List<PatientDeviceService.Device>();
        PortalIdentityService.Identity who = PortalIdentityService.forCurrentUser();
        if (!who.isPatient()) {
            if (RestContext.response != null) {
                RestContext.response.statusCode = 403;
            }
            body.message = who.reason;
            return body;
        }
        Integer readings = 10;
        String asked = RestContext.request == null ? null : RestContext.request.params.get('readings');
        if (String.isNotBlank(asked) && asked.isNumeric()) {
            readings = Integer.valueOf(asked);
        }
        body.patient = true;
        body.devices = PatientDeviceService.withLatestFromAws(PatientDeviceService.devicesFor(who.accountId, readings));
        body.message = body.devices.isEmpty() ? 'No monitoring device is linked to your account yet.' : null;
        return body;
    }
}
