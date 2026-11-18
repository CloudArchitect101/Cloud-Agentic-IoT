/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

import { Link } from "react-router";

export default function NotFound() {
	return (
		<main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
			<title>Page Not Found | Patient Portal</title>
			<div className="text-center">
				<h1 className="text-4xl font-bold text-foreground mb-4">404</h1>
				<p className="text-lg text-muted-foreground mb-8">Page not found</p>
				<Link
					to="/"
					className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-colors"
				>
					Back to my monitor
				</Link>
			</div>
		</main>
	);
}
