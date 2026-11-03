# Multiscript font fallback

This example demonstrates ordinary Typst fallback order, why overlapping glyph
coverage matters, and how Typsastra adds independent optical scaling without
rewriting document content.

## Try it

1. Open **Document Typography** from the `Aa` toolbar button.
2. Reorder Latin, Khmer, and Arabic and observe which font owns overlapping
   Latin glyphs, digits, and punctuation.
3. Change local Khmer or Arabic font scales by a small amount.
4. Apply the configuration and test forward and inverse sync.
5. Export the PDF and compare it with preview. Non-`1.0` scales are
   experimental because Typst may normalize generated fonts during PDF
   subsetting; use `1.0` for dependable PDF output.

Typsastra intentionally generates a simple ordered font tuple. It does not
emit script-coverage regular expressions or a shared-mark override.

Tutorial: <https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/DOCUMENT_TYPOGRAPHY.md>
