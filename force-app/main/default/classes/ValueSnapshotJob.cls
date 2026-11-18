/**
 * Takes the daily Business Value snapshot (ValueSnapshotService).
 *
 * Schedule it once, nightly at 01:00:
 *   System.schedule('Business Value snapshot', '0 0 1 * * ?', new ValueSnapshotJob());
 * or take one now from Flow or the dashboard's setup steps with the
 * invocable action "Take Business Value Snapshot". docs/BUSINESS-VALUE.md.
 */
public with sharing class ValueSnapshotJob implements Schedulable {

    public void execute(SchedulableContext context) {
        ValueSnapshotService.takeSnapshot();
    }

    @InvocableMethod(label='Take Business Value Snapshot'
        description='Measures the trailing window and saves today\'s Value Snapshot for the Business Value dashboard.')
    public static List<Id> takeNow(List<String> ignored) {
        return new List<Id>{ ValueSnapshotService.takeSnapshot().Id };
    }
}
