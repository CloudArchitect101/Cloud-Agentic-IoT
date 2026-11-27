/*
 * DeviceCommandService.cls
 *
 * What happens when a Device Command is created: by hand, from Send Command
 * on a device's Asset. prepare (before
 * insert) makes the command ready to send, and send (after insert) starts
 * the job that sends it. A trigger cannot call out, so the callouts happen
 * in DeviceCommandSendJob.
 *
 * prepare fills in what the creator left out, Status Pending and Requested
 * By the creator's name, and ties the command to a board:
 *
 *   - A command on an Asset goes to that Asset's board, so Device ID becomes
 *     the Asset's Thing name: the name in its Thing ARN, or its serial number
 *     before it is provisioned. A Device ID that is neither the Thing name nor
 *     the serial number is refused: one record would name two boards.
 *   - A command that names only a Device ID is linked to the one Asset with
 *     that serial number, when exactly one has it and that Asset's board is
 *     the Thing of that name. It then shows on the device, and the send job
 *     can check that the board is provisioned and online before calling out.
 *     An Asset whose serial number was edited after it was provisioned is
 *     still the Thing it was provisioned as, so it is not linked: the command
 *     would show on a device whose board does not get it, or go to a board
 *     its creator did not name.
 *   - A Device ID that is not linked is sent as it is. Slack names a board by
 *     its Thing name, and a board does not need an Asset to take a command.
 *
 * Serial numbers and Thing names are compared exactly: AWS IoT Thing names
 * are case-sensitive, so CompanyInternalESP32 and companyinternalesp32 are two boards, while SOQL compares
 * text regardless of case.
 *
 * With sharing: a command is linked only to an Asset its creator can see.
 */
