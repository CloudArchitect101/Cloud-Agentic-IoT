import { Thermometer, Droplets, Wifi, WifiOff, TriangleAlert } from "lucide-react";
import type { Device } from "../../api/portal/portalApi";
import { formatValue, latest, sparkline, status, timeAgo } from "./format";

const STATUS_TEXT = { online: "Monitor connected", offline: "Monitor offline", unknown: "Status unknown" };

export function RoomCard({ device }: { device: Device }) {
	const now = latest(device);
	const state = status(device);
	const trend = sparkline(device.readings, 240, 48);
	return (
		<article className="rounded-2xl border border-border bg-card p-6 shadow-sm" aria-labelledby={`dev-${device.assetId}`}>
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 id={`dev-${device.assetId}`} className="text-lg font-semibold text-foreground">
						{device.name}
					</h2>
					<p className="text-sm text-muted-foreground">Device {device.serialNumber}</p>
				</div>
				<span
					className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${
						state === "online"
							? "bg-[var(--ok-bg)] text-[var(--ok-fg)]"
							: state === "offline"
								? "bg-[var(--warn-bg)] text-[var(--warn-fg)]"
								: "bg-muted text-muted-foreground"
					}`}
				>
					{state === "online" ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
					{STATUS_TEXT[state]}
				</span>
			</header>

			<dl className="mt-6 grid grid-cols-2 gap-4">
				<div className="rounded-xl bg-[var(--tile)] p-4">
					<dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
						<Thermometer className="size-4" aria-hidden /> Temperature
					</dt>
					<dd className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
						{formatValue(now?.temperature, " °C")}
					</dd>
				</div>
				<div className="rounded-xl bg-[var(--tile)] p-4">
					<dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
						<Droplets className="size-4" aria-hidden /> Humidity
					</dt>
					<dd className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
						{formatValue(now?.humidity, " %", 0)}
					</dd>
				</div>
			</dl>

			{now?.roomTemperatureAlert && (
				<p className="mt-4 flex items-start gap-2 rounded-xl bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">
					<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
					Temperature alert: the temperature is above its limit. The device's motor spins to let you know, and the care team has been told.
				</p>
			)}

			{trend && (
				<figure className="mt-6">
					<svg viewBox="0 0 240 48" preserveAspectRatio="none" className="h-12 w-full" role="img" aria-label="Temperature trend, oldest to newest">
						<polyline points={trend} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
					</svg>
					<figcaption className="mt-1 text-xs text-muted-foreground">
						Last {device.readings.length} readings
					</figcaption>
				</figure>
			)}

			<p className="mt-4 text-sm text-muted-foreground">Updated {timeAgo(now?.at)}</p>
		</article>
	);
}
