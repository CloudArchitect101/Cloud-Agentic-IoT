// The live card on a device's record page (Asset). It shows whether the board
// is connected to AWS IoT, from the Asset's connection fields, and the board's
// readings as they happen, while the card is on screen.
//
// Readings come from AWS IoT straight to this browser, never through
// Salesforce. DeviceLiveController.start tells the board to send one every
// couple of seconds for 15 minutes, and returns a signed WebSocket link, valid
// 15 minutes, for this card alone. While the card stays visible it calls start
// again every 10 minutes, which keeps the board live and gives a fresh link for
// the next reconnect. When the tab is hidden or the card goes away, it
// disconnects, and the board drops back to its 30 s readings by itself.
//
// The link is a credential until it expires, so nothing here logs it, and
// nothing logs a browser error that might quote it.
import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import LOCALE from '@salesforce/i18n/locale';
import TIME_ZONE from '@salesforce/i18n/timeZone';
import startLive from '@salesforce/apex/DeviceLiveController.start';
import readLatest from '@salesforce/apex/DeviceLiveController.latest';
import CONNECTION_STATUS from '@salesforce/schema/Asset.Connection_Status__c';
import CONNECTION_SINCE from '@salesforce/schema/Asset.Connection_Since__c';
import LAST_DISCONNECT_REASON from '@salesforce/schema/Asset.Last_Disconnect_Reason__c';
import {
    connackReason,
    createReader,
    encodeConnect,
    encodeDisconnect,
    encodePingreq,
    encodeSubscribe,
    SUBACK_FAILURE
} from './mqtt';

// Optional, so a user who may not read them still gets the readings.
const FIELDS = [CONNECTION_STATUS, CONNECTION_SINCE, LAST_DISCONNECT_REASON];

const REFRESH_MS = 10 * 60 * 1000;   // inside the link's 15 minutes and the board's
const PING_MS = 45 * 1000;           // inside the 60 s keep-alive
const RECONNECT_MS = 2000;
const MAX_RECONNECTS = 3;            // in a row, before falling back to stored readings
const STORED_EVERY_MS = 5000;
const QUIET_MS = 15 * 1000;
const CLOCK_MS = 1000;               // for "updated N s ago"
const SOCKET_OPEN = 1;               // WebSocket.OPEN

const WAITING = 'Waiting for the board: it may be offline.';
const FALLEN_BACK = 'Live connection unavailable; showing stored readings every 5 s';

export default class DeviceLiveCard extends LightningElement {
    @api recordId;

    // What the card shows.
    connection;
    reading;
    patient;
    notice;
    mode = 'idle';   // idle, starting, connecting, live, stored or failed
    now = Date.now();

    // The live session behind it.
    running = false;
    generation = 0;   // raised by begin() and end(), so a late answer is ignored
    session;          // the newest live block from start: url, clientId, topic, seconds
    socket;
    reader;
    topic;
    failures = 0;
    timers = {};
    latestInFlight = false;
    visibilityListener;

    @wire(getRecord, { recordId: '$recordId', optionalFields: FIELDS })
    wiredDevice({ data }) {
        if (data) {
            this.showConnection({
                status: getFieldValue(data, CONNECTION_STATUS),
                since: getFieldValue(data, CONNECTION_SINCE),
                lastDisconnectReason: getFieldValue(data, LAST_DISCONNECT_REASON)
            });
        }
    }

    connectedCallback() {
        this.visibilityListener = () => this.followVisibility();
        document.addEventListener('visibilitychange', this.visibilityListener);
        this.followVisibility();
    }

    disconnectedCallback() {
        document.removeEventListener('visibilitychange', this.visibilityListener);
        this.end();
    }

    // Live only while someone can see it: a hidden tab costs nothing.
    followVisibility() {
        if (document.visibilityState === 'visible') {
            this.begin();
        } else {
            this.end();
        }
    }

    retry() {
        this.end();
        this.followVisibility();
    }

    /* ------------------------------------------------------------ session */

    begin() {
        if (this.running || !this.recordId) {
            return;
        }
        this.running = true;
        this.generation += 1;
        this.failures = 0;
        this.mode = 'starting';
        this.notice = undefined;
        this.now = Date.now();
        this.every('clock', CLOCK_MS, () => {
            this.now = Date.now();
        });
        this.every('refresh', REFRESH_MS, () => this.requestStart());
        this.requestStart();
    }

