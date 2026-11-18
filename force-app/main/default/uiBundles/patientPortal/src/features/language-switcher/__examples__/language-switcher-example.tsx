/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/**
 * Example: mounting <LanguageSwitcher /> in an app layout/header.
 *
 * This file is illustrative — it is copied into the app as an example, not wired
 * into routing. To adopt the switcher, render <LanguageSwitcher /> wherever your
 * app's chrome lives (typically the nav/header in `appLayout.tsx`). It manages
 * its own state from the URL + SFDC_ENV, so no props are required.
 */

import { Outlet } from "react-router";
import { LanguageSwitcher } from "../index";

export default function AppLayoutWithLanguageSwitcher() {
	return (
		<>
			<nav className="bg-white border-b border-gray-200">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						<span className="text-xl font-semibold text-gray-900">React App</span>
						<div className="flex items-center gap-2">
							{/* Drop the switcher anywhere in your header/chrome. */}
							<LanguageSwitcher />
						</div>
					</div>
				</div>
			</nav>
			<Outlet />
		</>
	);
}
