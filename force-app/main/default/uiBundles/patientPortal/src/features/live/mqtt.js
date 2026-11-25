/*
 * mqtt.js - the little MQTT 3.1.1 the device live card speaks.
 *
 * Just what the card needs to receive a board's live readings from AWS IoT
 * over a WebSocket: CONNECT with a clean session, SUBSCRIBE to one topic at
 * QoS 0, PINGREQ to keep the connection open, DISCONNECT to end it, and a
 * reader that turns the bytes AWS IoT sends into whole packets. Nothing here
 * publishes, retries or keeps a session, so a reading nobody is watching is
 * simply dropped, which is what a live view wants.
 *
 * Pure functions over bytes, with no DOM and no imports, so the same file runs
 * in the card and in Node's test runner (test/lwc/device-live-mqtt.test.js).
 * Section numbers are those of the MQTT 3.1.1 standard.
 */

// Packet types: the high four bits of a packet's first byte (2.2.1).
export const CONNACK = 2;
export const PUBLISH = 3;
export const SUBACK = 9;
export const PINGRESP = 13;

/** The return code a SUBACK gives a topic the server refused (3.9.3). */
export const SUBACK_FAILURE = 0x80;

/**
 * Seconds the card promises to send something within. AWS IoT closes a
 * connection that stays silent for one and a half times this.
 */
export const KEEP_ALIVE_SECONDS = 60;

// A remaining length takes one to four bytes of seven bits each (2.2.3).
const MAX_REMAINING_LENGTH = 268435455;

// AWS IoT messages are at most 128 KB, so a longer packet is not one of its.
// Refusing it keeps a garbled stream from holding on to memory.
const MAX_PACKET_BYTES = 256 * 1024;

// CONNACK return codes 0 to 5 (3.2.2.3).
const CONNACK_REASONS = [
    'accepted',
    'unacceptable protocol version',
    'client identifier rejected',
    'server unavailable',
    'bad user name or password',
    'not authorized'
];

/** The remaining length as MQTT writes it: seven bits a byte, lowest first. */
export function encodeRemainingLength(length) {
    if (!Number.isInteger(length) || length < 0 || length > MAX_REMAINING_LENGTH) {
        throw new RangeError('An MQTT remaining length is 0 to ' + MAX_REMAINING_LENGTH + ', not ' + length + '.');
    }
    const bytes = [];
    let rest = length;
    do {
        let digit = rest % 128;
        rest = Math.floor(rest / 128);
        if (rest > 0) {
            digit = digit | 0x80;
        }
        bytes.push(digit);
    } while (rest > 0);
    return bytes;
}

/**
 * CONNECT (3.1): protocol "MQTT" at level 4, which is 3.1.1, a clean session,
 * no will, and no user name or password, since the signed WebSocket link is
 * the credential.
 */
export function encodeConnect(clientId, keepAliveSeconds) {
    if (typeof clientId !== 'string' || clientId.length === 0) {
        throw new TypeError('CONNECT needs a client identifier.');
    }
    const keepAlive = keepAliveSeconds === undefined ? KEEP_ALIVE_SECONDS : keepAliveSeconds;
    if (!Number.isInteger(keepAlive) || keepAlive < 0 || keepAlive > 65535) {
        throw new RangeError('The keep-alive is 0 to 65535 seconds, not ' + keepAliveSeconds + '.');
    }
    const cleanSession = 0x02;
    const body = encodeString('MQTT').concat(
        [4, cleanSession, keepAlive >> 8, keepAlive & 0xff],
        encodeString(clientId)
    );
    return packet(0x10, body);
}

/** SUBSCRIBE (3.8) to one topic filter at QoS 0. */
export function encodeSubscribe(packetId, topic) {
    if (!Number.isInteger(packetId) || packetId < 1 || packetId > 65535) {
        throw new RangeError('A SUBSCRIBE packet identifier is 1 to 65535, not ' + packetId + '.');
    }
    if (typeof topic !== 'string' || topic.length === 0) {
        throw new TypeError('SUBSCRIBE needs a topic filter.');
    }
    const requestedQos = 0;
    const body = [packetId >> 8, packetId & 0xff].concat(encodeString(topic), [requestedQos]);
    // 0x82, not 0x80: the standard fixes SUBSCRIBE's flag bits at 0010 (3.8.1).
    return packet(0x82, body);
}

/** PINGREQ (3.12): any packet resets the keep-alive, and this is the smallest. */
export function encodePingreq() {
    return Uint8Array.from([0xc0, 0x00]);
}

/** DISCONNECT (3.14): a clean goodbye, so the server need not wait out the keep-alive. */
export function encodeDisconnect() {
    return Uint8Array.from([0xe0, 0x00]);
}

/** What a CONNACK return code means, in words for a log line. */
export function connackReason(returnCode) {
    return CONNACK_REASONS[returnCode] || 'refused with return code ' + returnCode;
}

