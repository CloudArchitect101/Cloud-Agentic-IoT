// What the Data Cloud value card shows, worked out from what
// DataCloudValueController returns. No imports: Node's test runner loads
// this file as it is (test/lwc/data-cloud-value.test.js), and the card
// passes in the time now, the user's locale and time zone.

export const CACHE_MINUTES = 10;
export const TREND_DAYS = 14;
export const WINDOW_DAYS = 7;
export const DAYS_PER_MONTH = 30;
// The silence insight runs hourly and the S3 stream refreshes about hourly,
// so a healthy device's last reading in Data Cloud can be up to about two
// hours old. Silent means older than that. The live, seconds-fresh signal is
// the device's Connection field on its Asset.
export const SILENT_AFTER_MINUTES = 120;

export const NO_DATA = 'No rows yet. The insights fill in after the room readings stream has records and each '
    + 'insight has run once (Room Out Of Range Daily every 6 hours, Room Device Silence every hour).';
export const ESTIMATE_NOTE = 'Value is manual temperature checks the monitored devices replace (Value Assumption: '
    + 'checks a day x minutes a check x staff rate). Data Cloud cost is credits a month x price per credit, an '
    + 'estimate: check it against Setup, Digital Wallet.';

const DAY_MS = 24 * 60 * 60 * 1000;

const num = (value) => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
};

