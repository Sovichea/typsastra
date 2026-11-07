= Reading the references <sec:references>

A bibliography is a project-level resource. Entries in `refs.bib` can be cited
from any included chapter with Typst's `@key` syntax. The layout background is
described in @typst2024, and this project is documented in @typsastra2026.

The citation map in @tab:citation-map shows which references support this
example. The heading above is referenced as @sec:references.

#figure(
  table(
    columns: 2,
    inset: 6pt,
    stroke: 0.5pt + luma(180),
    table.header([Reference], [Used for]),
    [@typst2024], [Typst layout background],
    [@typsastra2026], [This project],
    [@research2025], [Portable research workflows],
  ),
  caption: [References used by this example.],
) <tab:citation-map>
