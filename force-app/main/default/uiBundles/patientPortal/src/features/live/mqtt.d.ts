/** Types for mqtt.js, a byte-for-byte copy of lwc/deviceLiveCard/mqtt.js (test/lwc/portal-mqtt-copy.test.js). */
export const CONNACK: number;
export const PUBLISH: number;
export const SUBACK: number;
export const PINGRESP: number;
export const SUBACK_FAILURE: number;
export const KEEP_ALIVE_SECONDS: number;
export function encodeRemainingLength(length: number): number[];
export function encodeConnect(clientId: string, keepAliveSeconds?: number): Uint8Array;
export function encodeSubscribe(packetId: number, topic: string): Uint8Array;
export function encodePingreq(): Uint8Array;
export function encodeDisconnect(): Uint8Array;
export function connackReason(returnCode: number): string;
export interface Packet {
	type: "connack" | "suback" | "publish" | "pingresp" | "other";
	returnCode?: number;
	returnCodes?: number[];
	topic?: string;
	payload?: string;
}
export function createReader(): { push(chunk: ArrayBuffer | Uint8Array | string): Packet[] };
