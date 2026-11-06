// What the usage card shows, worked out from what PlatformUsageController
// returns. No imports: Node's test runner loads this file as it is
// (test/lwc/platform-usage.test.js), and the card passes in the user's
// locale and time zone.

export const WARN_PERCENT = 50;
export const HIGH_PERCENT = 80;

export const NOT_ALLOWED = 'Costs and limits are for admins. Ask an admin for the Platform Usage Viewer permission set.';
export const NO_LIMIT = "No limit found. An AWS project's spend limit shows here only through a budget of the same amount "
    + 'named cloud-agentic-iot-monthly. A project owner sees the spend limit in AWS Settings.';
export const ORG_CPU_NOTE = 'Salesforce does not report CPU time or memory (heap) for the whole org, only per request. '
    + 'These are what loading this card used, against what any one request may use.';
export const TOKENS_NOTE = 'Salesforce gives Apex no AI token count without Data 360: token counts need Data 360 with '
    + 'Einstein Audit and Feedback on, and querying them uses Data 360 credits, so this card does not. A Developer '
    + 'Edition org may make 150 LLM generation requests an hour; paid orgs show their credits in Digital Wallet.';
export const ENTITLEMENTS_CAPTION = 'Usage-based entitlements, as Setup shows them under Company Information.';

// What the spend counts, by the aws-spend function's "basis".
const BASIS = {
    'pre-credit-pre-tax': 'Before credits, refunds and tax, as a spend limit counts.',
    net: 'After credits and refunds, with tax: the budget has no charge-type filter.',
    unknown: "What this counts depends on the budget's charge-type filter."
};

// Org limit names, grouped and shown in this order. The first rule that
// matches wins, so DailyStreamingApiEvents counts as an API limit, and a
// name no rule knows goes to Other.
export const GROUPS = [
    ['Storage (data and files)', /^(Data|File)StorageMB$/],
    ['API', /Api|Bulk|Metadata|PermissionSets/],
    ['Apex', /Apex/],
    ['Platform events and streaming', /PlatformEvent|Streaming/],
    ['Email and flows', /Email|Workflow|Flow|Path/],
    ['Analytics and Einstein', /Einstein|Analytics|Report|Dashboard/],
    ['Other', /.*/]
];

// What one request used, by the name PlatformUsageController gives it.
const THIS_REQUEST = {
    CpuTimeMs: ['CPU time', 'ms'],
    HeapBytes: ['Memory (heap)', 'bytes'],
    SoqlQueries: ['SOQL queries', ''],
    QueryRows: ['Rows queried', ''],
    DmlStatements: ['DML statements', ''],
    Callouts: ['Callouts', '']
};

export function groupOf(name) {
    return GROUPS.find(([, rule]) => rule.test(name))[0];
}

/** "DailyApiRequests" -> "Daily API Requests", "DataStorageMB" -> "Data Storage". */
export function labelOf(name) {
    return name.replace(/MB$/, '').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/\bApi\b/g, 'API');
}

export function percentOf(used, max) {
    return isNumber(used) && isNumber(max) && max > 0 ? Math.round((used / max) * 100) : null;
}

/** Green below half, amber from half, red from 80%. */
export function toneOf(percent) {
    if (percent === null) {
        return 'none';
    }
    if (percent >= HIGH_PERCENT) {
        return 'high';
    }
    return percent >= WARN_PERCENT ? 'warn' : 'ok';
}

/**
 * A bar's fill: as wide as the share used, at most the whole track, coloured
 * by toneOf. ariaNow stays within the bar's 0 to 100; the text says the rest.
 */
export function barOf(used, max) {
    const percent = percentOf(used, max);
    const ariaNow = percent === null ? null : Math.min(percent, 100);
    return {
        percent,
        ariaNow,
        shown: percent === 0 && used > 0 ? 'under 1%' : percent + '%',
        fillClass: 'fill fill_' + toneOf(percent),
        fillStyle: 'width: ' + (ariaNow === null ? 0 : ariaNow) + '%'
    };
}

/** One labelled bar, such as "Daily API Requests  1,234 of 15,000 (8%)". */
export function rowOf(key, label, used, max, unit, locale) {
    const bar = barOf(used, max);
    return { key, label, text: amountOf(used, max, unit, locale) + ' (' + bar.shown + ')', ...bar };
}

/** Org limits with a maximum above 0, by group, most used first. */
export function groupOrgLimits(orgLimits, locale) {
    const groups = GROUPS.map(([name]) => ({ name, key: name, rows: [] }));
    for (const item of orgLimits || []) {
        // A maximum of 0 is a feature this org does not have.
        if (!item || !isNumber(item.used) || !isNumber(item.max) || item.max <= 0) {
            continue;
        }
        const unit = /MB$/.test(item.name) ? 'MB' : '';
        groups.find((group) => group.name === groupOf(item.name))
            .rows.push(rowOf(item.name, labelOf(item.name), item.used, item.max, unit, locale));
    }
    for (const group of groups) {
        group.rows.sort((a, b) => b.percent - a.percent || a.label.localeCompare(b.label));
    }
    return groups.filter((group) => group.rows.length > 0);
}

/**
 * The AWS half, from { answer, error, lastKnown }: this month's spend, the
 * limit with a bar when there is one, what the figure counts, and, when AWS
 * did not answer, the error and the last spend AWS did report.
 */
