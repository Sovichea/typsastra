#set page(paper: "a4")
#set text(font: ("Linux Libertine", "New Computer Modern"), size: 10pt)
#for page in range(30) [
  = Benchmark page #(page + 1)

  Latin research text and Khmer អត្ថបទស្រាវជ្រាវ are intentionally mixed.

  #lorem(250)
  #if page < 29 { pagebreak() }
]
