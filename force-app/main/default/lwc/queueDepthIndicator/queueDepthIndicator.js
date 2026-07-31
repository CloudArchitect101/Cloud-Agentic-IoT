// An LWC is a standard Web Component with Salesforce's reactivity layer -
// closer to Lit than React. The class fields below are reactive: assign to
// them and the template re-renders, no setState() ceremony.
// empApi is the platform's streaming client: a managed WebSocket-style
// subscription to Platform Events, so this card consumes the same topic the
// physical servo does.
import { LightningElement, api } from 'lwc';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';

/**
 * Live queue-depth card. Subscribes to the same Queue_Depth_Change__e the
 * physical servo consumes, so the dashboard and the motor can never disagree -
 * they are two subscribers of one event, not two systems asking two questions.
 */
export default class QueueDepthIndicator extends LightningElement {
    // @api = a public property, like a prop in React/Lit. Admins set it
    // per-instance in App Builder without touching code - which is the whole
    // point: one component, any queue.
    @api queueDeveloperName = 'Care_Team_Queue';

    openCaseCount = null;
    intensity = 0;
    motorState = 'UNKNOWN';
    lastUpdate = null;
    subscription = null;

    async connectedCallback() {
        onError((error) => {
            // Streaming errors (token expiry, replay gaps) surface here rather
            // than silently freezing the card at a stale number.
            console.error('empApi error', JSON.stringify(error));
        });
        // -1 = new events only. A dashboard shows "now"; replaying history
        // would animate through stale states on every page load.
        this.subscription = await subscribe(
            '/event/Queue_Depth_Change__e',
            -1,
            (message) => this.handleEvent(message)
        );
    }

    disconnectedCallback() {
        if (this.subscription) {
            unsubscribe(this.subscription);
        }
    }

    handleEvent({ data }) {
        const payload = data.payload;
        if (payload.Queue_Developer_Name__c !== this.queueDeveloperName) {
            return; // another queue's indicator
        }
        this.openCaseCount = payload.Open_Case_Count__c;
        this.intensity = payload.Intensity__c;
        this.motorState = payload.Motor_State__c;
        this.lastUpdate = new Date().toLocaleTimeString();
    }

    get isActive() {
        return this.motorState === 'ACTIVE';
    }

    get statusLabel() {
        if (this.openCaseCount === null) return 'Waiting for first event…';
        return this.isActive
            ? `${this.openCaseCount} open case(s) — indicator running at ${this.intensity}%`
            : 'Queue empty — indicator parked';
    }

    get barStyle() {
        return `width:${this.intensity}%`;
    }
}