export function awsView(result, locale, timeZone) {
    const answer = (result && result.answer) || null;
    const spent = (answer && answer.spent) || {};
    const awsLimit = answer && answer.limit && isNumber(answer.limit.amount) ? answer.limit : null;
    const hasAmount = isNumber(spent.amount);
    let bar = null;
    if (awsLimit && awsLimit.amount > 0 && hasAmount) {
        bar = { key: 'aws', label: 'Spend against the limit', ...barOf(spent.amount, awsLimit.amount) };
        bar.text = bar.shown + ' of the limit';
    }
    return {
        hasAnswer: Boolean(answer),
        month: answer ? monthOf(answer.month, locale, ' (UTC)') : '',
        spent: hasAmount ? money(spent.amount, locale) : '—',
        limitText: awsLimit ? limitTextOf(awsLimit, locale) : '',
        bar,
        basisText: answer ? basisOf(spent) : '',
        // No limit to show; with no amount either, the notice already says why.
        noLimit: answer && hasAmount && !awsLimit ? NO_LIMIT : null,
        notices: (answer && answer.notices) || [],
        caption: answer ? captionOf(spent, locale, timeZone) : '',
        error: (result && result.error) || null,
        lastKnownText: lastKnownOf(result && result.lastKnown, locale, timeZone)
    };
}

function limitTextOf(awsLimit, locale) {
    const amount = 'of ' + money(awsLimit.amount, locale);
    return awsLimit.chosenBy === 'largest'
        ? amount + ', the largest budget (' + awsLimit.name + ')'
        : amount + ', budget ' + awsLimit.name;
}

function basisOf(spent) {
    const text = BASIS[spent.basis] || BASIS.unknown;
    return spent.estimated === true ? text + ' AWS marks this figure as estimated.' : text;
}

function captionOf(spent, locale, timeZone) {
    if (spent.source === 'budget') {
        return 'Read at ' + timeOf(spent.asOf, locale, timeZone) + '. AWS recalculates budgets about every 8 to 12 hours.';
    }
    if (spent.source === 'cost-explorer') {
        return 'Cost Explorer reading from ' + timeOf(spent.asOf, locale, timeZone) + ', kept until '
            + timeOf(spent.keptUntil, locale, timeZone) + ', because each read costs $0.01.';
    }
    return '';
}

/** "Last known: $3.42 of $20.00 (November 2026), read Nov 6, 5:20 PM." */
function lastKnownOf(lastKnown, locale, timeZone) {
    if (!lastKnown || !isNumber(lastKnown.spent)) {
        return null;
    }
    const amount = money(lastKnown.spent, locale)
        + (isNumber(lastKnown.limit) ? ' of ' + money(lastKnown.limit, locale) : '');
    return 'Last known: ' + amount + ' (' + monthOf(lastKnown.month, locale, '') + '), read '
        + timeOf(lastKnown.readAt, locale, timeZone) + '.';
}

/**
 * The Salesforce half: org limits by group, what this request used of the
 * per-request limits (text, no bars), and usage-based entitlements.
 */
export function salesforceView(answer, locale, timeZone) {
    const entitlements = (answer && answer.entitlements) || {};
    const entitlementRows = (entitlements.rows || [])
        .filter((item) => item && isNumber(item.used) && isNumber(item.max) && item.max > 0)
        .map((item, index) => rowOf('entitlement-' + index,
            item.frequency ? item.name + ' (' + item.frequency + ')' : item.name, item.used, item.max, '', locale));
    return {
        caption: 'As of ' + timeOf(answer && answer.asOf, locale, timeZone) + '. Salesforce updates these within about 5 minutes.',
        groups: groupOrgLimits(answer && answer.orgLimits, locale),
        thisRequest: thisRequestOf(answer && answer.thisRequest, locale),
        entitlements: entitlementRows,
        hasEntitlements: entitlementRows.length > 0,
        entitlementsError: entitlements.error || null
    };
}

/** "CPU time, this request: 23 ms of 10,000 ms", one item per known limit. */
export function thisRequestOf(items, locale) {
    return (items || [])
        .filter((item) => item && THIS_REQUEST[item.name] && isNumber(item.used) && isNumber(item.max))
        .map((item) => {
            const [label, unit] = THIS_REQUEST[item.name];
            return { key: item.name, text: label + ', this request: ' + amountOf(item.used, item.max, unit, locale) };
        });
}

function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
}

function amountOf(used, max, unit, locale) {
    if (unit === 'bytes') {
        return bytesOf(used, locale) + ' of ' + bytesOf(max, locale);
    }
    if (unit === 'ms') {
        return numberOf(used, locale) + ' ms of ' + numberOf(max, locale) + ' ms';
    }
    return numberOf(used, locale) + ' of ' + numberOf(max, locale) + (unit ? ' ' + unit : '');
}

// Salesforce's heap limits are decimal: 6 MB is 6,000,000 bytes.
function bytesOf(bytes, locale) {
    return bytes >= 1000000 ? numberOf(bytes / 1000000, locale, 1) + ' MB' : numberOf(bytes / 1000, locale, 0) + ' KB';
}

function numberOf(value, locale, digits = 2) {
    try {
        return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
    } catch (error) {
        return String(value);   // a locale this browser does not know
    }
}

function money(amount, locale) {
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount);
    } catch (error) {
        return 'US$' + amount.toFixed(2);
    }
}

/** "2026-11" -> "November 2026", plus the suffix: AWS bills by the UTC month. */
function monthOf(month, locale, suffix) {
    const [year, number] = String(month).split('-').map(Number);
    if (!year || !number) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
            .format(Date.UTC(year, number - 1, 1)) + suffix;
    } catch (error) {
        return month + suffix;
    }
}

function timeOf(iso, locale, timeZone) {
    const time = Date.parse(iso);
    if (isNaN(time)) {
        return '';
    }
    const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone };
    try {
        return new Intl.DateTimeFormat(locale, options).format(time);
    } catch (error) {
        return new Date(time).toLocaleString();   // a locale or time zone this browser does not know
    }
}
