import { useCallback, useEffect, useState } from "react";
import { MessageCircleHeart, Mic, PhoneCall } from "lucide-react";
import { getMyDevices, type MyDevices } from "../api/portal/portalApi";
import { RoomCard } from "../features/devices/RoomCard";
import { useAuth } from "../features/authentication/context/AuthContext";

const REFRESH_MS = 30_000;

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
		load();
		const timer = window.setInterval(load, REFRESH_MS);
		return () => window.clearInterval(timer);
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
				Here is what your temperature monitor is reporting. It refreshes on its own.
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
				{data?.devices.map((device) => <RoomCard key={device.assetId} device={device} />)}
			</section>

			<section aria-labelledby="help" className="mt-10 rounded-2xl bg-[var(--hero)] p-6 sm:p-8">
				<h2 id="help" className="flex items-center gap-2 text-xl font-semibold text-foreground">
					<MessageCircleHeart className="size-6 text-primary" aria-hidden /> Need something?
				</h2>
				<p className="mt-2 max-w-2xl text-foreground/80">
					Open the care assistant with the chat button in the corner. Ask about your temperature, or ask for a nurse
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
