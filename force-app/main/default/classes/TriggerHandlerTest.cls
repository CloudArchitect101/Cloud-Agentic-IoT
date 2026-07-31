@IsTest
private class TriggerHandlerTest {

    /* A handler that records which hooks fired, so the dispatch logic itself
       can be tested without needing a real trigger on a real object. */
    private class SpyHandler extends TriggerHandler {
        public List<String> hooksFired = new List<String>();
        protected override void handleBeforeInsert()  { hooksFired.add('BEFORE_INSERT'); }
        protected override void handleAfterInsert()   { hooksFired.add('AFTER_INSERT'); }
        protected override void handleAfterUpdate()   { hooksFired.add('AFTER_UPDATE'); }
    }

    @IsTest
    static void runOutsideTriggerContextFailsLoudly() {
        // Calling run() from plain Apex is a programming error: there is no
        // trigger context to dispatch on. Failing beats silently doing nothing.
        Boolean threwAsExpected = false;
        try {
            new SpyHandler().run();
        } catch (TriggerHandler.TriggerHandlerException expected) {
            threwAsExpected = true;
        }
        Assert.isTrue(threwAsExpected,
            'run() outside a trigger must throw rather than silently no-op');
    }

    @IsTest
    static void bypassPreventsAHandlerFromRunning() {
        TriggerHandler.bypass('CaseTriggerHandler');
        Assert.isTrue(TriggerHandler.isBypassed('CaseTriggerHandler'),
            'A bypassed handler reports itself as bypassed');

        TriggerHandler.clearBypass('CaseTriggerHandler');
        Assert.isFalse(TriggerHandler.isBypassed('CaseTriggerHandler'),
            'Clearing the bypass restores the handler');
    }

    @IsTest
    static void clearAllBypassesRestoresEveryHandler() {
        TriggerHandler.bypass('CaseTriggerHandler');
        TriggerHandler.bypass('QueueDepthChangeTriggerHandler');

        TriggerHandler.clearAllBypasses();

        Assert.isFalse(TriggerHandler.isBypassed('CaseTriggerHandler'), 'Cleared');
        Assert.isFalse(TriggerHandler.isBypassed('QueueDepthChangeTriggerHandler'), 'Cleared');
    }

    @IsTest
    static void bypassStopsRealTriggerSideEffects() {
        // The practical reason bypass exists: loading fixture data without
        // firing the integrations that would try to reach AWS for each record.
        Group careTeamQueue = new Group(
            Name = 'Bypass Test Queue', DeveloperName = 'Bypass_Test_Queue', Type = 'Queue'
        );
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert careTeamQueue;
            insert new QueueSobject(QueueId = careTeamQueue.Id, SobjectType = 'Case');
        }

        Test.startTest();
        TriggerHandler.bypass('CaseTriggerHandler');
        // No HttpCalloutMock is registered: if the handler ran and reached the
        // relay callout, this insert would fail with an unmocked callout error.
        insert new Case(Subject = 'Loaded with integrations bypassed', OwnerId = careTeamQueue.Id);
        TriggerHandler.clearAllBypasses();
        Test.stopTest();

        Assert.areEqual(1, [SELECT COUNT() FROM Case WHERE Subject = 'Loaded with integrations bypassed'],
            'The record still saves; only the integration is skipped');
    }
}
