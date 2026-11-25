import { useCallback, useEffect, useState } from "react";
import { MessageCircleHeart, Mic, PhoneCall } from "lucide-react";
import { getMyDevices, type Device, type MyDevices } from "../api/portal/portalApi";
import { RoomCard } from "../features/devices/RoomCard";
import { status } from "../features/devices/format";
import { useLiveReading, withLive } from "../features/live/useLiveReading";
import { useAuth } from "../features/authentication/context/AuthContext";

/**
 * The saved readings and connection status come from Salesforce, and each
 * load is one Salesforce API call. They are loaded when the page opens and
 * again when it comes back into view after this long; the live readings in
 * between come from AWS IoT (useLiveReading). The page used to reload every
 * 30 seconds: 120 calls an hour per open tab.
 */
const RELOAD_AFTER_HIDDEN_MS = 5 * 60 * 1000;

function LiveRoomCard({ device }: { device: Device }) {
	const live = useLiveReading(device.serialNumber, status(device) === "online");
	return <RoomCard device={withLive(device, live)} />;
}

function greeting(now = new Date()): string {
	const h = now.getHours();
	return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function HomePage() {
	const { user } = useAuth();
	const [data, setData] = useState<MyDevices | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(() => {
		getMyDevices()
			.then((d) => {
				setData(d);
				setError(null);
			})
			.catch((e: Error) => setError(e.message));
	}, []);

	useEffect(() => {
		let loadedAt = Date.now();
		load();
		const onVisibility = () => {
			if (!document.hidden && Date.now() - loadedAt >= RELOAD_AFTER_HIDDEN_MS) {
				loadedAt = Date.now();
				load();
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [load]);

	const firstName = user?.name?.split(" ")[0];

	return (
		<main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
			<title>My monitor | Patient Portal</title>
			<h1 className="text-3xl font-semibold tracking-tight text-foreground">
				{greeting()}
				{firstName ? `, ${firstName}` : ""}
			</h1>
			<p className="mt-2 text-muted-foreground">
				Here is what your temperature sensor is reporting. Live readings arrive every few seconds while this page is open.
			</p>

			<section aria-label="My devices" className="mt-8 grid gap-6 md:grid-cols-2">
				{error && (
					<p role="alert" className="rounded-xl bg-[var(--warn-bg)] p-4 text-[var(--warn-fg)] md:col-span-2">
						{error}
					</p>
				)}
				{!data && !error && (
					<p role="status" className="text-muted-foreground">
						Loading your monitor…
					</p>
				)}
				{data && data.devices.length === 0 && (
					<p className="rounded-xl bg-muted p-4 text-muted-foreground md:col-span-2">
						{data.message ?? "No monitoring device is linked to your account yet."}
					</p>
				)}
				{data?.devices.map((device) => <LiveRoomCard key={device.assetId} device={device} />)}
			</section>

			<section aria-labelledby="help" className="mt-10 rounded-2xl bg-[var(--hero)] p-6 sm:p-8">
				<h2 id="help" className="flex items-center gap-2 text-xl font-semibold text-foreground">
					<MessageCircleHeart className="size-6 text-primary" aria-hidden /> Need something?
				</h2>
				<p className="mt-2 max-w-2xl text-foreground/80">
					Open the care assistant with the chat button in the corner. Ask about your sensor's readings, or ask for a nurse
					and it sends your request to the care team. It only ever sees your own devices.
				</p>
				<ul className="mt-4 grid gap-3 text-sm text-foreground/80 sm:grid-cols-2">
					<li className="flex items-start gap-2">
						<Mic className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
						Prefer to talk? Start a voice conversation from inside the chat window.
					</li>
					<li className="flex items-start gap-2">
						<PhoneCall className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
						In an emergency, press the call button by your bed. Don't wait for the chat.
					</li>
				</ul>
			</section>
		</main>
	);
}
