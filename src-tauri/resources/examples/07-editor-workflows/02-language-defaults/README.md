# Document language defaults

This example shows the difference between project language assignments and the
global defaults used by new projects. It contains English, Khmer, French, and
Arabic samples, but compiles without optional dictionaries or fonts.

## Project assignments

1. Open `main.typ` and set it as the main file.
2. Open the `Aa` Typography toolbar.
3. Assign English (United States) to Latin. Khmer and Arabic start without a
   provider.
4. Assign Khmer to Khmer and review the Khmer paragraph.
5. Change Latin to French and confirm that the provider changes with the
   project assignment. English is never used as a hidden same-script fallback.
6. Set one script's language tools off and confirm that Typsastra stops
   reviewing and completing that script without changing its font.

The assignments are written to `.typsastra/config.json` for this project.

## Global defaults

1. Open **Settings → Language**.
2. Find **Default document languages**.
3. Change the Latin assignment, for example to French.
4. Create a blank project and inspect its `Aa` toolbar. The new project inherits
   the global default.
5. Reopen this example. Its existing assignments are unchanged.
6. Return the global default to English (United States) when you are done.

Interface localization and document-language defaults are separate. The
interface language changes Typsastra's own labels; default document languages
only seed new projects.

Typst's `lang` parameter remains independent from Typsastra provider routing.
Use `#set text(lang: ...)` or `#text(lang: ...)` for Typst hyphenation and
language behavior, and use the `Aa` toolbar for spellcheck and completion.

Tutorial: <https://docs.typsastra.com/tutorials/MULTILINGUAL_SPELLCHECK/>
