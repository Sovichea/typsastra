= References and citations <sec:references>

Typsastra projects can keep bibliography data in a local `.bib` file and cite
entries from any included chapter. The layout background is described in
@typst2024, and the project itself is documented in @typsastra2026.

== Why citations matter <why-citations>

A research document is larger than its currently open source file. Citations
connect prose to a bibliography without turning the project into a database
application. The bibliography remains ordinary Typst source and the `.bib` file
remains portable.

== A citation map <citation-map>

#figure(
  table(
    columns: 2,
    inset: 6pt,
    stroke: 0.5pt + luma(180),
    table.header([Reference], [Topic]),
    [@typst2024], [Typst layout],
    [@research2025], [Portable research workflows],
    [@typsastra2026], [This project],
  ),
  caption: [Bibliography entries used by this chapter.],
) <tab:citation-map>

The table in @tab:citation-map and the discussion in *Why citations matter* are
cross-referenced from the text. The full bibliography appears at the end of the
main document.
