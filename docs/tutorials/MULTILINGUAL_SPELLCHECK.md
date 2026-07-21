# Multilingual spellcheck and completion

## Assign a language to each document script

1. Open the `Aa` Typography toolbar.
2. Add every script used by the document.
3. Choose a font for each script.
4. Choose a language-tools provider, or leave **Language tools off**.
5. Apply the configuration to the main document.

For an English, Khmer, and Arabic document, choose English for Latin, Khmer for
Khmer, and Arabic for Arabic. Typsastra writes these choices into the
`typsastra:document-scripts` directive. Spellcheck and completion then use the
same assignment.

Text in an undeclared script is left alone. Typsastra does not show warnings or
guess a provider for it. If a selected provider is unavailable, install it from
Settings and return to the Typography toolbar.

## Same-script languages

English, French, and Spanish all use Latin. A document-script entry can select
only one of them at a time. Choosing French means English is not used as a
fallback, even if the English provider is installed. Change the Latin language
when you intentionally want to review the document with another dictionary.

Typst `lang` still controls Typst behavior such as hyphenation. It does not
change Typsastra's provider selection.

## Terminology

Use the spelling context menu to accept a product or proper name globally, for
the project, or for the configured language family. Project terminology is
stored in `.typsastra/config.json`.

Try `02-multilingual-writing/02-language-scoped-spellcheck` and
`04-research-projects/01-multilingual-article`.
