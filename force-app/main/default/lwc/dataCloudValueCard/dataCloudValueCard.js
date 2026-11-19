// The Data Cloud value card on the Cloud Agentic IoT app's Home page: what
// the room readings in Data Cloud show (temperature alert minutes, monitored
// devices and when each last reported) next to what Data Cloud costs and the
// manual checks it replaces. One read per 10 minutes per browser session:
// each read is two Data Cloud queries, which cost credits, and the insights
// behind them change only hourly.
import { LightningElement } from 'lwc';
import LOCALE from '@salesforce/i18n/locale';
import TIME_ZONE from '@salesforce/i18n/timeZone';
import readValue from '@salesforce/apex/DataCloudValueController.read';
import { viewOf, isFresh, NO_DATA, ESTIMATE_NOTE } from './value';

const CACHE_KEY = 'cloudAgenticIot.dataCloudValue';

export default class DataCloudValueCard extends LightningElement {
    view;
    error;
    asOf;
    noData = NO_DATA;
    estimateNote = ESTIMATE_NOTE;

    connectedCallback() {
        this.load(false);
    }

    handleRefresh() {
        this.load(true);
    }

    async load(force) {
        const now = Date.now();
        let answer = force ? null : cached(now);
        try {
            if (!answer) {
                answer = await readValue();
                save(answer, now);
            }
            this.view = viewOf(answer, now, LOCALE, TIME_ZONE);
            this.asOf = answer.asOf ? new Date(answer.asOf).toLocaleTimeString(LOCALE, { timeZone: TIME_ZONE }) : '';
            this.error = undefined;
        } catch (e) {
            this.error = (e && e.body && e.body.message) || 'Data Cloud could not be read.';
        }
    }

    get loading() {
        return !this.view && !this.error;
    }
}

// Browser storage can be missing or refuse (a private window): then the card
// just reads again.
function cached(now) {
    try {
        const saved = JSON.parse(window.sessionStorage.getItem(CACHE_KEY));
        return saved && isFresh(saved.savedAt, now) ? saved.answer : null;
    } catch (e) {
        return null;
    }
}

function save(answer, now) {
    try {
        window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: now, answer }));
    } catch (e) {
        // Not cached: the next load reads again.
    }
}
