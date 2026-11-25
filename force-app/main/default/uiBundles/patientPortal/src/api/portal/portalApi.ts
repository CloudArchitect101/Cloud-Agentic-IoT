/**
 * The patient portal's three Apex REST endpoints, called through the Data SDK
 * so they run as the signed-in patient (the SDK adds the session and CSRF
 * handling). Both decide whose data it is from the session alone: nothing
 * sent from here can widen what comes back.
 */
import { createDataSDK } from "@salesforce/platform-sdk";

export interface Reading {
	at: string | null;
	temperature: number | null;
	humidity: number | null;
	heartRate: number | null;
	spO2: number | null;
	patientState: string | null;
	roomTemperatureAlert: boolean;
	/** The newest reading the board stored in AWS, not a saved Salesforce one. */
	live?: boolean;
}

export interface Device {
	assetId: string;
	serialNumber: string;
	name: string;
	connectionStatus: string | null;
	connectionSince: string | null;
	readings: Reading[];
	/** Why there is no newer reading from AWS, when there is none. */
	liveNote?: string | null;
}

export interface MyDevices {
	patient: boolean;
	message?: string;
	devices: Device[];
}

/** What Enhanced Chat needs to start, signed in as this patient. */
export interface ChatStart {
	enabled: boolean;
	message?: string;
	orgId?: string;
	deploymentName?: string;
	siteUrl?: string;
	scrtUrl?: string;
	token?: string;
	/** Seconds since the epoch. */
	expiresAt?: number;
}

/** A 15-minute link to one board's live readings in AWS IoT (PortalLiveResource). */
export interface LiveLink {
	url: string;
	clientId: string;
	topic: string;
	expiresAt: string;
	/** How often the board sends while live, in seconds. */
	seconds: number;
}

export interface LiveStart {
	live: LiveLink | null;
	temperatureAlert: boolean;
	message?: string;
}

async function portalFetch(path: string, init?: RequestInit): Promise<Response> {
	const sdk = await createDataSDK();
	if (!sdk.fetch) {
		throw new Error("This page cannot reach Salesforce from here.");
	}
	return sdk.fetch(`/services/apexrest/portal/${path}`, init);
}

export async function getMyDevices(readings = 12): Promise<MyDevices> {
	const res = await portalFetch(`my-devices?readings=${readings}`);
	const body = (await res.json()) as MyDevices;
	if (!res.ok && res.status !== 403) {
		throw new Error(body.message ?? `Your devices could not be loaded (${res.status}).`);
	}
	return { ...body, devices: body.devices ?? [] };
}

export async function startChat(): Promise<ChatStart> {
	const res = await portalFetch("chat-token", { method: "POST" });
	const body = (await res.json()) as ChatStart;
	return res.ok ? body : { enabled: false, message: body.message ?? `Chat unavailable (${res.status}).` };
}

/**
 * Tells the board to send live readings for 15 minutes and returns the link
 * the browser receives them on. One Salesforce API call; the readings
 * themselves come from AWS IoT and cost Salesforce nothing.
 */
export async function startLive(serialNumber: string): Promise<LiveStart> {
	const res = await portalFetch("live", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ serialNumber }),
	});
	const body = (await res.json()) as Partial<LiveStart>;
	return res.ok && body.live
		? { live: body.live, temperatureAlert: body.temperatureAlert === true }
		: { live: null, temperatureAlert: false, message: body.message ?? `Live readings unavailable (${res.status}).` };
}
