#set document(title: "Private Local Font Workflow")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Private local font workflow

This source deliberately uses Typst's built-in New Computer Modern so it
compiles everywhere. Use it as a safe starting point for testing a font stored
outside the operating system's installed-font directories.

== Configure a private directory

1. Open *Settings* and add a private local font directory.
2. Open *Document Typography* from the `Aa` toolbar.
3. Inspect the font groups in order: Typst built-in, private local, and system.
4. Replace New Computer Modern with a private family available on this machine.
5. Apply the typography block and recompile.

Typsastra passes private font directories to diagnostics, preview, source
mapping, and PDF export. The absolute directory remains a global machine-local
setting; it is never written into this source or `.typsastra`.

== Fallback and scaling

Document Typography emits an ordinary ordered Typst font tuple. Reorder rows
when overlapping glyph coverage changes which family Typst selects. The first
family containing a character wins, including shared digits and punctuation.

Scale controls are intended for small optical adjustments. Values beyond
plus or minus ten percent show a warning, and non-unit scales remain
experimental for PDF output. Typst built-in fonts cannot be scaled because
Typsastra has no local font file from which to generate a variant.

== Portability boundary

Project export contains source and portable project settings, not private font
binaries, generated scale variants, PDFs, or caches. Another author must
install or privately configure the same family before expecting equivalent
layout.
