'use strict';

/*
 * The MQTT 3.1.1 the device live card speaks to AWS IoT
 * (force-app/main/default/lwc/deviceLiveCard/mqtt.js).
 *
 * The file is an ES module written for the browser. Node imports its text as a
 * data: URL, so the bytes tested here are the bytes the card sends, with no
 * build step and no Jest. Expected packets are written out by hand from the
 * MQTT 3.1.1 standard, not produced by the code under test.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '../../force-app/main/default/lwc/deviceLiveCard/mqtt.js');

let mqtt;
before(async () => {
  mqtt = await import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(SOURCE, 'utf8'))}`);
});

const ascii = (text) => [...Buffer.from(text, 'ascii')];

// What the card receives: each WebSocket message's data is an ArrayBuffer.
const arrayBuffer = (bytes) => new Uint8Array(bytes).buffer;

// A PUBLISH as AWS IoT sends one at QoS 0: topic length, topic, payload.
function publish(topic, payload, header = null) {
  const topicBytes = [...Buffer.from(topic, 'utf8')];
  const body = [topicBytes.length >> 8, topicBytes.length & 0xff, ...topicBytes, ...Buffer.from(payload, 'utf8')];
  assert.ok(header || body.length < 128, 'a body this long needs its remaining length written out');
  return [0x30, ...(header || [body.length]), ...body];
}

// ------------------------------------------------------------------ encoders

test('CONNECT: MQTT 3.1.1, a clean session, a 60 s keep-alive and the client id', () => {
  const clientId = 'live-CompanyInternalESP32-1a2b3c4d';
  assert.deepEqual([...mqtt.encodeConnect(clientId)], [
    0x10, 46,                                 // CONNECT, 46 bytes follow
    0x00, 0x04, ...ascii('MQTT'),             // protocol name
    0x04,                                     // protocol level 4 = 3.1.1
    0x02,                                     // clean session; no will, user name or password
    0x00, 0x3c,                               // keep-alive 60 s
    0x00, 0x22, ...ascii(clientId),           // client id, 34 bytes
  ]);
  assert.equal(mqtt.KEEP_ALIVE_SECONDS, 60);
});

test('SUBSCRIBE: one topic at QoS 0, with the flag bits the standard fixes', () => {
  const topic = 'device/CompanyInternalESP32/live';
  assert.deepEqual([...mqtt.encodeSubscribe(1, topic)], [
    0x82, 37,                                 // SUBSCRIBE (flags 0010), 37 bytes follow
    0x00, 0x01,                               // packet identifier 1
    0x00, 0x20, ...ascii(topic),              // topic filter, 32 bytes
    0x00,                                     // requested QoS 0
  ]);
});

test('PINGREQ and DISCONNECT are two bytes each', () => {
  assert.deepEqual([...mqtt.encodePingreq()], [0xc0, 0x00]);
  assert.deepEqual([...mqtt.encodeDisconnect()], [0xe0, 0x00]);
});

test('the encoders refuse what MQTT cannot carry', () => {
  assert.throws(() => mqtt.encodeConnect(''), /client identifier/);
  assert.throws(() => mqtt.encodeSubscribe(0, 'device/CompanyInternalESP32/live'), /packet identifier/);
  assert.throws(() => mqtt.encodeSubscribe(1, ''), /topic filter/);
  assert.throws(() => mqtt.encodeRemainingLength(268435456), /remaining length/);
  assert.throws(() => mqtt.encodeRemainingLength(-1), /remaining length/);
});

// ---------------------------------------------------------- remaining length

// Each value where the encoding gains a byte, from the standard's table 2.4.
const LENGTHS = [
  [0, [0x00]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [16383, [0xff, 0x7f]],
  [16384, [0x80, 0x80, 0x01]],
  [2097151, [0xff, 0xff, 0x7f]],
  [2097152, [0x80, 0x80, 0x80, 0x01]],
  [268435455, [0xff, 0xff, 0xff, 0x7f]],
];

test('remaining length: one to four bytes, seven bits each, lowest first', () => {
  for (const [length, bytes] of LENGTHS) {
    assert.deepEqual(mqtt.encodeRemainingLength(length), bytes, `length ${length}`);
  }
});

test('remaining length: the reader takes back 127, 128, 16383 and 16384', () => {
  for (const [length, header] of LENGTHS.filter(([length]) => [127, 128, 16383, 16384].includes(length))) {
    const topic = 'device/CompanyInternalESP32/live';
    const payload = 'x'.repeat(length - 2 - topic.length);
    const packets = mqtt.createReader().push(arrayBuffer(publish(topic, payload, header)));
    assert.equal(packets.length, 1, `length ${length}`);
    assert.equal(packets[0].topic, topic);
    assert.equal(packets[0].payload.length, payload.length, `length ${length}`);
  }
});

test('a remaining length of more than four bytes is malformed', () => {
  assert.throws(() => mqtt.createReader().push(arrayBuffer([0x30, 0xff, 0xff, 0xff, 0xff, 0x01])), /four bytes/);
});

// -------------------------------------------------------------------- reader

test('a PUBLISH: its topic, its UTF-8 payload and its QoS', () => {
  const reading = '{"deviceId":"CompanyInternalESP32","temperature":22.5,"humidity":41,"note":"22.5 °C"}';
  const [packet] = mqtt.createReader().push(arrayBuffer(publish('device/CompanyInternalESP32/live', reading)));
  assert.deepEqual(packet, {
    type: 'publish', topic: 'device/CompanyInternalESP32/live', payload: reading,
    qos: 0, packetId: null, retain: false, dup: false,
  });
  assert.equal(JSON.parse(packet.payload).note, '22.5 °C');
});

test('a PUBLISH split across two chunks comes out once, when it is whole', () => {
  const bytes = publish('device/CompanyInternalESP32/live', '{"temperature":22.5}');
  const reader = mqtt.createReader();
  assert.deepEqual(reader.push(arrayBuffer(bytes.slice(0, 9))), []);
  const packets = reader.push(arrayBuffer(bytes.slice(9)));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].payload, '{"temperature":22.5}');
});

test('a PUBLISH split inside its remaining length waits for the rest of it', () => {
  const topic = 'device/CompanyInternalESP32/live';
  const bytes = publish(topic, 'y'.repeat(200 - 2 - topic.length), [0xc8, 0x01]);   // 200
  const reader = mqtt.createReader();
  assert.deepEqual(reader.push(arrayBuffer(bytes.slice(0, 2))), []);   // the first length byte only
  assert.deepEqual(reader.push(arrayBuffer(bytes.slice(2, 3))), []);
  const packets = reader.push(arrayBuffer(bytes.slice(3)));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].payload.length, 200 - 2 - topic.length);
});

test('two packets in one chunk both come out, in order, and a third may start there', () => {
  const first = publish('device/CompanyInternalESP32/live', '{"n":1}');
  const second = publish('device/CompanyInternalESP32/live', '{"n":2}');
  const third = publish('device/CompanyInternalESP32/live', '{"n":3}');
  const reader = mqtt.createReader();
  const packets = reader.push(arrayBuffer([...first, ...second, ...third.slice(0, 4)]));
  assert.deepEqual(packets.map((packet) => packet.payload), ['{"n":1}', '{"n":2}']);
  assert.deepEqual(reader.push(arrayBuffer(third.slice(4))).map((packet) => packet.payload), ['{"n":3}']);
});

test('CONNACK and SUBACK arriving in one chunk, as AWS IoT often sends them', () => {
  const packets = mqtt.createReader().push(arrayBuffer([0x20, 0x02, 0x00, 0x00, 0x90, 0x03, 0x00, 0x01, 0x00]));
  assert.deepEqual(packets, [
    { type: 'connack', sessionPresent: false, returnCode: 0 },
    { type: 'suback', packetId: 1, returnCodes: [0] },
  ]);
});

test('CONNACK refusal codes come back as they are, with their meaning', () => {
  const meanings = {
    1: 'unacceptable protocol version',
    2: 'client identifier rejected',
    3: 'server unavailable',
    4: 'bad user name or password',
    5: 'not authorized',
  };
  for (const [code, meaning] of Object.entries(meanings)) {
    const [packet] = mqtt.createReader().push(arrayBuffer([0x20, 0x02, 0x00, Number(code)]));
    assert.equal(packet.type, 'connack');
    assert.equal(packet.returnCode, Number(code));
    assert.equal(mqtt.connackReason(packet.returnCode), meaning);
  }
  assert.equal(mqtt.connackReason(0), 'accepted');
  assert.match(mqtt.connackReason(9), /9/);
});

test('a SUBACK failure (0x80) says the topic was refused', () => {
  const [packet] = mqtt.createReader().push(arrayBuffer([0x90, 0x03, 0x00, 0x01, 0x80]));
  assert.deepEqual(packet, { type: 'suback', packetId: 1, returnCodes: [0x80] });
  assert.equal(packet.returnCodes[0], mqtt.SUBACK_FAILURE);
});

test('PINGRESP, and a packet the card never asks for', () => {
  const packets = mqtt.createReader().push(arrayBuffer([0xd0, 0x00, 0xb0, 0x02, 0x00, 0x01]));
  assert.deepEqual(packets, [{ type: 'pingresp' }, { type: 'other', packetType: 11 }]);
});

test('a QoS 1 PUBLISH carries its packet identifier before the payload', () => {
  const topic = [...Buffer.from('device/CompanyInternalESP32/live')];
  const body = [0x00, topic.length, ...topic, 0x12, 0x34, ...Buffer.from('{}')];
  const [packet] = mqtt.createReader().push(arrayBuffer([0x33, body.length, ...body]));   // QoS 1, retain
  assert.equal(packet.qos, 1);
  assert.equal(packet.packetId, 0x1234);
  assert.equal(packet.retain, true);
  assert.equal(packet.payload, '{}');
});

test('the reader takes typed arrays as well as ArrayBuffers, and copies what it keeps', () => {
  const bytes = new Uint8Array(publish('device/CompanyInternalESP32/live', '{"n":1}'));
  const reader = mqtt.createReader();
  assert.deepEqual(reader.push(bytes.subarray(0, 5)), []);
  bytes.fill(0, 0, 5);                                   // the caller reuses its buffer
  const packets = reader.push(new Uint8Array(publish('device/CompanyInternalESP32/live', '{"n":1}')).subarray(5));
  assert.equal(packets[0].payload, '{"n":1}');
});

test('text where bytes belong, or a malformed packet, throws instead of hanging', () => {
  assert.throws(() => mqtt.createReader().push('{"n":1}'), /binaryType/);
  assert.throws(() => mqtt.createReader().push(arrayBuffer([0x20, 0x01, 0x00])), /malformed MQTT CONNACK/);
  assert.throws(() => mqtt.createReader().push(arrayBuffer([0x90, 0x02, 0x00, 0x01])), /malformed MQTT SUBACK/);
  assert.throws(() => mqtt.createReader().push(arrayBuffer([0x30, 0x03, 0x00, 0x09, 0x41])), /malformed MQTT PUBLISH/);
  assert.throws(() => mqtt.createReader().push(arrayBuffer([0x36, 0x02, 0x00, 0x00])), /QoS 3/);
  assert.throws(() => mqtt.createReader().push(arrayBuffer([0x30, 0x80, 0x80, 0x20])), /larger than AWS IoT sends/);
});
