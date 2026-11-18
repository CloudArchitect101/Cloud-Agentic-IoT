/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/**
 * Drop-in language switcher for B2X (Experience) apps.
 *
 * Renders a labeled `<select>` of the site's supported {@link LANGUAGES}.
 * Choosing a language rewrites the current URL so the chosen code becomes the
 * first path segment after `basePath` (see {@link buildLanguageUrl}) and reloads
 * the page via `window.location.assign`. A full reload lets the platform serve
 * the correctly localized content — this component owns only the URL rewrite.
 */

import { buildLanguageUrl, getLanguageFromUrl, urlSegmentToCode } from "./buildLanguageUrl";
import { DEFAULT_LANGUAGE, LANGUAGE_CODES, LANGUAGES } from "./languages";

/**
 * The subset of `SFDC_ENV` this component reads. We type it structurally here
 * (rather than relying on the ambient `SfdcEnv`) so the feature type-checks in
 * isolation: its ambient augmentation intentionally declares only `language?`,
 * while `basePath` is provided by the platform types once composed into an app.
 */
interface SfdcEnvSubset {
	basePath?: string;
	/** Page locale in hyphenated form, e.g. "en-US" (the platform's injected form). */
	language?: string;
}

/** Read `SFDC_ENV` off the global scope without assuming it exists. */
function getSfdcEnv(): SfdcEnvSubset | undefined {
	return (globalThis as { SFDC_ENV?: SfdcEnvSubset }).SFDC_ENV;
}

/**
 * Resolve the active language, in precedence order:
 *
 * 1. `SFDC_ENV.language` — authoritative when the platform provides it. The
 *    platform injects this in hyphenated form (e.g. `"en-US"`), so it is
 *    remapped back to a locale code (`en_US`) before matching, mirroring how the
 *    URL segment is handled.
 * 2. The leading URL path segment after `basePath`, when it is a supported
 *    language code — reflects the page the user is actually viewing (e.g. a
 *    direct hit on `/shop/fr/catalog`) even before the runtime populates
 *    `SFDC_ENV.language`.
 * 3. {@link DEFAULT_LANGUAGE}.
 *
 * Only codes in {@link LANGUAGES} are honored; anything else falls through.
 */
export function getCurrentLanguage(): string {
	const envLanguage = getSfdcEnv()?.language;
	if (envLanguage) {
		const envCode = urlSegmentToCode(envLanguage);
		if (LANGUAGE_CODES.has(envCode)) {
			return envCode;
		}
	}

	const basePath = getSfdcEnv()?.basePath ?? "";
	const urlLanguage = getLanguageFromUrl(window.location.href, basePath, LANGUAGE_CODES);
	return urlLanguage ?? DEFAULT_LANGUAGE;
}

export interface LanguageSwitcherProps {
	/** Accessible label for the control. Defaults to "Language". */
	label?: string;
	/** Extra classes merged onto the `<select>`. */
	className?: string;
}

export function LanguageSwitcher({ label = "Language", className }: LanguageSwitcherProps) {
	// Render nothing when there is no real choice to make. A single-option
	// dropdown is an inert control: it can't change anything, yet it still takes
	// a focus stop and is announced as a "1 of 1" menu, implying options that
	// don't exist. Omitting it entirely keeps the accessibility tree honest.
	if (LANGUAGES.length < 2) {
		return null;
	}

	const current = getCurrentLanguage();

	const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const next = event.target.value;
		// No-op when the selection already matches the active language.
		if (next === current) return;

		const basePath = getSfdcEnv()?.basePath ?? "";
		const nextUrl = buildLanguageUrl(
			window.location.href,
			basePath,
			next,
			LANGUAGE_CODES,
			DEFAULT_LANGUAGE,
		);
		window.location.assign(nextUrl);
	};

	return (
		<select
			aria-label={label}
			value={current}
			onChange={handleChange}
			className={
				className ?? "rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground"
			}
		>
			{LANGUAGES.map((language) => (
				<option key={language.code} value={language.code}>
					{language.label}
				</option>
			))}
		</select>
	);
}
