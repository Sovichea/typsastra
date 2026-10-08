#set page(paper: "a4", margin: 22pt)
#set text(size: 10pt)
#set par(leading: 0.72em)

= A field guide to thoughtful research

This small project is the companion to the Typsastra feature guides. It combines
an ordinary Typst main document, included chapters, local images, and a Table
Tools anchor. Explore the project in the editor while watching the preview.

#align(center)[
  #image("assets/typsastra-wordmark.png", width: 58%)
]

#figure(
  image("assets/typsastra-icon.png", width: 3cm),
  caption: [A local project image, available to Image Tools.],
)

== Contents

- A portable project with included chapter files.
- Images that are referenced by the main document.
- A table anchor that can be connected to a Table Tools sample.
- A short multilingual excerpt for script-aware editing.

#include "chapters/01-workflow.typ"
#include "chapters/02-language.typ"
#include "chapters/03-media-and-data.typ"

== Research summary

The project files remain regular, portable Typst source. Typsastra keeps the
configured main document's preview active when an included chapter is opened.

//@table:basic_table
//@generated-table-start
#table(
  columns: 3,
  stroke: 0.5pt + rgb("#000000"),
  table.header([Name], [Score], [Grade]),
  [Typsastra], [95], [A],
  [Linus], [88], [B+],
  [Grace], [92], [A-],
)
//@generated-table-end
