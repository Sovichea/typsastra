# Multilingual spellcheck and completion

## Configure document languages

1. Install optional providers from **Settings → Editor → Language providers**.
2. Open a Typst document and select the language item in the status bar.
3. In **Document Languages**, choose a language for each listed script.
4. Select **Apply**.

The dialog lists only scripts that have multiple possible languages. Latin may
need an English, French, Spanish, or another configured choice. Khmer is not
listed because `Khmr` has one available language and resolves automatically.
Move the caret between scripts to see the current pair in real time.

Assignments apply to the whole project and travel in
`.typsastra/config.json`. They are independent from Document Typography and are
not written into Typst source.

If a selected provider is unavailable, the selection is retained but receives
no spellcheck or completion until that provider is installed. Typsastra never
falls through to another language that uses the same script.

## Same-script languages

English, French, and Spanish all use Latin. A project can select only one of
them for `Latn` at a time. Choosing French means English is not used as a
fallback, even if the English provider is installed. Change the Latin language
when you intentionally want to review the document with another dictionary.

Typst `lang` still controls Typst behavior such as hyphenation. It does not
change Typsastra's provider selection. The operating-system keyboard layout and
IME candidates are also independent.

Typsastra scans proven Typst prose before requesting analysis. The native
registry loads only the provider for a detected, resolved language; Typst code
syntax does not activate a dictionary.

## Terminology

Use the spelling context menu to accept a product or proper name globally, for
the project, or for the configured language family. Project terminology is
stored in `.typsastra/config.json`.

Try `02-multilingual-writing/02-language-scoped-spellcheck` and
`04-research-projects/01-multilingual-article`.