    end() {
        if (!this.running) {
            return;
        }
        this.running = false;
        this.generation += 1;
        Object.keys(this.timers).forEach((name) => this.stop(name));
        this.dropSocket();
        this.latestInFlight = false;
        this.mode = 'idle';
    }

    async requestStart() {
        const generation = this.generation;
        let answer;
        try {
            answer = await startLive({ assetId: this.recordId });
        } catch (error) {
            if (generation === this.generation) {
                this.notice = messageOf(error, 'The live view could not start.');
                if (this.mode === 'starting') {
                    this.mode = 'failed';
                }
            }
            return;
        }
        if (generation !== this.generation) {
            return;   // hidden or removed while start was on its way
        }
        if (this.notice !== WAITING && this.notice !== FALLEN_BACK) {
            this.notice = undefined;   // an earlier failure, now past
        }
        this.show(answer);

        const live = answer && answer.live;
        if (!live || !live.url) {
            if (!this.socket) {
                this.fallBack();
            }
            return;
        }
        this.session = live;
        if (live.commandPublished === false) {
            console.warn('deviceLiveCard: AWS could not send the board its live command, so readings may wait for the next try.');
        }
        // A connection that is open keeps going; the new link is for the next
        // reconnect. Without one, this is the first try, or a fresh try after
        // falling back to stored readings.
        if (!this.socket && !this.timers.reconnect) {
            this.failures = 0;
            this.connect();
        }
    }

    connect() {
        const session = this.session;
        let socket;
        try {
            socket = new WebSocket(session.url, ['mqtt']);
        } catch (error) {
            // The browser refused the address outright, usually because no CSP
            // Trusted Site allows the AWS IoT endpoint. Its message quotes the
            // signed link, so only its name is logged.
            console.warn('deviceLiveCard: the browser refused the live connection (' + error.name
                + '). Check the CSP Trusted Site for this AWS IoT endpoint.');
            this.fallBack();
            return;
        }
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        this.reader = createReader();
        this.topic = session.topic;
        if (this.mode !== 'stored') {
            this.mode = 'connecting';
        }
        socket.onopen = () => this.send(socket, encodeConnect(session.clientId));
        socket.onmessage = (event) => this.receive(socket, event.data);
        // An error event is always followed by close, which decides what next.
        socket.onclose = () => this.closed(socket);
    }

    receive(socket, data) {
        if (socket !== this.socket) {
            return;
        }
        let packets;
        try {
            packets = this.reader.push(data);
        } catch (error) {
            console.warn('deviceLiveCard: unreadable data from AWS IoT (' + error.message + '); reconnecting.');
            socket.close();
            return;
        }
        packets.forEach((packet) => this.handle(socket, packet));
    }

    handle(socket, packet) {
        if (socket !== this.socket || socket.readyState !== SOCKET_OPEN) {
            return;   // closing already, so the rest of its packets do not matter
        }
        if (packet.type === 'connack') {
            if (packet.returnCode !== 0) {
                console.warn('deviceLiveCard: AWS IoT refused the connection: ' + connackReason(packet.returnCode) + '.');
                socket.close();
                return;
            }
            this.send(socket, encodeSubscribe(1, this.topic));
            this.every('ping', PING_MS, () => this.send(socket, encodePingreq()));
        } else if (packet.type === 'suback') {
            if (packet.returnCodes[0] === SUBACK_FAILURE) {
                console.warn('deviceLiveCard: AWS IoT refused the subscription to ' + this.topic + '.');
                socket.close();
                return;
            }
            this.subscribed();
        } else if (packet.type === 'publish' && packet.topic === this.topic) {
            this.showLive(packet.payload);
        }
        // A PINGRESP needs nothing: the connection staying open is the point.
    }

    subscribed() {
        this.failures = 0;
        this.mode = 'live';
        this.stop('stored');
        if (this.notice === FALLEN_BACK) {
            this.notice = undefined;
        }
        this.expectReading();
    }

    // Says the board is not sending when no reading comes in the quiet time:
    // 15 s, or three readings' worth if the board was told to send less often.
    expectReading() {
        const seconds = this.session ? this.session.seconds : undefined;
        const quietMs = Math.max(QUIET_MS, typeof seconds === 'number' ? 3 * seconds * 1000 : 0);
        this.after('quiet', quietMs, () => {
            this.notice = WAITING;
        });
    }

