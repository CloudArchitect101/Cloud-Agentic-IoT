/*
 * MyDevicesAgentAction.cls
 *
 * The patient agent's read action: what the signed-in patient's own devices
 * report. Which patient comes from the chat itself (the MessagingSession the
 * agent is in, bound from $Context.RoutableId, never typed by the model), so
 * a patient cannot ask about anybody else's device by naming it: a device on
 * another account answers "not found", like one that does not exist.
 *
 * Staff use the Patient Care Agent and DeviceReadingsAgentAction, which read
 * as the staff member. This action never serves a staff request.
 *
 * Its own class because Apex allows one @InvocableMethod per class.
 */
public with sharing class MyDevicesAgentAction {

    public class MyDevicesRequest {
        @InvocableVariable(required=true label='Messaging Session ID'
            description='The Id of this conversation (MessagingSession). Bound from the context variable RoutableId; never ask the patient for it.')
        public String messagingSessionId;

        @InvocableVariable(label='Device ID'
            description='Optional: one of the patient\'s device serial numbers, for example Test8, to read only that device.')
        public String deviceId;

        @InvocableVariable(label='Number of Readings'
            description='How many of the latest readings per device, newest first. 5 if empty, at most 20.')
        public Integer readingCount;
    }

    public class MyDevicesResult {
        @InvocableVariable(label='Success') public Boolean success;
        @InvocableVariable(label='Message') public String message;
        @InvocableVariable(label='Patient Verified'
            description='True only when the chat is signed in as a portal patient.')
        public Boolean patientVerified;
        @InvocableVariable(label='Device Count') public Integer deviceCount;
        @InvocableVariable(label='Devices'
            description='One block per device: its serial number, connection status, then its readings, newest first.')
        public String devices;
    }

    @InvocableMethod(
        label='Get My Devices'
        description='Returns the signed-in patient\'s own monitoring devices, whether each is connected, and their latest readings.'
        category='Patient Portal')
    public static List<MyDevicesResult> getMyDevices(List<MyDevicesRequest> requests) {
        List<MyDevicesResult> results = new List<MyDevicesResult>();
        for (MyDevicesRequest req : requests == null ? new List<MyDevicesRequest>() : requests) {
            results.add(answer(req));
        }
        return results;
    }

    private static MyDevicesResult answer(MyDevicesRequest req) {
        MyDevicesResult res = new MyDevicesResult();
        res.success = false;
        res.patientVerified = false;
        res.deviceCount = 0;
        res.devices = '';
        PortalIdentityService.Identity who = PortalIdentityService.forMessagingSession(
            req == null ? null : req.messagingSessionId);
        if (!who.isPatient()) {
            res.message = who.reason;
            return res;
        }
        res.patientVerified = true;
        List<PatientDeviceService.Device> mine =
            PatientDeviceService.devicesFor(who.accountId, req.deviceId, req.readingCount);
        res.success = true;
        res.deviceCount = mine.size();
        if (mine.isEmpty()) {
            res.message = String.isBlank(req.deviceId)
                ? 'No monitoring device is linked to your account yet.'
                : 'No device ' + req.deviceId.trim() + ' is linked to your account.';
            return res;
        }
        List<String> blocks = new List<String>();
        for (PatientDeviceService.Device device : mine) {
            blocks.add(describe(device));
        }
        res.devices = String.join(blocks, '\n\n');
        res.message = mine.size() + ' device' + (mine.size() == 1 ? '' : 's') + ' linked to your account.';
        return res;
    }

    @TestVisible
    private static String describe(PatientDeviceService.Device device) {
        List<String> lines = new List<String>{
            'Device ' + device.serialNumber + ' (' + device.name + '): '
                + (String.isBlank(device.connectionStatus) ? 'connection unknown' : device.connectionStatus)
                + (device.connectionSince == null ? '' : ' since ' + utc(device.connectionSince))
        };
        if (device.readings.isEmpty()) {
            lines.add('  no readings yet');
        }
        for (PatientDeviceService.Reading r : device.readings) {
            lines.add('  ' + (r.at == null ? 'unknown time' : utc(r.at))
                + ': temperature ' + value(r.temperature, ' C')
                + ', humidity ' + value(r.humidity, ' %')
                + (r.heartRate == null ? '' : ', heart rate ' + value(r.heartRate, ' bpm'))
                + (r.spO2 == null ? '' : ', SpO2 ' + value(r.spO2, ' %'))
                + (r.roomTemperatureAlert ? ', raised-temperature flag set' : ''));
        }
        return String.join(lines, '\n');
    }

    private static String utc(Datetime at) {
        return at.formatGmt('yyyy-MM-dd HH:mm') + ' UTC';
    }

    private static String value(Decimal measured, String unit) {
        return measured == null ? 'not measured' : measured.toPlainString() + unit;
    }
}
