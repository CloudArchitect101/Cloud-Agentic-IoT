import { describe, expect, it } from "vitest";
import { formatValue, sparkline, status, timeAgo } from "./format";
import type { Device } from "../../api/portal/portalApi";

const device = (connectionStatus: string | null): Device => ({
	assetId: "02i",
	serialNumber: "Test8",
	name: "Room 4",
	connectionStatus,
	connectionSince: null,
	readings: [],
});

describe("room card helpers", () => {
	it("formats a missing value as a dash", () => {
		expect(formatValue(null, " °C")).toBe("–");
		expect(formatValue(22.46, " °C")).toBe("22.5 °C");
	});

	it("says how long ago in plain words", () => {
		const now = new Date("2026-11-09T12:30:00Z");
		expect(timeAgo("2026-11-09T12:29:50Z", now)).toBe("just now");
		expect(timeAgo("2026-11-09T12:26:00Z", now)).toBe("4 min ago");
		expect(timeAgo("2026-11-09T10:30:00Z", now)).toBe("2 h ago");
		expect(timeAgo(null, now)).toBe("no reading yet");
	});

	it("maps the Asset's connection status", () => {
		expect(status(device("Online"))).toBe("online");
		expect(status(device("Offline"))).toBe("offline");
		expect(status(device(null))).toBe("unknown");
	});

	it("draws the trend oldest first", () => {
		const readings = [30, 20].map((temperature) => ({
			at: null, temperature, humidity: null, heartRate: null, spO2: null, patientState: null, roomTemperatureAlert: false,
		}));
		expect(sparkline(readings, 100, 10)).toBe("0.0,10.0 100.0,0.0");
		expect(sparkline(readings.slice(0, 1), 100, 10)).toBe("");
	});
});
