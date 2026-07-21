# Document-script language tools example

This example demonstrates the `typsastra:document-scripts` directive.

1. Open the `Aa` Typography toolbar.
2. Inspect the language assigned to Latin, Khmer, and Arabic.
3. Install the optional Arabic provider if it is unavailable.
4. Turn one script's language tools off and confirm that Typsastra no longer
   spellchecks or completes that script.
5. Select French for Latin to review French; English is never used as a hidden
   same-script fallback.

Typst `lang` continues to control Typst behavior, not Typsastra provider routing.

Tutorial: <https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/MULTILINGUAL_SPELLCHECK.md>
