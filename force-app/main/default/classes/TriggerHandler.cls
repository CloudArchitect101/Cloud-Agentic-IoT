/*
 * TriggerHandler.cls
 *
 * Base class every trigger handler in this project extends. The trigger file
 * itself becomes a single line; this class decides which context method to
 * call; the handler subclass routes to a service; the service holds the logic.
 *
 * Why a framework at all, rather than if/else in the trigger:
 *
 *   1. A trigger cannot be unit tested directly - you can only test it by
 *      performing DML and hoping. A handler is an ordinary class you can
 *      instantiate and call.
 *   2. Trigger context (Trigger.new, Trigger.isBefore, ...) is only readable
 *      inside a trigger, so logic written there is stuck there.
 *   3. Bypass and recursion control need one place to live.
 *
 * For readers coming from Python: this is the Template Method pattern. The
 * base class owns the algorithm (work out the context, call the right hook);
 * subclasses override only the hooks they need - much like overriding
 * get_queryset() or form_valid() on a Django class-based view rather than
 * rewriting dispatch().
 */
public virtual class TriggerHandler {

    /*
     * Handlers currently switched off, by class name. Data loads and test
     * setup routinely need to insert records WITHOUT firing integrations -
     * otherwise a 200-record test fixture tries to provision 200 real devices
     * in AWS. Comparable to temporarily disconnecting a Django signal.
     */
    private static Set<String> bypassedHandlerNames = new Set<String>();

    /*
     * How many times each handler has run in this transaction. A trigger that
     * updates its own object re-enters itself; without a ceiling that is an
     * infinite loop that dies on a governor limit with an unhelpful error.
     */
    private static Map<String, Integer> executionCountByHandlerName = new Map<String, Integer>();

    private static final Integer MAX_EXECUTIONS_PER_TRANSACTION = 5;

    /* Set from Trigger context so subclasses and tests can both reach it. */
    @TestVisible
    protected TriggerOperation currentTriggerOperation;

    @TestVisible
    protected String handlerName {
        get { return String.valueOf(this).split(':')[0]; }
    }

    /**
     * Entry point. Every trigger file in this project contains exactly one
     * statement: `new SomethingTriggerHandler().run();`
     */
    public void run() {
        if (!isRunningInsideTrigger()) {
            // Called from a test or from Apex directly - the subclass hooks are
            // public, so call those instead. Failing loudly here beats silently
            // doing nothing and leaving someone puzzled.
            throw new TriggerHandlerException(
                handlerName + '.run() was called outside a trigger context. '
                + 'Call the specific handler method directly instead.'
            );
        }

        if (isBypassed(handlerName)) {
            return;
        }

        if (hasExceededRecursionLimit()) {
            // Deliberately silent rather than thrown: recursion is usually a
            // cascade of legitimate updates settling down, and throwing would
            // roll back the user's save for what is a self-correcting condition.
            System.debug(LoggingLevel.WARN,
                handlerName + ' hit the recursion ceiling of '
                + MAX_EXECUTIONS_PER_TRANSACTION + ' and will not run again this transaction.');
            return;
        }

        this.currentTriggerOperation = Trigger.operationType;
        recordThisExecution();

        switch on this.currentTriggerOperation {
            when BEFORE_INSERT  { this.handleBeforeInsert(); }
            when BEFORE_UPDATE  { this.handleBeforeUpdate(); }
            when BEFORE_DELETE  { this.handleBeforeDelete(); }
            when AFTER_INSERT   { this.handleAfterInsert(); }
            when AFTER_UPDATE   { this.handleAfterUpdate(); }
            when AFTER_DELETE   { this.handleAfterDelete(); }
            when AFTER_UNDELETE { this.handleAfterUndelete(); }
        }
    }

    /*
     * Context hooks. Subclasses override only the ones their object needs;
     * the empty defaults mean a handler that only cares about after-insert
     * says so by overriding exactly one method.
     */
    protected virtual void handleBeforeInsert()  {}
    protected virtual void handleBeforeUpdate()  {}
    protected virtual void handleBeforeDelete()  {}
    protected virtual void handleAfterInsert()   {}
    protected virtual void handleAfterUpdate()   {}
    protected virtual void handleAfterDelete()   {}
    protected virtual void handleAfterUndelete() {}

    /* ------------------------------------------------------------ bypass */

    /** Switch a handler off for the rest of this transaction. */
    public static void bypass(String handlerNameToBypass) {
        bypassedHandlerNames.add(handlerNameToBypass);
    }

    /** Switch a previously bypassed handler back on. */
    public static void clearBypass(String handlerNameToRestore) {
        bypassedHandlerNames.remove(handlerNameToRestore);
    }

    /** Switch every handler back on. Useful in test teardown. */
    public static void clearAllBypasses() {
        bypassedHandlerNames.clear();
    }

    public static Boolean isBypassed(String handlerNameToCheck) {
        return bypassedHandlerNames.contains(handlerNameToCheck);
    }

    /* --------------------------------------------------------- recursion */

    private Boolean hasExceededRecursionLimit() {
        Integer executionsSoFar = executionCountByHandlerName.get(handlerName);
        return executionsSoFar != null && executionsSoFar >= MAX_EXECUTIONS_PER_TRANSACTION;
    }

    private void recordThisExecution() {
        Integer executionsSoFar = executionCountByHandlerName.get(handlerName);
        executionCountByHandlerName.put(handlerName, executionsSoFar == null ? 1 : executionsSoFar + 1);
    }

    @TestVisible
    private static void resetExecutionCounts() {
        executionCountByHandlerName.clear();
    }

    /* ----------------------------------------------------------- context */

    @TestVisible
    private Boolean isRunningInsideTrigger() {
        return Trigger.isExecuting;
    }

    public class TriggerHandlerException extends Exception {}
}
