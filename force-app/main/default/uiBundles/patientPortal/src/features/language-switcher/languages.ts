/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/** A single language option offered by the switcher. */
export interface LanguageOption {
	/** Salesforce locale code, e.g. "en_US". Used as the URL path segment. */
	code: string;
	/** Human-readable label shown in the dropdown, e.g. "English". */
	label: string;
}

/**
 * The languages this app offers in the switcher.
 *
 * IMPORTANT — keep this list in sync BY HAND with the site's language settings:
 *   digitalExperiences/site/<siteName>/sfdc_cms__languageSettings/content.json
 *
 * There is no runtime API to read `sfdc_cms__languageSettings` on a published
 * site, so the supported languages are baked into the bundle at authoring time.
 * When the site's content.json changes, update this array (and
 * {@link DEFAULT_LANGUAGE}) to match.
 *
 * `code` values are Salesforce locale codes (underscores). They are converted to
 * hyphenated form for use as the first URL path segment after `basePath` (e.g.
 * `en_US` → `/en-US/...`, `fr` → `/fr/...`). Display order here is the order shown
 * in the dropdown.
 */
export const LANGUAGES: readonly LanguageOption[] = [
	{ code: "en_US", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "ja", label: "日本語" },
];

/**
 * Language used when `SFDC_ENV.language` is missing or is not one of
 * {@link LANGUAGES}. Should match the site's default language in content.json.
 */
export const DEFAULT_LANGUAGE = "en_US";

/** Set of known language codes, for fast membership checks. */
export const LANGUAGE_CODES: ReadonlySet<string> = new Set(LANGUAGES.map((l) => l.code));
