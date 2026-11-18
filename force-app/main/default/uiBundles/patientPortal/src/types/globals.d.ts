/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/**
 * Ambient augmentation of the runtime environment on {@link globalThis.SFDC_ENV}.
 *
 * The platform's `SfdcEnv` (see `@salesforce/platform-sdk`) does not yet declare
 * a `language` field. The language switcher reads the active language from it, so
 * we augment the interface with an optional `language` here. Because declared
 * interfaces merge, this only ADDS `language` — it does not redeclare `basePath`
 * or the other platform-owned fields.
 *
 * Expected value: the page locale in hyphenated form, e.g. `"en-US"` — the
 * platform converts the underscore locale code (`en_US`) to dashes before
 * injecting it into `SFDC_ENV`.
 */
interface SfdcEnv {
	/** Current page language in hyphenated form, e.g. "en-US". */
	language?: string;
}