/** The UTC day of a time or ISO text, as yyyy-mm-dd, or null. */
export function dayKey(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(typeof value === 'number' ? value : String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The last `count` UTC days up to and including the day of `now`, oldest first. */
export function lastDays(now, count) {
    const today = Date.parse(dayKey(now) + 'T00:00:00Z');
    return Array.from({ length: count }, (_, i) => new Date(today - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** Out-of-range minutes per day over the trend, as bars scaled to the highest day. */
export function trendOf(rows, now) {
    const days = lastDays(now, TREND_DAYS);
    const minutes = new Map(days.map((d) => [d, 0]));
    for (const row of rows || []) {
        const day = dayKey(row.reading_day__c);
        if (minutes.has(day)) minutes.set(day, minutes.get(day) + num(row.minutes_out_of_range__c));
    }
    const highest = Math.max(0, ...minutes.values());
    return days.map((day) => {
        const value = Math.round(minutes.get(day) * 10) / 10;
        const percent = highest > 0 ? Math.max(value > 0 ? 4 : 0, Math.round((value / highest) * 100)) : 0;
        return { day, label: day.slice(5), minutes: value, style: `height: ${percent}%`, title: `${day}: ${value} min` };
    });
}

/** Totals over the last WINDOW_DAYS days, overall and per device. */
export function windowOf(rows, now) {
    const days = new Set(lastDays(now, WINDOW_DAYS));
    const perDevice = new Map();
    let minutes = 0;
    let readings = 0;
    let highest = null;
    for (const row of rows || []) {
        if (!days.has(dayKey(row.reading_day__c))) continue;
        const m = num(row.minutes_out_of_range__c);
        const t = row.max_temperature_c__c === null || row.max_temperature_c__c === undefined ? null : num(row.max_temperature_c__c);
        minutes += m;
        readings += num(row.readings_out_of_range__c);
        if (t !== null && (highest === null || t > highest)) highest = t;
        const device = perDevice.get(row.device_id__c) || { minutes: 0, highest: null };
        device.minutes += m;
        if (t !== null && (device.highest === null || t > device.highest)) device.highest = t;
        perDevice.set(row.device_id__c, device);
    }
    return { minutes: Math.round(minutes * 10) / 10, readings, highest, perDevice };
}

/** One row per device from the silence insight, silent ones first. */
export function devicesOf(silenceRows, perDevice, now, locale, timeZone) {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });
    return (silenceRows || [])
        .filter((row) => row.device_id__c)
        .map((row) => {
            const last = Date.parse(row.last_reading_ts__c);
            const minutesAgo = Number.isNaN(last) ? null : Math.max(0, Math.floor((now - last) / 60000));
            const silent = minutesAgo === null || minutesAgo > SILENT_AFTER_MINUTES;
            const window = perDevice.get(row.device_id__c) || { minutes: 0, highest: null };
            return {
                id: row.device_id__c,
                lastReading: Number.isNaN(last) ? 'Unknown' : format.format(new Date(last)),
                ago: minutesAgo === null ? '' : agoText(minutesAgo),
                status: silent ? 'Silent' : 'Reporting',
                statusClass: silent ? 'slds-badge slds-theme_warning' : 'slds-badge slds-theme_success',
                readings: num(row.readings__c),
                outOfRangeMinutes: Math.round(window.minutes * 10) / 10,
                highest: window.highest === null ? '' : `${window.highest.toFixed(1)} °C`,
                silent
            };
        })
        .sort((a, b) => (a.silent === b.silent ? a.id.localeCompare(b.id) : a.silent ? -1 : 1));
}

export function agoText(minutes) {
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
    return `${Math.floor(minutes / 1440)} days ago`;
}

/**
 * Monthly value against Data Cloud's monthly cost. Value: the manual
 * temperature checks the reporting devices replace. Cost: credits x price.
 */
export function roiOf(deviceCount, assumptions) {
    const a = assumptions || {};
    const hours = (deviceCount * num(a.manualChecksPerDeviceDay) * num(a.manualCheckMinutes) * DAYS_PER_MONTH) / 60;
    const value = hours * num(a.staffHourlyRate);
    const cost = num(a.dataCloudCreditsPerMonth) * num(a.dataCloudPricePerCredit);
    return {
        hours: Math.round(hours * 10) / 10,
        value: Math.round(value * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        net: Math.round((value - cost) * 100) / 100,
        multiple: cost > 0 ? Math.round((value / cost) * 10) / 10 : null
    };
}

/** Everything the card shows, from the controller's answer. */
export function viewOf(answer, now, locale, timeZone) {
    const outOfRange = (answer && answer.outOfRange) || { rows: [], error: 'No answer' };
    const silence = (answer && answer.silence) || { rows: [], error: 'No answer' };
    const window = windowOf(outOfRange.rows, now);
    const devices = devicesOf(silence.rows, window.perDevice, now, locale, timeZone);
    const roi = roiOf(devices.length, answer && answer.assumptions);
    const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const silent = devices.filter((d) => d.silent).length;
    return {
        trend: trendOf(outOfRange.rows, now),
        devices,
        hasDevices: devices.length > 0,
        hasData: (outOfRange.rows || []).length > 0 || devices.length > 0,
        outOfRangeError: outOfRange.error || null,
        silenceError: silence.error || null,
        tiles: [
            { key: 'minutes', label: `Out-of-range minutes, ${WINDOW_DAYS} days`, value: String(window.minutes),
                hint: `${window.readings} readings at or above the temperature alert threshold` },
            { key: 'highest', label: `Highest temperature, ${WINDOW_DAYS} days`,
                value: window.highest === null ? '–' : `${window.highest.toFixed(1)} °C`, hint: 'Any monitored device' },
            { key: 'devices', label: 'Monitored devices in Data Cloud', value: String(devices.length),
                hint: `${silent} silent for over ${SILENT_AFTER_MINUTES / 60} h` },
            { key: 'value', label: 'Manual checks replaced, a month', value: money.format(roi.value),
                hint: `${roi.hours} staff hours` },
            { key: 'cost', label: 'Data Cloud cost, a month', value: money.format(roi.cost), hint: 'Estimate' },
            { key: 'roi', label: 'Return on Data Cloud', value: roi.multiple === null ? '–' : `${roi.multiple}x`,
                hint: `Net ${money.format(roi.net)} a month` }
        ],
        roi
    };
}

/** Whether a cached answer, saved at `savedAt`, is still fresh at `now`. */
export function isFresh(savedAt, now) {
    return Number.isFinite(savedAt) && now - savedAt >= 0 && now - savedAt < CACHE_MINUTES * 60000;
}
