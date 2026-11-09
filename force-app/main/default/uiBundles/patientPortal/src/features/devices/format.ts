/** Small, pure helpers for the room cards; tested in format.test.ts. */
import type { Device, Reading } from "../../api/portal/portalApi";

export function latest(device: Device): Reading | undefined {
	return device.readings[0];
}

export function formatValue(value: number | null | undefined, unit: string, digits = 1): string {
	return value === null || value === undefined ? "–" : `${value.toFixed(digits)}${unit}`;
}

/** "just now", "4 min ago", "2 h ago", or the date. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
	if (!iso) return "no reading yet";
	const then = new Date(iso);
	const minutes = Math.round((now.getTime() - then.getTime()) / 60_000);
	if (Number.isNaN(minutes)) return "unknown";
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
	return then.toLocaleDateString();
}

export type Status = "online" | "offline" | "unknown";

export function status(device: Device): Status {
	const s = (device.connectionStatus ?? "").toLowerCase();
	if (s === "online" || s === "connected") return "online";
	if (s === "offline" || s === "disconnected") return "offline";
	return "unknown";
}

/**
 * SVG polyline points for the temperature trend, oldest on the left. The
 * readings arrive newest first.
 */
export function sparkline(readings: Reading[], width: number, height: number): string {
	const values = readings
		.map((r) => r.temperature)
		.filter((v): v is number => typeof v === "number")
		.reverse();
	if (values.length < 2) return "";
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min || 1;
	const step = width / (values.length - 1);
	return values
		.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
		.join(" ");
}
