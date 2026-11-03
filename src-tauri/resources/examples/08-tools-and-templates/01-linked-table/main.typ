#set document(title: "Linked Table Exercise", author: "Typsastra Examples")
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

= Linked table exercise

This page contains a managed table block. Table Tools owns the table model and
rewrites the generated block between the markers, while the surrounding document
remains ordinary Typst source.

== Sample results

//@table:basic_table
//@generated-table-start
#table(
  columns: 3,
  stroke: 0.5pt + rgb("#000000"),
  table.header([Name], [Score], [Grade]),
  [Ada], [95], [A],
  [Linus], [88], [B+],
  [Grace], [92], [A-],
)
//@generated-table-end

Open **Table Tools** in the sidebar and create the **Basic table** sample. Its
id is `basic_table`, so it links to the anchor above. Edit a cell and watch this
block and the preview update together.

== Link another table

Create a second table in Table Tools, then type `//@table:` at the insertion
point and choose the table from completion. The tool inserts the anchor and a
managed block. Removing a table model flags its anchors in the editor gutter,
where the table can be recreated from the generated source or unlinked while
keeping the source.

== Template workflow

Project creation is separate from table linking. Use **Create New Project** to
browse Typst Universe, downloaded, and user templates, or start from a blank
project. Tables and other project-owned state remain portable project metadata;
generated caches, fonts, and PDFs do not.
