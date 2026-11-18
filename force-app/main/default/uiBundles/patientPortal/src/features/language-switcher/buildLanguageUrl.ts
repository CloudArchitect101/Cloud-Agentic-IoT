/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/** Strip leading and trailing slashes from a path fragment. */
function trimSlashes(value: string): string {
	return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Convert a Salesforce locale code to the form used in the URL path.
 *
 * Locale codes use underscores (e.g. `en_US`), but URL path segments use hyphens
 * (e.g. `en-US`). This maps a code to its URL segment.
 */
function codeToUrlSegment(code: string): string {
	return code.replace(/_/g, "-");
}

/**
 * Convert a hyphenated language token back to a Salesforce locale code — the
 * inverse of {@link codeToUrlSegment} (e.g. `en-US` → `en_US`). Locale codes
 * never contain hyphens, so this remapping is unambiguous. Used both for URL
 * path segments and for the hyphenated `SFDC_ENV.language` value the platform
 * injects (e.g. `"en-US"`), which share the same hyphen convention.
 */
export function urlSegmentToCode(segment: string): string {
	return segment.replace(/-/g, "_");
}

/**
 * Recover the true, language-free site root from `basePath`.
 *
 * When a non-default language is active, the platform folds the language segment
 * into `SFDC_ENV.basePath` itself — `/shop` becomes `/shop/fr` — rather than
 * leaving `basePath` as the stable site root with the language living in the path
 * after it. If we took `basePath` at face value, the language segment would be
 * treated as part of the base and never seen as a leading language segment, so
 * switching to the default (which should remove the segment) and switching
 * between non-default languages (which should replace it) would both fail.
 *
 * Strip a single trailing segment when it is a known language (remapped from its
 * URL form back to a locale code), yielding the language-free site root so the
 * rest of this module can treat the leading path segment after it as the language.
 */
function normalizeBasePath(basePath: string, knownCodes: ReadonlySet<string>): string {
	const segments = trimSlashes(basePath).split("/").filter(Boolean);
	const last = segments[segments.length - 1];
	if (last && knownCodes.has(urlSegmentToCode(last))) {
		segments.pop();
	}
	return segments.join("/");
}

/**
 * Return the path segments that live AFTER `basePath` in `pathname`.
 * Both are compared with leading/trailing slashes normalized.
 */
function segmentsAfterBase(pathname: string, basePath: string): string[] {
	const base = trimSlashes(basePath);
	const trimmedPath = trimSlashes(pathname);

	let rest = trimmedPath;
	if (base && (trimmedPath === base || trimmedPath.startsWith(`${base}/`))) {
		rest = trimmedPath.slice(base.length);
	}
	return trimSlashes(rest).split("/").filter(Boolean);
}

/**
 * Read the language encoded in a URL: the first path segment after `basePath`,
 * remapped from its URL form (hyphens) back to a locale code (underscores) and
 * returned only when it is one of `knownCodes`. Returns `undefined` when the
 * leading segment is absent or is not a known language code.
 *
 * @param currentUrl Absolute URL to inspect (e.g. `window.location.href`).
 * @param basePath   Site root path (e.g. `SFDC_ENV.basePath`); may be `""`.
 * @param knownCodes Language codes considered valid leading segments.
 * @returns The matched locale code (e.g. `en_US`), or `undefined`.
 */
export function getLanguageFromUrl(
	currentUrl: string,
	basePath: string,
	knownCodes: ReadonlySet<string>,
): string | undefined {
	const { pathname } = new URL(currentUrl);
	const siteRoot = normalizeBasePath(basePath, knownCodes);
	const [first] = segmentsAfterBase(pathname, siteRoot);
	if (!first) {
		return undefined;
	}
	const code = urlSegmentToCode(first);
	return knownCodes.has(code) ? code : undefined;
}

/**
 * Rewrite `currentUrl` so `language` is reflected in the first path segment after
 * `basePath`. The rest of the path, the query string, and the hash are preserved.
 *
 * The leading segment after `basePath` is examined and remapped from its URL form
 * (hyphens) back to a locale code before being compared against `knownCodes`:
 *
 * - **Default language** (`language === defaultLanguage`): the default is the
 *   implicit, un-prefixed language, so NO segment is written. An existing
 *   known-language leading segment is REMOVED (`/shop/fr/page` → `/shop/page`);
 *   if there is none, the path is left unchanged.
 * - **Non-default language**: an existing known-language leading segment is
 *   REPLACED — so switching never stacks segments (`/en-US/fr/page`) — otherwise
 *   the language is INSERTED as a new first segment. The written segment uses the
 *   URL form of the code (underscores → hyphens, e.g. `en_US` → `en-US`).
 *
 * When a non-default language is active the platform folds that language into
 * `basePath` itself (`/shop` → `/shop/fr`); a trailing known-language segment is
 * stripped from `basePath` first (see {@link normalizeBasePath}) so the leading
 * segment after the true site root is always what gets replaced/removed/inserted.
 *
 * `basePath` is matched with trailing slashes normalized, and the result never
 * contains double slashes.
 *
 * @param currentUrl      Absolute URL to rewrite (e.g. `window.location.href`).
 * @param basePath        Site root path (e.g. `SFDC_ENV.basePath`); may be `""`.
 * @param language        Locale code to reflect after `basePath` (e.g. `en_US`).
 * @param knownCodes      Language codes eligible for the leading-segment check.
 * @param defaultLanguage Locale code that is served without a URL segment.
 * @returns The rewritten absolute URL as a string.
 */
export function buildLanguageUrl(
	currentUrl: string,
	basePath: string,
	language: string,
	knownCodes: ReadonlySet<string>,
	defaultLanguage: string,
): string {
	const url = new URL(currentUrl);

	const base = normalizeBasePath(basePath, knownCodes);
	const segments = segmentsAfterBase(url.pathname, base);
	const leadingIsLanguage = segments.length > 0 && knownCodes.has(urlSegmentToCode(segments[0]));

	if (language === defaultLanguage) {
		// The default language is served un-prefixed. Drop an existing language
		// segment so switching back to default removes it, rather than writing one.
		if (leadingIsLanguage) {
			segments.shift();
		}
	} else if (leadingIsLanguage) {
		segments[0] = codeToUrlSegment(language);
	} else {
		segments.unshift(codeToUrlSegment(language));
	}

	const rebuiltPath = [base, ...segments].filter(Boolean).join("/");
	url.pathname = `/${rebuiltPath}`;

	return url.toString();
}
