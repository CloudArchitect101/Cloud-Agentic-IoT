/*
 * PortalDevicesResourceTest.cls
 *
 * The portal dashboard shows the signed-in patient their own devices, and
 * gives staff and anyone else a 403 and nothing.
 */
@IsTest
private class PortalDevicesResourceTest {

    @IsTest
    static void thePatientSeesOnlyTheirOwnDevice() {
        User owner = PatientPortalTestData.ownerWithRole();
        List<PatientPortalTestData.Patient> both;
        System.runAs(owner) {
            both = PatientPortalTestData.twoPatients();
        }
        User portal;
        System.runAs(PatientPortalTestData.me()) {
            portal = PatientPortalTestData.portalUser(both[1], 'dashboard-patient-b');
        }
        Assert.isNotNull(portal, 'This org has no Experience Cloud user licence (Customer Community): docs/PATIENT-PORTAL.md');
        RestContext.request = new RestRequest();
        RestContext.request.params.put('readings', '3');
        RestContext.response = new RestResponse();

        PortalDevicesResource.MyDevices body;
        System.runAs(portal) {
            body = PortalDevicesResource.myDevices();
        }

        Assert.isTrue(body.patient, body.message);
        Assert.areEqual(1, body.devices.size());
        Assert.areEqual(PatientPortalTestData.SERIAL_B, body.devices[0].serialNumber);
    }

    @IsTest
    static void staffGetA403AndNoDevices() {
        PatientPortalTestData.twoPatients();
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();

        PortalDevicesResource.MyDevices body = PortalDevicesResource.myDevices();

        Assert.areEqual(403, RestContext.response.statusCode);
        Assert.isFalse(body.patient);
        Assert.isTrue(body.devices.isEmpty());
    }

    @IsTest
    static void theEndpointWritesJson() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();
        PortalDevicesResource.get();
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(RestContext.response.responseBody.toString());
        Assert.areEqual(false, body.get('patient'));
    }
}
