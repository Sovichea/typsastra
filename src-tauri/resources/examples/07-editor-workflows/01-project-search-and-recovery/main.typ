#set document(title: "Reading the Forest Canopy", author: "Typsastra Examples")
#set page(paper: "a4", margin: 22mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")
#set par(justify: true)

= Reading the forest canopy <top>

This field notebook is a small, self-contained project for testing project-wide
search, reviewed replacement, unsaved-work recovery, and shared source
navigation. It uses three ordinary Typst files and no external packages.

#block(
  fill: luma(244),
  inset: 12pt,
  radius: 2pt,
  width: 100%,
)[
  *Start with search.* Open project search with `Ctrl+Shift+F`
  (`Cmd+Shift+F` on macOS) and search for `canopy`. The term appears in this
  file and in both included chapters. Use the replace field in the same panel
  to review `canopy` to `forest canopy` without writing the source until you
  apply the batch.
]

== Notebook contents

- `chapters/01-observations.typ` records morning light and leaf-area notes.
- `chapters/02-methods.typ` describes the measurement and review routine.

#include "chapters/01-observations.typ"
#include "chapters/02-methods.typ"

== Working notes

The first canopy measurements are deliberately uneven. That makes the review
step useful: keep the observations that describe a specific layer, and rewrite
the general references consistently.

#block(
  stroke: 0.6pt + luma(170),
  inset: 10pt,
  radius: 2pt,
)[
  *Navigation exercise.* Open an included chapter, then check the Outline. It
  still follows this main document, with the active chapter's headings
  emphasized. Use the tab list to return here, or `Alt+Left` and `Alt+Right` to
  retrace source jumps from search and the outline.
]

The remaining pages are intentionally short so the example compiles quickly and
stays easy to edit while you review replacements.
