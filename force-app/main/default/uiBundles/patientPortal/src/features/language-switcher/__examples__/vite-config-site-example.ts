/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/**
 * Example: switching your app's `vite.config.ts` to the SITE entry of
 * `@salesforce/vite-plugin-ui-bundle` so language switching works in local dev.
 *
 * This file is illustrative — it is copied into the app as an example, not used
 * directly. Apply the two changes below to your real `vite.config.ts`.
 *
 * WHY: On a deployed Experience site the platform injects `SFDC_ENV.language`
 * and folds the active language into `SFDC_ENV.basePath` (e.g. `/shop/fr`),
 * recomputed from the URL on every load. The generic local Vite dev server does
 * neither — `SFDC_ENV.language` is absent and `basePath` is always `/` — so the
 * switcher can't route a non-default language locally (the reload 404s and the
 * labels never flip). The SITE entry mirrors production for local dev only.
 *
 * HOW: change the import from the generic plugin to the `/site` subpath, and
 * pass the feature's supported `LANGUAGES` (the single source of truth). The
 * plugin needs the language CODES, so map the `{ code, label }` list to codes.
 * The FIRST entry is the default, served un-prefixed at `/` — matching
 * `DEFAULT_LANGUAGE` in `languages.ts`.
 *
 * This has NO effect on a deployed build; non-site bundles keep the generic
 * `@salesforce/vite-plugin-ui-bundle` import unchanged.
 */

// 1. Replace the generic plugin import:
//      import salesforce from "@salesforce/vite-plugin-ui-bundle";
//    with the site entry + the feature's language list:
import siteUiBundlePlugin from "@salesforce/vite-plugin-ui-bundle/site";
import { LANGUAGES } from "../languages";

// 2. In your `defineConfig({ plugins: [...] })`, replace the `salesforce()`
//    call with `siteUiBundlePlugin(...)`, passing the language codes:
export const examplePlugins = [
	// tailwindcss(),
	// react(),
	siteUiBundlePlugin({ languages: LANGUAGES.map((l) => l.code) }),
	// ...codegen
];
