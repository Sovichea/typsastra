#set page(paper: "a4")
#set text(font: ("Linux Libertine", "New Computer Modern"), size: 10pt)
#for page in range(100) [
  = Virtualization page #(page + 1)

  This page is deterministic and exercises long-document PDF geometry. ភាសាខ្មែរនិង Latin remain mixed.

  #lorem(250)
  #if page < 99 { pagebreak() }
]
