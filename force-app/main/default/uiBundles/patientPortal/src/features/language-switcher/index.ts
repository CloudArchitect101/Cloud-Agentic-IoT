/**
 * Copyright (c) 2026, Salesforce, Inc.,
 * All rights reserved.
 * For full license text, see the LICENSE.txt file
 */

/**
 * Public API for the language switcher feature.
 *
 * Most apps only need:
 *   ```tsx
 *   import { LanguageSwitcher } from ".../features/language-switcher";
 *   <LanguageSwitcher />
 *   ```
 *
 * Lower-level pieces are exported for custom UIs and testing:
 *   - {@link getCurrentLanguage} to read the active language
 *   - {@link buildLanguageUrl} to compute the rewritten URL yourself
 *   - {@link LANGUAGES} / {@link DEFAULT_LANGUAGE} for the supported set
 */

export { LanguageSwitcher, getCurrentLanguage } from "./LanguageSwitcher";
export type { LanguageSwitcherProps } from "./LanguageSwitcher";

export { buildLanguageUrl, getLanguageFromUrl } from "./buildLanguageUrl";

export { LANGUAGES, DEFAULT_LANGUAGE, LANGUAGE_CODES } from "./languages";
export type { LanguageOption } from "./languages";