/**
 * A reader for one connection. push() takes the bytes of each WebSocket
 * message, as an ArrayBuffer or a typed array, and returns the packets they
 * complete, in order: none while a packet is still arriving, several when one
 * message holds more than one. A message need not end where a packet does, so
 * the reader keeps a partial packet until the rest arrives.
 *
 * Each packet comes back as a plain object:
 *   { type: 'connack', sessionPresent, returnCode }
 *   { type: 'suback', packetId, returnCodes }      SUBACK_FAILURE for a refused topic
 *   { type: 'publish', topic, payload, qos, packetId, retain, dup }
 *                                                  topic and payload decoded as UTF-8
 *   { type: 'pingresp' }
 *   { type: 'other', packetType }                  a packet the card never asks for
 *
 * Bytes that break the standard throw, since the connection cannot recover
 * from them; the card then closes it.
 */
export function createReader() {
    let pending = new Uint8Array(0);
    return {
        push(chunk) {
            pending = join(pending, bytesOf(chunk));
            const packets = [];
            let header = fixedHeader(pending);
            while (header && pending.length >= header.size + header.remainingLength) {
                const end = header.size + header.remainingLength;
                packets.push(parse(pending[0], pending.subarray(header.size, end)));
                pending = pending.slice(end);
                header = fixedHeader(pending);
            }
            return packets;
        }
    };
}

function packet(firstByte, body) {
    return Uint8Array.from([firstByte].concat(encodeRemainingLength(body.length), body));
}

// A UTF-8 string with its length in front in two bytes (1.5.3), as MQTT
// writes a client identifier or a topic.
function encodeString(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 65535) {
        throw new RangeError('An MQTT string is at most 65535 bytes.');
    }
    return [bytes.length >> 8, bytes.length & 0xff].concat(Array.from(bytes));
}

function decodeString(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
}

function bytesOf(chunk) {
    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    const bytes = new Uint8Array(chunk);
    // Text or a Blob reads as no bytes at all. Say so, rather than wait
    // forever for a packet that is never going to arrive.
    if (bytes.length !== chunk.byteLength) {
        throw new TypeError('MQTT bytes come as an ArrayBuffer or a typed array: set the WebSocket\'s binaryType to arraybuffer.');
    }
    return bytes;
}

// A copy of a followed by b, so a partial packet never points into a buffer
// that belongs to the caller.
function join(a, b) {
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    return joined;
}

// The fixed header at the start of bytes (2.2): its size and the remaining
// length it announces, or null while the remaining length is still arriving.
function fixedHeader(bytes) {
    let remainingLength = 0;
    let multiplier = 1;
    for (let i = 1; i <= 4; i++) {
        if (i >= bytes.length) {
            return null;
        }
        remainingLength += (bytes[i] & 0x7f) * multiplier;
        if ((bytes[i] & 0x80) === 0) {
            if (i + 1 + remainingLength > MAX_PACKET_BYTES) {
                throw new RangeError('An MQTT packet of ' + remainingLength + ' bytes is larger than AWS IoT sends.');
            }
            return { size: i + 1, remainingLength: remainingLength };
        }
        multiplier = multiplier * 128;
    }
    throw new RangeError('A malformed MQTT remaining length: more than four bytes.');
}

function parse(firstByte, body) {
    const type = firstByte >> 4;
    if (type === CONNACK) {
        need(body, 2, 'CONNACK');
        return { type: 'connack', sessionPresent: (body[0] & 0x01) === 1, returnCode: body[1] };
    }
    if (type === SUBACK) {
        need(body, 3, 'SUBACK');
        return { type: 'suback', packetId: (body[0] << 8) | body[1], returnCodes: Array.from(body.subarray(2)) };
    }
    if (type === PUBLISH) {
        return parsePublish(firstByte, body);
    }
    if (type === PINGRESP) {
        return { type: 'pingresp' };
    }
    return { type: 'other', packetType: type };
}

// PUBLISH (3.3): the topic, a packet identifier only at QoS 1 or 2, and then
// the payload, which runs to the end of the packet.
function parsePublish(firstByte, body) {
    const qos = (firstByte >> 1) & 0x03;
    if (qos === 3) {
        throw new RangeError('A malformed MQTT PUBLISH: QoS 3 does not exist.');
    }
    need(body, 2, 'PUBLISH');
    const topicEnd = 2 + ((body[0] << 8) | body[1]);
    const payloadStart = qos > 0 ? topicEnd + 2 : topicEnd;
    need(body, payloadStart, 'PUBLISH');
    return {
        type: 'publish',
        topic: decodeString(body.subarray(2, topicEnd)),
        payload: decodeString(body.subarray(payloadStart)),
        qos: qos,
        packetId: qos > 0 ? (body[topicEnd] << 8) | body[topicEnd + 1] : null,
        retain: (firstByte & 0x01) === 1,
        dup: (firstByte & 0x08) === 0x08
    };
}

function need(body, length, name) {
    if (body.length < length) {
        throw new RangeError('A malformed MQTT ' + name + ': ' + body.length + ' bytes where it needs ' + length + '.');
    }
}
