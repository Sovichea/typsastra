#set document(title: "Multiscript Font Fallback")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1},{"family":"MiSans Arabic","script":"arabic","scale":1}]
#set text(
  font: (
    "New Computer Modern",
    "MiSans Khmer",
    "MiSans Arabic",
  ),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")
#set text(lang: "en")

= Multiscript font fallback

Typst applies one size to every family in a normal font fallback stack. Fonts
for different scripts may therefore look unbalanced at the same point size.

A second problem appears when a script font includes extra glyphs. MiSans Khmer
contains Latin characters, so placing it first in an unrestricted stack can
prevent New Computer Modern from being used.

== Typsastra's solution

Document Typography records a preferred font and optional scale for each
script. The rows produce the same ordered fallback stack you would write in
Typst, and Typst still chooses the first family containing each glyph. This
example puts Latin first, followed by Khmer and Arabic:

```typ
font: ("New Computer Modern", "MiSans Khmer", "MiSans Arabic")
```

If a font contains glyphs for several scripts, fallback order remains important.

For a Khmer-dominant document, putting Khmer first gives punctuation and
Western digits to the Khmer font. However, MiSans Khmer also contains Latin
glyphs, so embedded English may never reach New Computer Modern. Putting Latin
first fixes English but gives those shared characters to the Latin font.

Typsastra 0.6 uses ordinary Typst fallback order. Choose the order that best
matches the document's dominant typography. Script-specific font enforcement
is intentionally deferred until its behavior for shared digits, punctuation,
and inherited marks can be made predictable.

== Independent visual scaling

Open the `Aa` toolbar control and try these values:

```text
Khmer  MiSans Khmer        0.95×
Latin  New Computer Modern 1.00× (Typst built-in)
Arabic MiSans Arabic       1.00×
```

The Latin scale is locked because New Computer Modern is supplied internally
by Typst. Install a local copy if you need to create scaled variants of it.

Typsastra prepares uniformly scaled local fonts without wrapping or replacing
source runs. Forward and inverse synchronization therefore retain the original
source ownership.

Scaled variants are stored in Typsastra's private global cache. A matching font
and scale is reused across projects, so it is not generated again. Typsastra
recommends at most 10 cached scale variants per font face and asks before
creating another. Existing variants are never removed automatically.

Non-unit scales are experimental for PDF output. Typst may normalize a scaled
font while subsetting it, leaving scaled advances with unscaled outlines.
Typsastra keeps preview faithful to the exported PDF; use `1.0` when dependable
PDF output is required.

== Example scripts

Latin uses its assigned family: Multilingual documents should remain readable.

#text(lang: "km")[ខ្មែរប្រើពុម្ពអក្សរដែលបានកំណត់សម្រាប់អក្សរខ្មែរ។]

#text(lang: "ar", dir: rtl)[يستخدم النص العربي الخط المخصص للكتابة العربية.]

== Important boundaries

Script-font assignments do not control the source-editor font, spellcheck,
completion, Typst `lang`, or text direction. Generated scaled fonts stay in
Typsastra's private global cache and never enter `.typsastra`, a copied project,
or its exports. Advanced cache management is planned for a future update.
