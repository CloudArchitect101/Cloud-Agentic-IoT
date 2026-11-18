/*
 * Copyright (c) 2024, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useRef } from "react";
import { CircleUser, LogIn, LogOut, UserPen } from "lucide-react";
import { Link, useLocation } from "react-router";
import { useAuth } from "../context/AuthContext";
import { ROUTES } from "../authenticationConfig";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";

interface User {
	readonly id: string;
	readonly name: string;
}

export interface AuthMenuProps {
	/** Custom trigger button for the authenticated user's dropdown */
	trigger?: (user: User) => React.ReactNode;
	/** Content rendered instead of the dropdown when the user is not logged in (e.g. a standalone Sign In button) */
	guestContent?: React.ReactNode;
	/** Extra menu items inserted after "Edit Profile" and before "Sign Out" */
	menuItems?: React.ReactNode;
	/** CSS class applied to the DropdownMenuContent wrapper */
	className?: string;
}

export function AuthMenu({ trigger, guestContent, menuItems, className }: AuthMenuProps) {
	const { user, isAuthenticated, loading, logout } = useAuth();
	const { pathname } = useLocation();
	const userLabelId = useId();
	const openedPathname = useRef(pathname);
	const currentPathname = useRef(pathname);
	useEffect(() => {
		currentPathname.current = pathname;
	}, [pathname]);

	if (loading) {
		return <Skeleton className="size-8 rounded-full" />;
	}

	if (!isAuthenticated && guestContent) {
		return <>{guestContent}</>;
	}

	const defaultTrigger = (
		<Button variant="ghost" size="icon" aria-label="User menu">
			<CircleUser className="size-6" />
		</Button>
	);

	const triggerNode = (isAuthenticated && user && trigger?.(user)) || defaultTrigger;

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (open) openedPathname.current = pathname;
			}}
		>
			<DropdownMenuTrigger asChild>{triggerNode}</DropdownMenuTrigger>

			<DropdownMenuContent
				align="end"
				aria-describedby={isAuthenticated ? userLabelId : undefined}
				className={className ?? "w-48"}
				onCloseAutoFocus={(event) => {
					if (openedPathname.current === currentPathname.current) return;
					event.preventDefault();
					// Recover page focus intercepted by the closing menu trap.
					const active = document.activeElement;
					if (active && active !== document.body && active.isConnected) return;
					const target =
						document.querySelector<HTMLElement>("main h1, [role='main'] h1") ??
						document.querySelector<HTMLElement>("main, [role='main']");
					if (target) {
						if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
						target.focus();
					}
				}}
			>
				{isAuthenticated ? (
					<>
						<DropdownMenuLabel id={userLabelId} className="truncate" aria-hidden="true">
							{user?.name}
						</DropdownMenuLabel>
						<DropdownMenuSeparator aria-hidden="true" />
						<DropdownMenuItem asChild>
							<Link to={ROUTES.PROFILE.PATH}>
								<UserPen className="size-4" />
								Edit Profile
							</Link>
						</DropdownMenuItem>
						{menuItems}
						<DropdownMenuItem onClick={() => logout()}>
							<LogOut className="size-4" />
							Sign Out
						</DropdownMenuItem>
					</>
				) : (
					<>
						<DropdownMenuItem asChild>
							<Link to={ROUTES.LOGIN.PATH}>
								<LogIn className="size-4" />
								Log In
							</Link>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default AuthMenu;