    closed(socket) {
        if (socket !== this.socket) {
            return;   // one this card closed itself and forgot
        }
        this.socket = undefined;
        this.reader = undefined;
        this.stop('ping');
        this.stop('quiet');
        if (!this.running) {
            return;
        }
        this.failures += 1;
        if (this.failures > MAX_RECONNECTS) {
            this.fallBack();
            return;
        }
        if (this.mode === 'live') {
            this.mode = 'connecting';
        }
        this.after('reconnect', RECONNECT_MS, () => this.connect());
    }

    // Stored readings every 5 s, until a later start gets a live connection.
    fallBack() {
        this.mode = 'stored';
        this.notice = FALLEN_BACK;
        if (!this.timers.stored) {
            this.every('stored', STORED_EVERY_MS, () => this.requestLatest());
        }
    }

    async requestLatest() {
        if (this.latestInFlight) {
            return;   // the last one has not answered yet
        }
        this.latestInFlight = true;
        const generation = this.generation;
        try {
            const answer = await readLatest({ assetId: this.recordId });
            if (generation === this.generation) {
                this.show(answer);
                if (this.mode === 'stored') {
                    this.notice = FALLEN_BACK;
                }
            }
        } catch (error) {
            if (generation === this.generation) {
                this.notice = messageOf(error, 'Stored readings could not be read.');
            }
        } finally {
            if (generation === this.generation) {
                this.latestInFlight = false;
            }
        }
    }

    // Says goodbye and closes the socket. It is forgotten first, so its close
    // event is not taken for a dropped connection.
    dropSocket() {
        const socket = this.socket;
        this.socket = undefined;
        this.reader = undefined;
        if (!socket) {
            return;
        }
        this.send(socket, encodeDisconnect());
        socket.close();
    }

    send(socket, bytes) {
        if (socket.readyState === SOCKET_OPEN) {
            socket.send(bytes);
        }
    }

    /* ------------------------------------------------------------- timers */

    // Every timer has a name, so starting one again replaces it, and end()
    // stops them all: none outlives the session that started it.
    every(name, ms, callback) {
        this.stop(name);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.timers[name] = { id: setInterval(callback, ms), repeating: true };
    }

    after(name, ms, callback) {
        this.stop(name);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        const id = setTimeout(() => {
            delete this.timers[name];
            callback();
        }, ms);
        this.timers[name] = { id: id, repeating: false };
    }

    stop(name) {
        const timer = this.timers[name];
        if (!timer) {
            return;
        }
        if (timer.repeating) {
            clearInterval(timer.id);
        } else {
            clearTimeout(timer.id);
        }
        delete this.timers[name];
    }

    /* ----------------------------------------------------------- readings */

    // What start or latest returned: the stored reading, the patient's state
    // and the Asset's connection.
    show(answer) {
        if (!answer) {
            return;
        }
        if (answer.connection) {
            this.showConnection(answer.connection);
        }
        if (answer.state) {
            this.patient = answer.state;
        }
        const stored = answer.latest;
        if (stored) {
            const parsed = Date.parse(stored.at);
            const time = isNaN(parsed) ? null : parsed;
            // A live reading, or a newer stored one, is never replaced by an older one.
            if (!this.reading || (time || 0) >= (this.reading.time || 0)) {
                this.reading = {
                    temperature: stored.temperature,
                    humidity: stored.humidity,
                    time: time,
                    live: false
                };
            }
        }
    }

    showLive(payload) {
        let body;
        try {
            body = JSON.parse(payload);
        } catch (error) {
            return;   // not a reading
        }
        if (!body || typeof body !== 'object') {
            return;
        }
        if (this.notice === WAITING) {
            this.notice = undefined;
        }
        this.expectReading();
        this.reading = {
            temperature: body.temperature,
            humidity: body.humidity,
            rssi: body.rssi,
            firmware: body.firmware,
            uptime: body.uptime,
            sensorError: body.sensorError,
            time: Date.now(),
            live: true
        };
    }