public with sharing class DeviceCommandService {

    public static final String PENDING = 'Pending';
    public static final String SENT = 'Sent';
    public static final String ACKED = 'Acked';
    public static final String FAILED = 'Failed';

    /** Before insert. */
    public static void prepare(List<Device_Command__c> commands) {
        Set<Id> assetIds = new Set<Id>();
        Set<String> serialNumbers = new Set<String>();
        for (Device_Command__c command : commands) {
            if (String.isBlank(command.Status__c)) {
                command.Status__c = PENDING;
            }
            if (String.isBlank(command.Requested_By__c)) {
                command.Requested_By__c = UserInfo.getName().abbreviate(80);
            }
            if (command.Asset__c != null) {
                assetIds.add(command.Asset__c);
            } else if (String.isNotBlank(command.Device__c)) {
                serialNumbers.add(command.Device__c);
            }
        }
        if (assetIds.isEmpty() && serialNumbers.isEmpty()) {
            return;
        }

        Map<Id, Asset> devicesById = new Map<Id, Asset>();
        Map<String, List<Asset>> devicesBySerialNumber = new Map<String, List<Asset>>();
        for (Asset device : devicesFor(assetIds, serialNumbers)) {
            devicesById.put(device.Id, device);
            if (String.isBlank(device.SerialNumber) || !serialNumbers.contains(device.SerialNumber)) {
                continue;   // asked for by Id, or the same serial number in another case
            }
            List<Asset> withSerialNumber = devicesBySerialNumber.get(device.SerialNumber);
            if (withSerialNumber == null) {
                withSerialNumber = new List<Asset>();
                devicesBySerialNumber.put(device.SerialNumber, withSerialNumber);
            }
            withSerialNumber.add(device);
        }

        for (Device_Command__c command : commands) {
            if (command.Asset__c == null && String.isNotBlank(command.Device__c)) {
                List<Asset> withSerialNumber = devicesBySerialNumber.get(command.Device__c);
                if (withSerialNumber != null && withSerialNumber.size() == 1
                        && command.Device__c.equals(thingNameOf(withSerialNumber[0]))) {
                    command.Asset__c = withSerialNumber[0].Id;
                }
            }
            if (command.Asset__c != null) {
                sendToItsThing(command, devicesById.get(command.Asset__c));
            }
        }
    }

    /**
     * After insert: one job sends every Pending command of the save. A
     * command saved in another Status, such as one loaded with its history,
     * is not sent.
     */
    public static void send(List<Device_Command__c> commands) {
        List<Id> pendingIds = new List<Id>();
        for (Device_Command__c command : commands) {
            if (command.Status__c == PENDING) {
                pendingIds.add(command.Id);
            }
        }
        if (pendingIds.isEmpty()) {
            return;
        }
        if (Limits.getQueueableJobs() >= Limits.getLimitQueueableJobs()) {
            // Refused rather than saved: a Pending command that no job will
            // ever send would look as if it were on its way.
            for (Device_Command__c command : commands) {
                if (command.Status__c == PENDING) {
                    command.addError('Salesforce has no background job left in this transaction to send this command, '
                        + 'so it was not saved. Create it again on its own.');
                }
            }
            return;
        }
        System.enqueueJob(new DeviceCommandSendJob(pendingIds));
    }

    /**
     * The Assets the commands name by Id, and those with one of the serial
     * numbers, in one query. On a large Asset table Salesforce refuses a
     * trigger's query on a field without an index, and SerialNumber has none.
     * Then the commands that name only a Device ID are not linked, and are
     * still sent by it, rather than every command in the save failing. The
     * serial numbers are cleared, so that none is linked from the Assets read
     * by Id alone: they need not be every Asset with that serial number.
     */
    private static List<Asset> devicesFor(Set<Id> assetIds, Set<String> serialNumbers) {
        if (serialNumbers.isEmpty()) {
            return devicesWithIds(assetIds);
        }
        try {
            return [
                SELECT Id, Name, RecordTypeId, SerialNumber, Thing_ARN__c
                FROM Asset
                WHERE Id IN :assetIds OR SerialNumber IN :serialNumbers
            ];
        } catch (QueryException e) {
            System.debug(LoggingLevel.WARN, 'Device Commands not linked to Assets by serial number: ' + e.getMessage());
            serialNumbers.clear();
            return devicesWithIds(assetIds);
        }
    }

    private static List<Asset> devicesWithIds(Set<Id> assetIds) {
        if (assetIds.isEmpty()) {
            return new List<Asset>();
        }
        return [SELECT Id, Name, RecordTypeId, SerialNumber, Thing_ARN__c FROM Asset WHERE Id IN :assetIds];
    }

    // Device ID becomes the Thing name of the command's Asset, unless it
    // already names another board.
    private static void sendToItsThing(Device_Command__c command, Asset device) {
        if (device == null) {
            command.Asset__c.addError('This device was not found, or you cannot see it. '
                + 'Choose a device you can open, or leave Device empty and enter the Device ID.');
            return;
        }
        String thingName = thingNameOf(device);
        if (thingName == null) {
            command.Asset__c.addError(device.Name + ' has no Serial Number and no Thing ARN, '
                + 'so no board can take this command. Give it a Serial Number and provision it first.');
            return;
        }
        if (String.isBlank(command.Device__c)
                || thingName.equals(command.Device__c)
                || command.Device__c.equals(device.SerialNumber)) {
            command.Device__c = thingName;
            return;
        }
        command.Device__c.addError('Device ID ' + command.Device__c + ' is not the board of ' + device.Name
            + ', whose Thing name is ' + thingName + '. Leave Device ID empty, or enter ' + thingName + '.');
    }

    /** The Thing the Asset's board is: the name in its Thing ARN, else its serial number. */
    private static String thingNameOf(Asset device) {
        String provisionedAs = DeviceProvisioningService.thingNameIn(device.Thing_ARN__c);
        if (provisionedAs != null) {
            return provisionedAs;
        }
        return String.isBlank(device.SerialNumber) ? null : device.SerialNumber;
    }
}
