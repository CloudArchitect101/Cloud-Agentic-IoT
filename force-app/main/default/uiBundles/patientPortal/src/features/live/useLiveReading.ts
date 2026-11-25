/**
 * Live readings for one device, straight from AWS IoT, the way the device
 * card on an Asset gets them (lwc/deviceLiveCard).
 *
 * While the page is visible: one call to Salesforce (startLive) when it
 * opens and one every 10 minutes, which keeps the board in live mode and
 * gets a fresh 15-minute link. The readings arrive over a WebSocket from AWS
 * IoT every couple of seconds and never touch Salesforce. While the page is
 * hidden: the socket is closed and nothing is asked, so a tab left open
 * overnight costs nothing. It used to cost 120 Salesforce API calls an hour
 * (docs/SCALING.md, "Salesforce API calls per device").
 */
import { useEffect, useState } from "react";
import { startLive, type Device, type LiveLink } from "../../api/portal/portalApi";
import {
	connackReason,
	createReader,
	encodeConnect,
	encodeDisconnect,
	encodePingreq,
	encodeSubscribe,
	SUBACK_FAILURE,
} from "./mqtt.js";

/** Inside the link's 15 minutes and the board's 15-minute live window. */
export const REFRESH_MS = 10 * 60 * 1000;
/** Inside the 60-second MQTT keep-alive. */
const PING_MS = 45 * 1000;
const RECONNECT_MS = 2000;
const MAX_RECONNECTS = 5;

export interface LiveReading {
	temperature: number | null;
	humidity: number | null;
	/** When the browser received it, ISO 8601. */
	at: string;
}

export interface LiveState {
	reading: LiveReading | null;
	connected: boolean;
	temperatureAlert: boolean | null;
}

/** A board's live message as JSON, or null when it is not a reading. */
export function parseLiveReading(payload: string | undefined, now = new Date()): LiveReading | null {
	if (!payload) return null;
	let body: unknown;
	try {
		body = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!body || typeof body !== "object") return null;
	const { temperature, humidity } = body as Record<string, unknown>;
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
	if (number(temperature) === null && number(humidity) === null) return null;
	return { temperature: number(temperature), humidity: number(humidity), at: now.toISOString() };
}

export function useLiveReading(serialNumber: string, enabled: boolean): LiveState {
	const [state, setState] = useState<LiveState>({ reading: null, connected: false, temperatureAlert: null });

	useEffect(() => {
		if (!enabled) return;
		let stopped = false;
		let socket: WebSocket | null = null;
		let link: LiveLink | null = null;
		let failures = 0;
		const timers = new Set<ReturnType<typeof setTimeout>>();
		let ping: ReturnType<typeof setInterval> | null = null;
		let refresh: ReturnType<typeof setInterval> | null = null;

		const later = (ms: number, run: () => void) => {
			const id = setTimeout(() => {
				timers.delete(id);
				run();
			}, ms);
			timers.add(id);
		};

		const close = () => {
			if (ping) clearInterval(ping);
			ping = null;
			const open = socket;
			socket = null;
			if (open) {
				open.onclose = null;
				if (open.readyState === WebSocket.OPEN) open.send(encodeDisconnect());
				open.close();
			}
			setState((s) => ({ ...s, connected: false }));
		};

		const connect = () => {
			if (stopped || !link || document.hidden) return;
			const session = link;
			let ws: WebSocket;
			try {
				ws = new WebSocket(session.url, ["mqtt"]);
			} catch (error) {
				// Usually a missing CSP Trusted Site. The message quotes the signed link, so only the name is logged.
				console.warn(`Live readings refused by the browser (${(error as Error).name}). Check the CSP Trusted Site for AWS IoT.`);
				return;
			}
			ws.binaryType = "arraybuffer";
			socket = ws;
			const reader = createReader();
			ws.onopen = () => ws.send(encodeConnect(session.clientId));
			ws.onmessage = (event) => {
				let packets;
				try {
					packets = reader.push(event.data as ArrayBuffer);
				} catch {
					ws.close();
					return;
				}
				for (const packet of packets) {
					if (packet.type === "connack") {
						if (packet.returnCode !== 0) {
							console.warn(`AWS IoT refused the live connection: ${connackReason(packet.returnCode ?? -1)}.`);
							ws.close();
							return;
						}
						ws.send(encodeSubscribe(1, session.topic));
						ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(encodePingreq()), PING_MS);
					} else if (packet.type === "suback") {
						if (packet.returnCodes?.[0] === SUBACK_FAILURE) {
							ws.close();
							return;
						}
						failures = 0;
						setState((s) => ({ ...s, connected: true }));
					} else if (packet.type === "publish" && packet.topic === session.topic) {
						const reading = parseLiveReading(packet.payload);
						if (reading) setState((s) => ({ ...s, reading }));
					}
				}
			};
			ws.onclose = () => {
				if (socket !== ws) return;
				socket = null;
				if (ping) clearInterval(ping);
				ping = null;
				setState((s) => ({ ...s, connected: false }));
				failures += 1;
				if (!stopped && failures <= MAX_RECONNECTS) later(RECONNECT_MS, connect);
			};
		};

		const start = async () => {
			if (stopped || document.hidden) return;
			try {
				const answer = await startLive(serialNumber);
				if (stopped) return;
				setState((s) => ({ ...s, temperatureAlert: answer.temperatureAlert }));
				if (!answer.live) return;
				link = answer.live;
				// An open connection keeps going; the new link is for its next reconnect.
				if (!socket) {
					failures = 0;
					connect();
				}
			} catch {
				// The page keeps the saved readings it already shows.
			}
		};

		const begin = () => {
			void start();
			refresh = setInterval(() => void start(), REFRESH_MS);
		};
		const pause = () => {
			if (refresh) clearInterval(refresh);
			refresh = null;
			timers.forEach(clearTimeout);
			timers.clear();
			close();
		};
		const onVisibility = () => (document.hidden ? pause() : begin());

		if (!document.hidden) begin();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stopped = true;
			document.removeEventListener("visibilitychange", onVisibility);
			pause();
		};
	}, [serialNumber, enabled]);

	return state;
}

/** The device with its newest live reading from AWS IoT first, when there is one. */
export function withLive(device: Device, live: LiveState): Device {
	if (!live.reading) return device;
	const saved = device.readings[0];
	return {
		...device,
		readings: [
			{
				at: live.reading.at,
				temperature: live.reading.temperature,
				humidity: live.reading.humidity,
				heartRate: null,
				spO2: null,
				patientState: saved?.patientState ?? null,
				roomTemperatureAlert: live.temperatureAlert ?? saved?.roomTemperatureAlert ?? false,
				live: true,
			},
			...device.readings.filter((reading) => !reading.live),
		],
	};
}

