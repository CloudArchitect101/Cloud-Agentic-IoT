import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Device } from "../../api/portal/portalApi";

const startLive = vi.fn();
vi.mock("../../api/portal/portalApi", () => ({ startLive: (serial: string) => startLive(serial) }));

const { parseLiveReading, REFRESH_MS, useLiveReading, withLive } = await import("./useLiveReading");

/** A WebSocket that never connects: the hook's Salesforce calls are what is counted here. */
class SilentSocket {
	static OPEN = 1;
	static opened = 0;
	readyState = 0;
	binaryType = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor() {
		SilentSocket.opened += 1;
	}
	send() {}
	close() {}
}

const LINK = { url: "wss://x-ats.iot.us-east-2.amazonaws.com/mqtt?sig", clientId: "live-Test8-1", topic: "device/Test8/live", expiresAt: "", seconds: 2 };

function setHidden(hidden: boolean) {
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("live readings from AWS IoT", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		startLive.mockReset();
		startLive.mockResolvedValue({ live: LINK, temperatureAlert: false });
		SilentSocket.opened = 0;
		vi.stubGlobal("WebSocket", SilentSocket);
		Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("asks Salesforce once on open and once per 10 minutes, not every 30 seconds", async () => {
		renderHook(() => useLiveReading("Test8", true));
		await act(async () => {});
		expect(startLive).toHaveBeenCalledTimes(1);
		expect(SilentSocket.opened).toBe(1);

		await act(async () => {
			vi.advanceTimersByTime(REFRESH_MS - 1000);
		});
		expect(startLive).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		// One hour of an open page: 1 + 6 calls, where the old 30 s refresh was 120.
		await act(async () => {
			vi.advanceTimersByTime(50 * 60 * 1000);
		});
		expect(startLive).toHaveBeenCalledTimes(7);
	});

	it("asks nothing while the page is hidden, and starts again when it is shown", async () => {
		renderHook(() => useLiveReading("Test8", true));
		await act(async () => {});
		act(() => setHidden(true));
		await act(async () => {
			vi.advanceTimersByTime(60 * 60 * 1000);
		});
		expect(startLive).toHaveBeenCalledTimes(1);

		await act(async () => setHidden(false));
		expect(startLive).toHaveBeenCalledTimes(2);
	});

	it("asks nothing for a device that is offline", async () => {
		renderHook(() => useLiveReading("Test8", false));
		await act(async () => {
			vi.advanceTimersByTime(REFRESH_MS * 3);
		});
		expect(startLive).not.toHaveBeenCalled();
	});

	it("reads the board's live message", () => {
		const now = new Date("2026-11-25T21:00:00Z");
		expect(parseLiveReading('{"temperature":31.2,"humidity":40,"rssi":-60}', now)).toEqual({
			temperature: 31.2, humidity: 40, at: "2026-11-25T21:00:00.000Z",
		});
		expect(parseLiveReading("not json", now)).toBeNull();
		expect(parseLiveReading('{"rssi":-60}', now)).toBeNull();
		expect(parseLiveReading(undefined, now)).toBeNull();
	});

	it("puts the live reading first, ahead of the saved ones", () => {
		const device: Device = {
			assetId: "02i", serialNumber: "Test8", name: "Room 4", connectionStatus: "Online", connectionSince: null,
			readings: [{ at: "2026-11-25T20:00:00Z", temperature: 22, humidity: 40, heartRate: null, spO2: null, patientState: "STABLE", roomTemperatureAlert: false }],
		};
		const merged = withLive(device, { reading: { temperature: 31, humidity: 41, at: "2026-11-25T21:00:00Z" }, connected: true, temperatureAlert: true });
		expect(merged.readings).toHaveLength(2);
		expect(merged.readings[0]).toMatchObject({ temperature: 31, live: true, roomTemperatureAlert: true, patientState: "STABLE" });
		expect(withLive(device, { reading: null, connected: false, temperatureAlert: null })).toBe(device);
	});
});
