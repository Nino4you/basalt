# Interface languages

Basalt defaults to **English**. Select **Deutsch** or **English** under
Settings → General → Language. The choice is stored in `basalt-settings`.
Missing, corrupt or unsupported preferences fall back to English.

Changing language saves open note and plugin buffers before reloading the UI.
If saving fails (for example because of a version conflict), the app stays open
in its current language and keeps the draft. A failed settings write also stops
the reload. The reload initializes all host labels and plugin language detection
consistently; `document.documentElement.lang`, `getLanguage()` and the compatibility
Moment locale report the same language.

The layer translates host UI text, not vault data. Existing filenames, note
contents, demo notes in `src/backend.ts` and `examples/demo-vault/`, and text supplied
by third-party plugins remain unchanged. Native backend diagnostics may still be
reported in their original language.

## Adding messages and languages

`src/i18n/en.ts` contains the English catalog keyed by German source messages.
The source message is the fallback for an untranslated key. Keep keys stable;
changing one requires updating its callers and translations.

Use `t("Einstellungen")` for plain messages, and named placeholders for values:

```ts
t("{name} öffnen", { name: filename });
t("Seite {page} von {total}", { page: 2, total: 10 });
plural(count, { one: "{count} Wort", other: "{count} Wörter" });
```

Keys and placeholder names are checked by TypeScript. Numbers use `Intl.NumberFormat`;
plural forms use `Intl.PluralRules`. Additional `zero`, `two`, `few` and `many` forms
are supported. For a language needing more forms, add the corresponding message keys
and supply those forms at its call sites. Dates and sorting use `getLocale()`.
Messages return plain text: put them into `textContent` or `h()` text properties.
Escape them when constructing HTML. Never interpolate a translated message as code.

To add a language, add its ID and native name to `languages` in `src/i18n/index.ts`,
create a catalog satisfying `Catalog`, and register it in `catalogs`. Omitted keys
fall back to their German source. Preserve placeholder names in every translation.

## Tests

Existing unit and browser suites explicitly select German, preserving their label
and demo-content assertions. Unit startup tests and `tests/e2e/i18n.spec.ts` exercise
the English default, persisted preferences, round-trip switching and conflict handling.
The Android smoke tool selects German in the WebView before using its German locators.
