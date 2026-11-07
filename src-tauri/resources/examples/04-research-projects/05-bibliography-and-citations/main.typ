// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set document(title: "Bibliography and citations")
#set page(margin: 22mm)
#set text(size: 10.5pt)
#set par(justify: true, leading: 0.72em)
#set heading(numbering: "1.")

= Bibliography and citations

This example demonstrates a local BibTeX bibliography, citations, and
cross-references in a small multi-file project. Every reference is stored in
`refs.bib` and the document compiles without network access.

#include "chapters/01-references.typ"

#bibliography("refs.bib", style: "apa")
