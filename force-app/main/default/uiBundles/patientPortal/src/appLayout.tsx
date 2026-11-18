import { Outlet, Link, useLocation } from "react-router";
import { getAllRoutes } from "./router-utils";
import { useEffect, useId, useRef, useState } from "react";
import { AuthMenu } from "./features/authentication/menu/AuthMenu";
import { Button } from "./components/ui/button";
import PatientChat from "./components/PatientChat";
import { useAuth } from "./features/authentication/context/AuthContext";
import { HeartPulse } from "lucide-react";

export default function AppLayout() {
	const [isOpen, setIsOpen] = useState(false);
	const { isAuthenticated } = useAuth();
	const [chatNote, setChatNote] = useState<string | null>(null);
	const location = useLocation();
	const navId = useId();
	const outletWrapperRef = useRef<HTMLDivElement>(null);
	const previousPathname = useRef<string | null>(null);
	const menuButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (previousPathname.current !== null && previousPathname.current !== location.pathname) {
			const wrapper = outletWrapperRef.current;
			const target = wrapper?.querySelector<HTMLElement>("h1");
			if (target) {
				if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
				target.focus();
			}
		}
		previousPathname.current = location.pathname;
	}, [location.pathname]);

	const isActive = (path: string) => location.pathname === path;

	const toggleMenu = () => setIsOpen(!isOpen);

	const navigationRoutes: { path: string; label: string }[] = getAllRoutes()
		.filter(
			(route) =>
				route.handle?.showInNavigation === true &&
				route.fullPath !== undefined &&
				route.handle?.label !== undefined,
		)
		.map(
			(route) =>
				({
					path: route.fullPath,
					label: route.handle?.label,
				}) as { path: string; label: string },
		);

	return (
		<>
			<a
				href="#main-content"
				onClick={(e) => {
					e.preventDefault();
					const content = outletWrapperRef.current;
					if (content) {
						if (!content.hasAttribute("tabindex")) content.setAttribute("tabindex", "-1");
						content.focus();
					}
				}}
				className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-gray-900 focus:shadow focus:ring-2 focus:ring-gray-900"
			>
				Skip to main content
			</a>
			<nav aria-label="Primary" className="bg-card border-b border-border">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						<Link to="/" className="flex items-center gap-2 text-xl font-semibold text-foreground">
							<HeartPulse className="size-6 text-primary" aria-hidden />
							Patient Portal
						</Link>
						<div className="flex items-center gap-2">
							<AuthMenu />
							<Button
								ref={menuButtonRef}
								variant="ghost"
								size="icon"
								onClick={toggleMenu}
								aria-label="Toggle menu"
								aria-expanded={isOpen}
								aria-controls={navId}
							>
								<div
									aria-hidden="true"
									className="w-6 h-6 flex flex-col justify-center space-y-1.5"
								>
									<span
										className={`block h-0.5 w-6 bg-current transition-all ${
											isOpen ? "rotate-45 translate-y-2" : ""
										}`}
									/>
									<span
										className={`block h-0.5 w-6 bg-current transition-all ${isOpen ? "opacity-0" : ""}`}
									/>
									<span
										className={`block h-0.5 w-6 bg-current transition-all ${
											isOpen ? "-rotate-45 -translate-y-2" : ""
										}`}
									/>
								</div>
							</Button>
						</div>
					</div>
					<div id={navId} className="pb-4" hidden={!isOpen}>
						{isOpen && (
							<div className="flex flex-col space-y-1">
								{navigationRoutes.map((item) => (
									<Button
										key={item.path}
										variant={isActive(item.path) ? "secondary" : "ghost"}
										asChild
										className="justify-start"
									>
										<Link
											to={item.path}
											onClick={() => {
												setIsOpen(false);
												if (isActive(item.path)) menuButtonRef.current?.focus();
											}}
										>
											{item.label}
										</Link>
									</Button>
								))}
							</div>
						)}
					</div>
				</div>
			</nav>
			<div id="main-content" ref={outletWrapperRef}>
				<Outlet />
			</div>
			<PatientChat signedIn={isAuthenticated} onUnavailable={setChatNote} />
			{chatNote && isAuthenticated && (
				<p role="status" className="fixed bottom-4 right-4 max-w-xs rounded-xl bg-card p-3 text-sm text-muted-foreground shadow-lg">
					{chatNote}
				</p>
			)}
		</>
	);
}
