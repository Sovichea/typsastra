# Private local fonts

This example documents the private-font workflow while remaining portable and
compilable without an external font.

Supported private desktop font containers are TTF, OTF, TTC, and OTC. WOFF and
WOFF2 are web-font formats and are ignored. Variable TTF or OTF fonts are
available at `1.0x`, without arbitrary variation-axis controls.

Typsastra never copies private fonts into `.typsastra`, project exports, or
generated preview assets. Test with a font whose license permits your intended
use, and remember that a recipient needs the same dependency.

Tutorial: <https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/DOCUMENT_TYPOGRAPHY.md>
