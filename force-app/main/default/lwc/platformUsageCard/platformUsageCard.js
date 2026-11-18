// The usage card on the Cloud Agentic IoT app's Home page: this month's AWS
// spend against its limit, and how much of Salesforce's limits the org has
// used. It asks once, when the page loads, and never polls: AWS recalculates
// its billing figures a few times a day and Salesforce its org limits within
// minutes, so asking more often would show nothing new.
//
// The Salesforce half is asked first and the AWS half after it. Two Apex
// calls started together travel in one batched request, so the Salesforce
// half would wait for the AWS callout. Each half fails on its own.
//
// Costs are for admins: without the View_Platform_Usage custom permission
// the card asks nothing. PlatformUsageController also requires View Setup.
import { LightningElement } from 'lwc';
import LOCALE from '@salesforce/i18n/locale';
import TIME_ZONE from '@salesforce/i18n/timeZone';
import CAN_VIEW from '@salesforce/customPermission/View_Platform_Usage';
import readAwsSpend from '@salesforce/apex/PlatformUsageController.awsSpend';
import readSalesforceLimits from '@salesforce/apex/PlatformUsageController.salesforceLimits';
import { awsView, awsRingOf, highlightsOf, salesforceView, ENTITLEMENTS_CAPTION, NOT_ALLOWED, ORG_CPU_NOTE, TOKENS_NOTE } from './usage';

export default class PlatformUsageCard extends LightningElement {
    allowed = CAN_VIEW === true;
    aws;
    awsError;
    salesforce;
    salesforceError;

    notAllowed = NOT_ALLOWED;
    orgCpuNote = ORG_CPU_NOTE;
    tokensNote = TOKENS_NOTE;
    entitlementsCaption = ENTITLEMENTS_CAPTION;

    connectedCallback() {
        if (this.allowed) {
            this.load();
        }
    }

    async load() {
        try {
            this.salesforce = salesforceView(await readSalesforceLimits(), LOCALE, TIME_ZONE);
        } catch (error) {
            this.salesforceError = messageOf(error, 'Salesforce limits could not be read.');
        }
        try {
            this.aws = awsView(await readAwsSpend(), LOCALE, TIME_ZONE);
        } catch (error) {
            this.awsError = messageOf(error, 'AWS spend could not be read.');
        }
    }

    get awsLoading() {
        return !this.aws && !this.awsError;
    }

    get salesforceLoading() {
        return !this.salesforce && !this.salesforceError;
    }

    /** The headline tiles and the watch list, from the Salesforce half. */
    get highlights() {
        return this.salesforce ? highlightsOf(this.salesforce) : null;
    }

    get awsRing() {
        return awsRingOf(this.aws);
    }
}

function messageOf(error, fallback) {
    return (error && error.body && error.body.message) || fallback;
}