    // The record page and both Apex calls read the same Asset. The one that
    // saw the later event wins, so a cached or slow answer never puts an older
    // connection back on the card.
    showConnection(incoming) {
        if (this.connection && sinceOf(incoming) < sinceOf(this.connection)) {
            return;
        }
        this.connection = incoming;
    }

    /* ------------------------------------------------------------ display */

    get badge() {
        if (this.mode === 'live') {
            const seconds = this.session ? this.session.seconds : undefined;
            return seconds ? 'Live, every ' + seconds + ' s' : 'Live';
        }
        if (this.mode === 'starting' || this.mode === 'connecting') {
            return 'Connecting';
        }
        if (this.mode === 'stored') {
            return 'Stored, every 5 s';
        }
        return undefined;
    }

    get connectionText() {
        const connection = this.connection;
        if (!connection || !connection.status) {
            return 'Not reported yet';
        }
        const since = formatTime(connection.since);
        return since ? connection.status + ' since ' + since : connection.status;
    }

    get connectionClass() {
        const status = this.connection ? this.connection.status : undefined;
        if (status === 'Online') {
            return 'slds-text-color_success';
        }
        if (status === 'Offline') {
            return 'slds-text-color_error';
        }
        return 'slds-text-color_weak';
    }

    get disconnectReason() {
        return this.connection ? this.connection.lastDisconnectReason : undefined;
    }

    get hasReading() {
        return Boolean(this.reading);
    }

    get isLiveReading() {
        return Boolean(this.reading && this.reading.live);
    }

    get sensorError() {
        return this.reading ? this.reading.sensorError : undefined;
    }

    get temperature() {
        return withUnit(this.reading.temperature, 1, '°C');
    }

    get humidity() {
        return withUnit(this.reading.humidity, 1, '%');
    }

    get signal() {
        return withUnit(this.reading.rssi, 0, 'dBm');
    }

    get firmware() {
        return this.reading.firmware || '—';
    }

    get uptime() {
        return duration(this.reading.uptime);
    }

    get updated() {
        const kind = this.reading.live ? 'Live reading' : 'Stored reading';
        return this.reading.time ? kind + ', updated ' + ago(this.now - this.reading.time) : kind;
    }

    get hasPatient() {
        return Boolean(this.patient && this.patient.patientState);
    }

    get patientText() {
        const risk = this.patient.riskScore;
        return typeof risk === 'number'
            ? this.patient.patientState + ', risk score ' + formatNumber(risk, 2)
            : this.patient.patientState;
    }

    get noticeClass() {
        const tone = this.mode === 'failed' ? 'slds-text-color_error' : 'slds-text-color_weak';
        return 'slds-text-body_small slds-p-top_x-small ' + tone;
    }

    get canRetry() {
        return this.mode === 'failed';
    }
}

function messageOf(error, fallback) {
    return (error && error.body && error.body.message) || fallback;
}

function sinceOf(connection) {
    const time = Date.parse(connection.since);
    return isNaN(time) ? 0 : time;
}

// Numbers and times in the user's Salesforce locale and time zone.
function formatNumber(value, maximumFractionDigits) {
    try {
        return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maximumFractionDigits }).format(value);
    } catch (error) {
        return String(value);   // a locale this browser does not know
    }
}

function formatTime(iso) {
    const time = Date.parse(iso);
    if (isNaN(time)) {
        return '';
    }
    const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE };
    try {
        return new Intl.DateTimeFormat(LOCALE, options).format(time);
    } catch (error) {
        return new Date(time).toLocaleString();   // a locale or time zone this browser does not know
    }
}

function withUnit(value, maximumFractionDigits, unit) {
    return typeof value === 'number' && isFinite(value)
        ? formatNumber(value, maximumFractionDigits) + ' ' + unit
        : '—';
}

function duration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) {
        return '—';
    }
    const whole = Math.floor(seconds);
    const days = Math.floor(whole / 86400);
    const hours = Math.floor((whole % 86400) / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    if (days > 0) {
        return days + ' d ' + hours + ' h';
    }
    if (hours > 0) {
        return hours + ' h ' + minutes + ' min';
    }
    if (minutes > 0) {
        return minutes + ' min ' + (whole % 60) + ' s';
    }
    return whole + ' s';
}

function ago(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 120) {
        return seconds + ' s ago';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 120) {
        return minutes + ' min ago';
    }
    return Math.round(minutes / 60) + ' h ago';
}
